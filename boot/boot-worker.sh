#!/usr/bin/env bash
# =============================================================================
# Worker Boot Script — kubeadm Join with Retry + Bidirectional cfn-signal
#
# Downloaded from S3 at boot time by the slim CDK user data stub.
# Mirrors the control plane's boot-k8s.sh pattern for consistency.
#
# Expected environment variables (set by inline user data):
#   STACK_NAME       — CloudFormation stack name (for cfn-signal)
#   ASG_LOGICAL_ID   — ASG logical ID (for cfn-signal)
#   AWS_REGION       — AWS region
#   SSM_PREFIX       — SSM parameter prefix (e.g. /k8s/development)
#   NODE_LABEL       — Kubernetes node label (e.g. role=application)
#   LOG_GROUP_NAME   — CloudWatch log group for boot log streaming
# =============================================================================

set -euxo pipefail

# Defaults
AWS_REGION="${AWS_REGION:-eu-west-1}"
SSM_PREFIX="${SSM_PREFIX:-/k8s/development}"
NODE_LABEL="${NODE_LABEL:-role=worker}"
LOG_GROUP_NAME="${LOG_GROUP_NAME:-/ec2/k8s-worker/instances}"

# Retry configuration
JOIN_MAX_RETRIES=10
JOIN_RETRY_INTERVAL=30

# =============================================================================
# Trap: send FAILURE signal on unexpected exit
#
# If the script exits non-zero before reaching the success signal,
# CloudFormation learns immediately instead of waiting for the full
# signalsTimeoutMinutes to elapse.
# =============================================================================
send_failure_signal() {
    local EXIT_CODE=$?
    if [ "$EXIT_CODE" -ne 0 ]; then
        echo ""
        echo "=== FATAL: boot-worker.sh exited with code $EXIT_CODE ==="
        echo "Sending FAILURE signal to CloudFormation..."

        # cfn-bootstrap is pre-installed in the Golden AMI

        /opt/aws/bin/cfn-signal --success false \
            --stack "${STACK_NAME}" \
            --resource "${ASG_LOGICAL_ID}" \
            --region "${AWS_REGION}" \
            --reason "boot-worker.sh failed with exit code $EXIT_CODE" \
            2>/dev/null || echo "WARNING: cfn-signal --success false also failed"
    fi
}
trap send_failure_signal EXIT

# =============================================================================
# 0. Start CloudWatch Agent (FIRST — streams logs from this point onward)
# =============================================================================

CW_CONFIG="/opt/aws/amazon-cloudwatch-agent/etc/boot-logs.json"

if [ -f "$CW_CONFIG" ]; then
    echo "=== Starting CloudWatch Agent ==="
    sed -i "s|__LOG_GROUP_NAME__|${LOG_GROUP_NAME}|g" "$CW_CONFIG"

    /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
        -a fetch-config -m ec2 -s -c "file:${CW_CONFIG}" || \
        echo "WARNING: CloudWatch Agent failed to start — boot continues without log streaming"
    echo "CloudWatch Agent started — streaming boot logs to ${LOG_GROUP_NAME}"
else
    echo "WARNING: CloudWatch Agent config not found at ${CW_CONFIG} — boot logs NOT streamed"
fi

# =============================================================================
# 1. Instance Metadata + Networking Prerequisites
# =============================================================================

echo "=== Worker boot script started at $(date) ==="

# IMDSv2
IMDS_TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
    http://169.254.169.254/latest/meta-data/instance-id)
PRIVATE_IP=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
    http://169.254.169.254/latest/meta-data/local-ipv4)
REGION=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
    http://169.254.169.254/latest/meta-data/placement/region)

echo "Instance: $INSTANCE_ID, Private IP: $PRIVATE_IP, Region: $REGION"
echo "Node label: $NODE_LABEL"

# Networking prerequisites (modprobe, sysctl) are baked into the Golden AMI.
# systemd-modules-load.service loads /etc/modules-load.d/k8s.conf at boot.
# systemd-sysctl.service applies /etc/sysctl.d/k8s.conf at boot.

# =============================================================================
# 2. Resolve Control Plane Endpoint from SSM
# =============================================================================

echo "=== Resolving control plane endpoint from SSM ==="

CP_ENDPOINT_SSM="${SSM_PREFIX}/control-plane-endpoint"
CP_MAX_WAIT=300
CP_WAITED=0
CONTROL_PLANE_ENDPOINT=""

while [ -z "$CONTROL_PLANE_ENDPOINT" ] || [ "$CONTROL_PLANE_ENDPOINT" = "None" ]; do
    CONTROL_PLANE_ENDPOINT=$(aws ssm get-parameter \
        --name "${CP_ENDPOINT_SSM}" \
        --query "Parameter.Value" \
        --output text \
        --region "$REGION" 2>/dev/null || echo "")

    if [ -n "$CONTROL_PLANE_ENDPOINT" ] && [ "$CONTROL_PLANE_ENDPOINT" != "None" ]; then
        echo "Control plane endpoint: $CONTROL_PLANE_ENDPOINT"
        break
    fi

    if [ $CP_WAITED -ge $CP_MAX_WAIT ]; then
        echo "ERROR: Control plane endpoint not found in SSM after ${CP_MAX_WAIT}s"
        echo "The control plane must be running and have published its endpoint to ${CP_ENDPOINT_SSM}"
        exit 1
    fi

    echo "Waiting for control plane endpoint... (${CP_WAITED}s / ${CP_MAX_WAIT}s)"
    sleep 10
    CP_WAITED=$((CP_WAITED + 10))
done

# =============================================================================
# 3. kubeadm Join with Retry
#
# Re-fetches the join token from SSM on each attempt. This handles the
# race condition where the control plane signals CloudFormation SUCCESS
# before kubeadm init completes and publishes fresh tokens.
# =============================================================================

echo "=== Joining kubeadm cluster as worker node ==="
echo "Join config: max_retries=${JOIN_MAX_RETRIES}, retry_interval=${JOIN_RETRY_INTERVAL}s"

# Start containerd
systemctl start containerd
echo "containerd started"

# Configure kubelet with node labels BEFORE joining
# kubeadm join does NOT support --node-labels; labels must be set via kubelet extra args
echo "Configuring kubelet with node label: ${NODE_LABEL}"
echo "KUBELET_EXTRA_ARGS=--node-labels=${NODE_LABEL}" > /etc/sysconfig/kubelet
echo "Kubelet extra args configured"

TOKEN_SSM="${SSM_PREFIX}/join-token"
CA_HASH_SSM="${SSM_PREFIX}/ca-hash"

JOIN_SUCCESS=false
for ATTEMPT in $(seq 1 $JOIN_MAX_RETRIES); do
    echo ""
    echo "=== kubeadm join attempt ${ATTEMPT}/${JOIN_MAX_RETRIES} ==="

    # Retrieve join token from SSM (re-fetch each attempt — token may be refreshed by CP)
    echo "Retrieving join token from SSM: ${TOKEN_SSM}"
    JOIN_TOKEN=$(aws ssm get-parameter \
        --name "${TOKEN_SSM}" \
        --with-decryption \
        --query "Parameter.Value" \
        --output text \
        --region "$REGION" 2>/dev/null || echo "")

    if [ -z "$JOIN_TOKEN" ]; then
        echo "WARNING: Join token not available in SSM (attempt ${ATTEMPT}/${JOIN_MAX_RETRIES})"
        echo "Control plane may still be initializing..."
        if [ ${ATTEMPT} -lt ${JOIN_MAX_RETRIES} ]; then
            echo "Sleeping ${JOIN_RETRY_INTERVAL}s before retry..."
            sleep ${JOIN_RETRY_INTERVAL}
            continue
        fi
        echo "ERROR: Join token never became available after ${JOIN_MAX_RETRIES} attempts"
        exit 1
    fi
    echo "Join token retrieved successfully"

    # Retrieve CA certificate hash from SSM
    echo "Retrieving CA hash from SSM: ${CA_HASH_SSM}"
    CA_HASH=$(aws ssm get-parameter \
        --name "${CA_HASH_SSM}" \
        --query "Parameter.Value" \
        --output text \
        --region "$REGION" 2>/dev/null || echo "")

    if [ -z "$CA_HASH" ]; then
        echo "WARNING: CA hash not available in SSM (attempt ${ATTEMPT}/${JOIN_MAX_RETRIES})"
        if [ ${ATTEMPT} -lt ${JOIN_MAX_RETRIES} ]; then
            echo "Sleeping ${JOIN_RETRY_INTERVAL}s before retry..."
            sleep ${JOIN_RETRY_INTERVAL}
            continue
        fi
        echo "ERROR: CA hash never became available after ${JOIN_MAX_RETRIES} attempts"
        exit 1
    fi
    echo "CA hash retrieved successfully"

    # Attempt kubeadm join
    echo "Running kubeadm join..."
    set +e  # Temporarily disable exit-on-error for join attempt
    kubeadm join "${CONTROL_PLANE_ENDPOINT}" \
        --token "$JOIN_TOKEN" \
        --discovery-token-ca-cert-hash "$CA_HASH" \
        2>&1 | tee /tmp/kubeadm-join.log
    JOIN_EXIT=${PIPESTATUS[0]}
    set -e

    if [ $JOIN_EXIT -eq 0 ]; then
        echo "kubeadm join succeeded on attempt ${ATTEMPT}"
        JOIN_SUCCESS=true
        break
    fi

    echo "WARNING: kubeadm join failed on attempt ${ATTEMPT}/${JOIN_MAX_RETRIES}"
    cat /tmp/kubeadm-join.log

    # Reset kubeadm state before retrying (required for re-join)
    if [ ${ATTEMPT} -lt ${JOIN_MAX_RETRIES} ]; then
        echo "Running kubeadm reset before retry..."
        kubeadm reset -f 2>/dev/null || true
        echo "Sleeping ${JOIN_RETRY_INTERVAL}s before retry..."
        sleep ${JOIN_RETRY_INTERVAL}
    fi
done

if [ "$JOIN_SUCCESS" != "true" ]; then
    echo "ERROR: kubeadm join failed after ${JOIN_MAX_RETRIES} attempts"
    echo "Last join log:"
    cat /tmp/kubeadm-join.log 2>/dev/null || true
    exit 1
fi

# =============================================================================
# 4. Wait for kubelet
# =============================================================================

echo "Waiting for kubelet to become active..."
for i in {1..60}; do
    if systemctl is-active --quiet kubelet; then
        echo "kubelet is active (waited ${i} seconds)"
        break
    fi
    if [ $i -eq 60 ]; then
        echo "WARNING: kubelet did not become active in 60s"
        journalctl -u kubelet --no-pager -n 20
    fi
    sleep 1
done

echo "Worker node joined cluster successfully"
echo "kubelet version: $(kubelet --version)"
echo "Service status: $(systemctl is-active kubelet)"

# =============================================================================
# 5. CloudFormation Signal: SUCCESS
#
# Clear the trap first — we're about to succeed, so the EXIT trap
# should not send a failure signal.
# =============================================================================

trap - EXIT  # Disable failure trap — we succeeded

echo "=== Sending CloudFormation SUCCESS signal ==="

# cfn-bootstrap is pre-installed in the Golden AMI

/opt/aws/bin/cfn-signal --success true \
    --stack "${STACK_NAME}" \
    --resource "${ASG_LOGICAL_ID}" \
    --region "${AWS_REGION}" && echo "Signal sent successfully" || echo "WARNING: cfn-signal failed"

# =============================================================================
# Done
# =============================================================================

echo ""
echo "=============================================="
echo "=== Worker boot script completed at $(date) ==="
echo "=============================================="
