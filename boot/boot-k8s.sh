#!/usr/bin/env bash
# =============================================================================
# k8s Boot Script — Externalized from UserData
#
# All heavy bootstrap logic lives here (downloaded from S3 at boot time)
# to keep the EC2 LaunchTemplate user data under CloudFormation's 16KB limit.
#
# Expected environment variables (set by inline user data):
#   VOLUME_ID        — EBS volume ID to attach
#   MOUNT_POINT      — Mount point for EBS (default: /data)
#   DEVICE_NAME      — EBS device name (default: /dev/xvdf)
#   FS_TYPE          — Filesystem type (default: xfs)
#   STACK_NAME       — CloudFormation stack name (for cfn-signal)
#   ASG_LOGICAL_ID   — ASG logical ID (for cfn-signal)
#   K8S_VERSION      — Kubernetes version
#   DATA_DIR         — kubeadm data directory (default: /data/kubernetes)
#   POD_CIDR         — Pod network CIDR (default: 192.168.0.0/16)
#   SERVICE_CIDR     — Service subnet CIDR (default: 10.96.0.0/12)
#   SSM_PREFIX       — SSM parameter prefix (e.g. /k8s/development)
#   S3_BUCKET        — S3 bucket name for k8s manifests
#   CALICO_VERSION   — Calico CNI version (default: v3.29.3)
#   LOG_GROUP_NAME   — CloudWatch log group for boot log streaming
#   AWS_REGION       — AWS region
#   EIP_ALLOC_ID     — Elastic IP allocation ID (for aws ec2 associate-address)
# =============================================================================

set -euxo pipefail

# =============================================================================
# Trap: send FAILURE signal on unexpected exit
#
# If the script exits non-zero before reaching completion,
# CloudFormation learns immediately instead of waiting for the full
# signalsTimeoutMinutes to elapse.
# =============================================================================
send_failure_signal() {
    local EXIT_CODE=$?
    if [ "$EXIT_CODE" -ne 0 ]; then
        echo ""
        echo "=== FATAL: boot-k8s.sh exited with code $EXIT_CODE ==="
        echo "Sending FAILURE signal to CloudFormation..."

        # cfn-bootstrap is pre-installed in the Golden AMI
        /opt/aws/bin/cfn-signal --success false \
            --stack "${STACK_NAME}" \
            --resource "${ASG_LOGICAL_ID}" \
            --region "${AWS_REGION}" \
            --reason "boot-k8s.sh failed with exit code $EXIT_CODE" \
            2>/dev/null || echo "WARNING: cfn-signal --success false also failed"
    fi
}
trap send_failure_signal EXIT

# Defaults
MOUNT_POINT="${MOUNT_POINT:-/data}"
DEVICE_NAME="${DEVICE_NAME:-/dev/xvdf}"
FS_TYPE="${FS_TYPE:-xfs}"
K8S_VERSION="${K8S_VERSION:-1.35.1}"
DATA_DIR="${DATA_DIR:-/data/kubernetes}"
POD_CIDR="${POD_CIDR:-192.168.0.0/16}"
SERVICE_CIDR="${SERVICE_CIDR:-10.96.0.0/12}"
SSM_PREFIX="${SSM_PREFIX:-/k8s/development}"
CALICO_VERSION="${CALICO_VERSION:-v3.29.3}"
AWS_REGION="${AWS_REGION:-eu-west-1}"
LOG_GROUP_NAME="${LOG_GROUP_NAME:-/ec2/monitoring-k8s/instances}"

# =============================================================================
# 0. Start CloudWatch Agent (FIRST — streams logs from this point onward)
#
# The Golden AMI bakes the agent + config with placeholder __LOG_GROUP_NAME__.
# We patch the config with the real log group name and start the agent BEFORE
# any other work, so if the instance crashes mid-boot, we still have logs up
# until the exact millisecond it died.
# =============================================================================

CW_CONFIG="/opt/aws/amazon-cloudwatch-agent/etc/boot-logs.json"

if [ -f "$CW_CONFIG" ]; then
    echo "=== Starting CloudWatch Agent ==="
    # Patch placeholder with actual log group name
    sed -i "s|__LOG_GROUP_NAME__|${LOG_GROUP_NAME}|g" "$CW_CONFIG"

    /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
        -a fetch-config -m ec2 -s -c "file:${CW_CONFIG}" || \
        echo "WARNING: CloudWatch Agent failed to start — boot continues without log streaming"
    echo "CloudWatch Agent started — streaming boot logs to ${LOG_GROUP_NAME}"
else
    echo "WARNING: CloudWatch Agent config not found at ${CW_CONFIG} — boot logs NOT streamed"
fi

# =============================================================================
# 1. Attach and Mount EBS Volume
# =============================================================================

echo "=== Attaching EBS volume ==="

# Get instance metadata using IMDSv2
IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")

INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
  http://169.254.169.254/latest/meta-data/instance-id)
REGION=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
  http://169.254.169.254/latest/meta-data/placement/region)
AZ=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
  http://169.254.169.254/latest/meta-data/placement/availability-zone)

if [ -z "$INSTANCE_ID" ] || [ -z "$REGION" ]; then
    echo "ERROR: Failed to retrieve instance metadata via IMDSv2"
    echo "INSTANCE_ID='$INSTANCE_ID' REGION='$REGION'"
    exit 1
fi

echo "Instance: $INSTANCE_ID, Region: $REGION, AZ: $AZ"
echo "Volume ID: $VOLUME_ID"

# Wait for volume to become available
EBS_MAX_WAIT=300
EBS_FORCE_DETACH_AFTER=120
EBS_POLL_INTERVAL=10
EBS_WAITED=0
EBS_FORCE_DETACHED=false

while true; do
    VOLUME_STATE=$(aws ec2 describe-volumes --volume-ids $VOLUME_ID \
        --query "Volumes[0].State" --output text --region $REGION 2>/dev/null || echo "not-found")
    echo "Volume state: $VOLUME_STATE (waited ${EBS_WAITED}s / ${EBS_MAX_WAIT}s)"

    if [ "$VOLUME_STATE" = "available" ]; then
        echo "Attaching volume $VOLUME_ID to $INSTANCE_ID as ${DEVICE_NAME}..."
        aws ec2 attach-volume --volume-id $VOLUME_ID --instance-id $INSTANCE_ID \
            --device ${DEVICE_NAME} --region $REGION
        echo "Waiting for volume to attach..."
        aws ec2 wait volume-in-use --volume-ids $VOLUME_ID --region $REGION
        sleep 5
        echo "Volume attached successfully"
        break

    elif [ "$VOLUME_STATE" = "in-use" ]; then
        ATTACHED_INSTANCE=$(aws ec2 describe-volumes --volume-ids $VOLUME_ID \
            --query "Volumes[0].Attachments[0].InstanceId" --output text --region $REGION)
        if [ "$ATTACHED_INSTANCE" = "$INSTANCE_ID" ]; then
            echo "Volume is already attached to this instance"
            break
        fi
        if [ $EBS_WAITED -ge $EBS_FORCE_DETACH_AFTER ] && [ "$EBS_FORCE_DETACHED" = "false" ]; then
            echo "WARNING: Volume still attached to $ATTACHED_INSTANCE after ${EBS_FORCE_DETACH_AFTER}s. Force-detaching..."
            aws ec2 detach-volume --volume-id $VOLUME_ID --instance-id $ATTACHED_INSTANCE --force --region $REGION || true
            EBS_FORCE_DETACHED=true
        else
            echo "Volume attached to $ATTACHED_INSTANCE (terminating). Waiting for detach..."
        fi

    elif [ "$VOLUME_STATE" = "detaching" ]; then
        echo "Volume is detaching from old instance. Waiting..."
    else
        echo "ERROR: Volume not found or in unexpected state: $VOLUME_STATE"
        exit 1
    fi

    if [ $EBS_WAITED -ge $EBS_MAX_WAIT ]; then
        echo "ERROR: Volume did not become available after ${EBS_MAX_WAIT}s"
        exit 1
    fi

    sleep $EBS_POLL_INTERVAL
    EBS_WAITED=$((EBS_WAITED + EBS_POLL_INTERVAL))
done

# Wait for device to appear (NVMe remapping)
DEVICE="${DEVICE_NAME}"
NVME_DEVICE=""

for i in {1..30}; do
    if [ -b "$DEVICE" ]; then
        echo "Device $DEVICE is ready"
        break
    fi

    for nvme_dev in /dev/nvme*n1; do
        [ -b "$nvme_dev" ] || continue
        MAPPED_VOL=$(ebsnvme-id -v "$nvme_dev" 2>/dev/null || echo "")
        if [ "$MAPPED_VOL" = "$VOLUME_ID" ]; then
            echo "Found NVMe device via ebsnvme-id: $nvme_dev -> $VOLUME_ID"
            NVME_DEVICE="$nvme_dev"
            break
        fi
    done

    if [ -n "$NVME_DEVICE" ] && [ -b "$NVME_DEVICE" ]; then
        DEVICE="$NVME_DEVICE"
        break
    fi

    echo "Waiting for device... ($i/30)"
    sleep 2
done

if [ ! -b "$DEVICE" ]; then
    echo "ERROR: Device $DEVICE not found after 60 seconds"
    exit 1
fi

FSTYPE=$(blkid -o value -s TYPE $DEVICE 2>/dev/null || echo "")
if [ -z "$FSTYPE" ]; then
    echo "No filesystem found, creating ${FS_TYPE} filesystem..."
    mkfs.${FS_TYPE} $DEVICE
fi

mkdir -p ${MOUNT_POINT}
echo "Mounting $DEVICE to ${MOUNT_POINT}..."
mount $DEVICE ${MOUNT_POINT}

if ! grep -q "${MOUNT_POINT}" /etc/fstab; then
    echo "$DEVICE ${MOUNT_POINT} ${FS_TYPE} defaults,nofail 0 2" >> /etc/fstab
    echo "Added mount to /etc/fstab"
fi

chown -R ec2-user:ec2-user ${MOUNT_POINT}
echo "EBS volume mounted at ${MOUNT_POINT}"

# =============================================================================
# 1.5 Associate Elastic IP
#
# Binds the pre-allocated EIP to this instance so that:
#   - CloudFront origin hostname stays stable across instance replacements
#   - SSM `elastic-ip` parameter matches the actual public IP
# EIP_ALLOC_ID is set by CDK user-data from baseStack.elasticIp.attrAllocationId
# =============================================================================

if [ -n "${EIP_ALLOC_ID:-}" ]; then
    echo "=== Associating Elastic IP ==="
    echo "EIP Allocation ID: $EIP_ALLOC_ID"
    echo "Instance ID: $INSTANCE_ID"

    # Retry loop — EIP may be briefly in use if old instance is terminating
    EIP_MAX_RETRIES=12
    EIP_RETRY_INTERVAL=10

    for i in $(seq 1 $EIP_MAX_RETRIES); do
        if aws ec2 associate-address \
            --allocation-id "$EIP_ALLOC_ID" \
            --instance-id "$INSTANCE_ID" \
            --allow-reassociation \
            --region "$REGION" 2>&1; then
            echo "✓ Elastic IP associated successfully (attempt $i/$EIP_MAX_RETRIES)"
            break
        fi
        if [ $i -eq $EIP_MAX_RETRIES ]; then
            echo "ERROR: Failed to associate EIP after $EIP_MAX_RETRIES attempts"
            echo "Instance will use ephemeral public IP — CloudFront origin will be incorrect"
        else
            echo "EIP association failed (attempt $i/$EIP_MAX_RETRIES). Retrying in ${EIP_RETRY_INTERVAL}s..."
            sleep $EIP_RETRY_INTERVAL
        fi
    done
else
    echo "WARNING: EIP_ALLOC_ID not set — skipping Elastic IP association"
    echo "Instance will use ephemeral public IP"
fi

# =============================================================================
# 2. CloudFormation Signal: Infrastructure Ready
# =============================================================================

echo "=== Sending CloudFormation SUCCESS signal (infrastructure ready) ==="

# cfn-bootstrap is pre-installed in the Golden AMI

/opt/aws/bin/cfn-signal --success true \
    --stack "${STACK_NAME}" \
    --resource "${ASG_LOGICAL_ID}" \
    --region "${AWS_REGION}" && echo "Signal sent successfully" || echo "WARNING: cfn-signal failed"

echo "=== Infrastructure setup complete, proceeding to app config... ==="

# =============================================================================
# 3. System Checks
#
# System updates (dnf update) and /usr/bin/sh symlink are baked into the
# Golden AMI. No runtime patching needed — AMI is rebuilt weekly.
# =============================================================================

# =============================================================================
# 4. Initialize kubeadm Kubernetes Control Plane
# =============================================================================

echo "=== Initializing kubeadm cluster (v${K8S_VERSION}) ==="

mkdir -p ${DATA_DIR}

# Get instance metadata via IMDSv2 (refresh token)
IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 || echo "")
PRIVATE_IP=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)

# =====================================================================
# Golden AMI Validation Gate
#
# 2026 Standard: All binaries (containerd, kubeadm, kubelet, kubectl)
# MUST be pre-baked in the Golden AMI. Installing packages at boot time
# creates a dependency on external repos (pkgs.k8s.io) — if those repos
# are down, Auto Scaling fails silently. Bootstrap scripts should only
# contain configuration strings (IPs, Tokens, IDs), never package installs.
# =====================================================================
REQUIRED_BINARIES=("containerd" "kubeadm" "kubelet" "kubectl" "helm")
MISSING=()

for bin in "${REQUIRED_BINARIES[@]}"; do
    if ! command -v "$bin" &>/dev/null; then
        MISSING+=("$bin")
    fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
    echo "ERROR: Golden AMI is missing required binaries: ${MISSING[*]}"
    echo ""
    echo "  The bootstrap script does NOT install packages at boot time."
    echo "  All binaries must be pre-baked into the Golden AMI."
    echo ""
    echo "  Missing: ${MISSING[*]}"
    echo "  Expected: ${REQUIRED_BINARIES[*]}"
    echo ""
    echo "  Resolution: Rebuild the Golden AMI with the missing binaries."
    echo "  See: infra-ami/ pipeline for AMI build instructions."
    exit 1
fi

echo "✓ Golden AMI validated — all required binaries present"

# =============================================================================
# Second-Run Guard — Idempotency for SSM State Manager / Reboots
#
# If kubeadm has already initialized (admin.conf exists), skip sections 4-6
# and jump directly to manifest deployment (section 7).
# This prevents crashes from running `kubeadm init` on an already-initialized
# cluster (e.g., ASG instance reboot or SSM re-invocation).
# =============================================================================
if [ -f /etc/kubernetes/admin.conf ]; then
    echo "=== Cluster already initialized — skipping to exit ==="
    echo "  (This is a second-run via SSM State Manager or instance reboot)"
    echo "  ArgoCD manages all application workloads — no imperative deploy needed."
    export KUBECONFIG=/etc/kubernetes/admin.conf

    # Refresh ssm-user kubeconfig (may have been updated by cert renewal)
    if id ssm-user &>/dev/null; then
        mkdir -p /home/ssm-user/.kube
        cp -f /etc/kubernetes/admin.conf /home/ssm-user/.kube/config
        chown ssm-user:ssm-user /home/ssm-user/.kube/config
        chmod 600 /home/ssm-user/.kube/config
    fi

    # =========================================================================
    # Certificate Renewal — kubeadm certs expire after 1 year by default.
    # Running on every boot ensures certificates are refreshed naturally
    # as the ASG replaces instances or SSM re-invokes the boot script.
    # On a fresh cluster (Day-0), this is a no-op (certs are brand new).
    # =========================================================================
    echo "=== Renewing kubeadm certificates ==="
    kubeadm certs renew all 2>&1 || echo "WARNING: Certificate renewal failed"
    echo "Certificate expiry status:"
    kubeadm certs check-expiration 2>&1 || true
    echo ""

    echo "=============================================="
    echo "=== Second-run complete at $(date) ==="
    echo "=============================================="
    exit 0
fi

# --- First boot: Initialize cluster ---

# Start containerd
systemctl start containerd
echo "containerd started"

# Build apiserver cert SANs
CERT_SANS="--apiserver-cert-extra-sans=$PRIVATE_IP"
if [ -n "$PUBLIC_IP" ]; then
    CERT_SANS="$CERT_SANS,$PUBLIC_IP"
fi

echo "Running kubeadm init..."
kubeadm init \
    --kubernetes-version="${K8S_VERSION}" \
    --pod-network-cidr="${POD_CIDR}" \
    --service-cidr="${SERVICE_CIDR}" \
    --control-plane-endpoint="$PRIVATE_IP:6443" \
    $CERT_SANS \
    --upload-certs \
    2>&1 | tee /tmp/kubeadm-init.log

if [ ${PIPESTATUS[0]} -ne 0 ]; then
    echo "ERROR: kubeadm init failed"
    cat /tmp/kubeadm-init.log
    exit 1
fi

# Set up kubeconfig for root
export KUBECONFIG=/etc/kubernetes/admin.conf
mkdir -p /root/.kube
cp -f /etc/kubernetes/admin.conf /root/.kube/config
chmod 600 /root/.kube/config

# Wait for control plane
echo "Waiting for control plane to be ready..."
for i in {1..90}; do
    if kubectl get nodes &>/dev/null; then
        echo "Control plane is ready (waited ${i} seconds)"
        break
    fi
    if [ $i -eq 90 ]; then
        echo "WARNING: Control plane did not become ready in 90s"
    fi
    sleep 1
done

# Control plane taint is INTENTIONALLY preserved.
# Only Traefik (via toleration in traefik-values.yaml) and system DaemonSets
# (kube-proxy, Calico, CoreDNS) will schedule on the control plane node.
# User workloads use nodeSelector to target application/monitoring worker nodes.
echo "Control plane taint preserved — only Traefik + system pods will run here"

# Publish join token + CA hash to SSM
JOIN_TOKEN=$(kubeadm token create --ttl 24h)
CA_HASH=$(openssl x509 -pubkey -in /etc/kubernetes/pki/ca.crt | \
    openssl rsa -pubin -outform der 2>/dev/null | \
    openssl dgst -sha256 -hex | awk '{print $2}')

aws ssm put-parameter --name "$SSM_PREFIX/join-token" --value "$JOIN_TOKEN" \
    --type "SecureString" --overwrite --region "$REGION" || echo "WARNING: Failed to store join-token in SSM"

aws ssm put-parameter --name "$SSM_PREFIX/ca-hash" --value "sha256:$CA_HASH" \
    --type "String" --overwrite --region "$REGION" || echo "WARNING: Failed to store ca-hash in SSM"

aws ssm put-parameter --name "$SSM_PREFIX/control-plane-endpoint" --value "$PRIVATE_IP:6443" \
    --type "String" --overwrite --region "$REGION" || echo "WARNING: Failed to store control-plane-endpoint in SSM"

aws ssm put-parameter --name "$SSM_PREFIX/instance-id" --value "$INSTANCE_ID" \
    --type "String" --overwrite --region "$REGION" || echo "WARNING: Failed to store instance-id in SSM"

# Refresh public IP after EIP association (IMDS reflects the new EIP)
IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 || echo "")

if [ -n "$PUBLIC_IP" ]; then
    aws ssm put-parameter --name "$SSM_PREFIX/elastic-ip" --value "$PUBLIC_IP" \
        --type "String" --overwrite --region "$REGION" || echo "WARNING: Failed to store elastic-ip in SSM"
fi

echo "kubeadm cluster initialized successfully"
echo "Kubernetes version: $(kubectl version --short 2>/dev/null || kubectl version)"
echo "Node status:"
kubectl get nodes -o wide

# =============================================================================
# 5. Install Calico CNI
# =============================================================================

echo "=== Installing Calico CNI ==="

export KUBECONFIG=/etc/kubernetes/admin.conf

OPERATOR_YAML="/opt/calico/tigera-operator.yaml"
echo "Applying Calico operator..."
if [ -f "$OPERATOR_YAML" ]; then
    echo "  Using pre-cached operator from Golden AMI"
    kubectl create -f "$OPERATOR_YAML" 2>/dev/null || \
        kubectl apply -f "$OPERATOR_YAML"
else
    echo "  WARNING: Pre-cached operator not found, downloading from GitHub"
    kubectl create -f "https://raw.githubusercontent.com/projectcalico/calico/$CALICO_VERSION/manifests/tigera-operator.yaml" 2>/dev/null || \
        kubectl apply -f "https://raw.githubusercontent.com/projectcalico/calico/$CALICO_VERSION/manifests/tigera-operator.yaml"
fi

echo "Waiting for Calico operator..."
kubectl wait --for=condition=Available deployment/tigera-operator \
    -n tigera-operator --timeout=120s || echo "WARNING: Operator not ready in 120s"

cat <<CALICO_EOF | kubectl apply -f -
apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  calicoNetwork:
    ipPools:
      - cidr: ${POD_CIDR}
        encapsulation: VXLANCrossSubnet
        natOutgoing: Enabled
        nodeSelector: all()
    linuxDataplane: Iptables
CALICO_EOF

echo "Waiting for Calico pods to become ready..."
for i in {1..120}; do
    READY=$(kubectl get pods -n calico-system --no-headers 2>/dev/null | { grep -c "Running" || true; })
    READY=${READY:-0}
    TOTAL=$(kubectl get pods -n calico-system --no-headers 2>/dev/null | wc -l | tr -d ' ')
    if [ "$TOTAL" -gt 0 ] && [ "$READY" -eq "$TOTAL" ]; then
        echo "Calico pods ready (${READY}/${TOTAL}, waited ${i} seconds)"
        break
    fi
    if [ $i -eq 120 ]; then
        echo "WARNING: Calico pods not fully ready after 120s (${READY}/${TOTAL})"
        kubectl get pods -n calico-system
    fi
    sleep 1
done

echo "Calico CNI installed successfully"
kubectl get pods -n calico-system
kubectl get nodes -o wide

# metrics-server is now managed by ArgoCD (applications/metrics-server.yaml)

# =============================================================================
# 6. Configure kubectl Access
# =============================================================================

echo "=== Configuring kubectl access ==="

KUBECONFIG_SRC="/etc/kubernetes/admin.conf"

mkdir -p /root/.kube
cp -f $KUBECONFIG_SRC /root/.kube/config
chmod 600 /root/.kube/config

mkdir -p /home/ec2-user/.kube
cp -f $KUBECONFIG_SRC /home/ec2-user/.kube/config
chown ec2-user:ec2-user /home/ec2-user/.kube/config
chmod 600 /home/ec2-user/.kube/config

# Configure kubectl for ssm-user (SSM Session Manager default user)
# ssm-user is created dynamically by SSM agent on first session,
# so it may not exist yet at boot time.
if id ssm-user &>/dev/null; then
    mkdir -p /home/ssm-user/.kube
    cp -f $KUBECONFIG_SRC /home/ssm-user/.kube/config
    chown ssm-user:ssm-user /home/ssm-user/.kube/config
    chmod 600 /home/ssm-user/.kube/config
else
    echo "ssm-user does not exist yet — deferred setup will run on first SSM session"
fi

# --- Gap 6 Fix: kubeconfig for non-login shells (SSM Session Manager) ---
# /etc/profile.d/ is only sourced by login shells. SSM drops into a non-login
# interactive shell, so KUBECONFIG is unset. We write to both locations:
#   1. /etc/profile.d/kubernetes.sh  — login shells (SSH, su -)
#   2. /etc/bashrc                   — non-login interactive shells (SSM)
echo "export KUBECONFIG=$KUBECONFIG_SRC" > /etc/profile.d/kubernetes.sh
chmod 644 /etc/profile.d/kubernetes.sh

# Append to /etc/bashrc only if not already present (idempotent)
if ! grep -q "KUBECONFIG=" /etc/bashrc 2>/dev/null; then
    cat >> /etc/bashrc <<'BASHRC_EOF'

# --- Kubernetes kubeconfig (added by boot-k8s.sh) ---
export KUBECONFIG=/etc/kubernetes/admin.conf
BASHRC_EOF
fi

# Deferred ssm-user kubeconfig provisioning.
# ssm-user is created by the SSM agent on first session, which is after boot.
# This script runs once on first SSM login to copy admin.conf into place.
cat > /usr/local/bin/setup-ssm-kubeconfig.sh <<'SSM_EOF'
#!/bin/bash
# One-shot: copy kubeconfig for ssm-user on first SSM session
if [ "$(whoami)" = "ssm-user" ] && [ ! -f "$HOME/.kube/config" ]; then
    mkdir -p "$HOME/.kube"
    sudo cp -f /etc/kubernetes/admin.conf "$HOME/.kube/config"
    sudo chown "$(id -u):$(id -g)" "$HOME/.kube/config"
    chmod 600 "$HOME/.kube/config"
fi
SSM_EOF
chmod 755 /usr/local/bin/setup-ssm-kubeconfig.sh

# Hook the deferred setup into bashrc (runs silently, only once)
if ! grep -q "setup-ssm-kubeconfig" /etc/bashrc 2>/dev/null; then
    echo "[ -x /usr/local/bin/setup-ssm-kubeconfig.sh ] && /usr/local/bin/setup-ssm-kubeconfig.sh" >> /etc/bashrc
fi

export KUBECONFIG=$KUBECONFIG_SRC
echo "kubectl configured. Cluster info:"
kubectl cluster-info
kubectl get namespaces

# End of first-boot cluster initialization (sections 4-6)

# local-path-provisioner is now managed by ArgoCD (applications/local-path-provisioner.yaml)

# =============================================================================
# 7. S3 Sync + ArgoCD Bootstrap (Handover)
#
# Download the bootstrap manifests from S3, then install ArgoCD.
# ArgoCD becomes the "sole owner" of all workloads from this point:
#   - Traefik (DaemonSet ingress controller)
#   - metrics-server (HPA)
#   - local-path-provisioner (StorageClass)
#   - Monitoring stack (Prometheus, Grafana, Loki, Tempo)
#   - Next.js application
# =============================================================================

echo "=== Downloading bootstrap manifests from S3 ==="

BOOTSTRAP_DIR="${MOUNT_POINT}/k8s-bootstrap"
mkdir -p $BOOTSTRAP_DIR

# "Patient" retry for Day-1 coordination — Sync pipeline may not have
# uploaded manifests yet. Wait up to 5 minutes (15 × 20s) before
# gracefully skipping.
S3_BOOTSTRAP_PREFIX="s3://${S3_BUCKET}/k8s-bootstrap/"
MANIFEST_MAX_RETRIES=15
MANIFEST_RETRY_INTERVAL=20
MANIFESTS_FOUND=false

for i in $(seq 1 $MANIFEST_MAX_RETRIES); do
  OBJ_COUNT=$(aws s3 ls "${S3_BOOTSTRAP_PREFIX}" --recursive --region ${AWS_REGION} 2>/dev/null | wc -l | tr -d ' ')
  if [ "$OBJ_COUNT" -gt 0 ]; then
    echo "✓ Found ${OBJ_COUNT} objects in S3 bootstrap (attempt $i/$MANIFEST_MAX_RETRIES)"
    aws s3 sync "${S3_BOOTSTRAP_PREFIX}" $BOOTSTRAP_DIR/ --region ${AWS_REGION}
    MANIFESTS_FOUND=true
    break
  fi
  echo "No manifests in S3 yet (attempt $i/$MANIFEST_MAX_RETRIES). Retrying in ${MANIFEST_RETRY_INTERVAL}s..."
  sleep $MANIFEST_RETRY_INTERVAL
done

if [ "$MANIFESTS_FOUND" = "true" ]; then
  echo "Bootstrap bundle downloaded: $BOOTSTRAP_DIR"
  find $BOOTSTRAP_DIR -name '*.sh' -exec chmod +x {} +
else
  echo "WARNING: No manifests found in S3 after $((MANIFEST_MAX_RETRIES * MANIFEST_RETRY_INTERVAL))s"
  echo "ArgoCD bootstrap skipped — run manually when S3 content is available"
fi

# --- ArgoCD Handover ---
# Once ArgoCD is running, it takes ownership of all workloads.

if [ "$MANIFESTS_FOUND" = "true" ]; then
  echo "=== Bootstrapping ArgoCD ==="

  export KUBECONFIG=/etc/kubernetes/admin.conf
  export ARGOCD_DIR="$BOOTSTRAP_DIR/system/argocd"

  $BOOTSTRAP_DIR/system/argocd/bootstrap-argocd.sh || echo "WARNING: ArgoCD bootstrap failed — run manually via SSM"

  echo "=== ArgoCD bootstrap complete ==="
  echo "ArgoCD now manages: traefik, metrics-server, local-path-provisioner, monitoring, nextjs"
fi

# =============================================================================
# Done
# =============================================================================

trap - EXIT  # Disable failure trap — boot completed successfully

echo ""
echo "=============================================="
echo "=== Boot script completed at $(date) ==="
echo "=============================================="
