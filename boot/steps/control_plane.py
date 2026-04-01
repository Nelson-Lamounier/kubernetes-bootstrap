#!/usr/bin/env python3
"""
@format
Control Plane Bootstrap — Consolidated Steps

Orchestrates the full Kubernetes control plane bootstrap as a single
entry point. Each step is wrapped in a StepRunner for structured
logging, timing, and idempotency guards.

Steps (in order):
    0.  attach_ebs_volume — Attach, format, and mount the EBS data volume
    1.  validate_ami       — Verify Golden AMI binaries and kernel settings
    2.  restore_backup     — Restore etcd + certs from S3 if EBS is empty (DR)
    3.  init_kubeadm       — kubeadm init + publish join credentials to SSM
    4.  install_calico     — Calico CNI via Tigera operator
    4b. install_ccm        — AWS Cloud Controller Manager (removes uninitialized taint)
    5.  configure_kubectl  — kubeconfig for root, ec2-user, ssm-user
    6.  sync_manifests     — Download bootstrap manifests from S3
    7.  bootstrap_argocd   — Install ArgoCD and App-of-Apps
    8.  verify_cluster     — Lightweight post-boot health checks
    9.  install_cw_agent   — CloudWatch Agent for log streaming
    10. install_etcd_backup — Set up hourly etcd backup timer

Idempotent: each step uses marker files or existence checks to skip
if already completed. Safe to re-run on instance replacement.

Expected environment variables:
    SSM_PREFIX       — SSM parameter prefix (e.g. /k8s/development)
    AWS_REGION       — AWS region
    K8S_VERSION      — Kubernetes version (e.g. 1.35.1)
    DATA_DIR         — kubeadm data directory (default: /data/kubernetes)
    POD_CIDR         — Pod network CIDR (default: 192.168.0.0/16)
    SERVICE_CIDR     — Service subnet (default: 10.96.0.0/12)
    HOSTED_ZONE_ID   — Route 53 hosted zone for API DNS
    API_DNS_NAME     — DNS name for K8s API (default: k8s-api.k8s.internal)
    S3_BUCKET        — S3 bucket containing bootstrap content
    MOUNT_POINT      — Local mount point (default: /data)
    CALICO_VERSION   — Calico version (default: v3.29.3)
    LOG_GROUP_NAME   — CloudWatch log group name

Usage:
    python3 control_plane.py
"""

import glob
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import (
    AWS_REGION as DEFAULT_AWS_REGION,
)
from common import (
    ECR_PROVIDER_CONFIG,
    StepRunner,
    ensure_ecr_credential_provider,
    get_imds_value,
    log_error,
    log_info,
    log_warn,
    patch_provider_id,
    run_cmd,
    ssm_put,
    step_install_cloudwatch_agent,
    step_validate_ami,
    validate_kubeadm_token,
)
from common import (
    SSM_PREFIX as DEFAULT_SSM_PREFIX,
)

# =============================================================================
# Configuration
# =============================================================================

SSM_PREFIX = os.environ.get("SSM_PREFIX", DEFAULT_SSM_PREFIX)
AWS_REGION = os.environ.get("AWS_REGION", DEFAULT_AWS_REGION)
K8S_VERSION = os.environ.get("K8S_VERSION", "1.35.1")
DATA_DIR = os.environ.get("DATA_DIR", "/data/kubernetes")
POD_CIDR = os.environ.get("POD_CIDR", "192.168.0.0/16")
SERVICE_CIDR = os.environ.get("SERVICE_CIDR", "10.96.0.0/12")
HOSTED_ZONE_ID = os.environ.get("HOSTED_ZONE_ID", "")
API_DNS_NAME = os.environ.get("API_DNS_NAME", "k8s-api.k8s.internal")
S3_BUCKET = os.environ.get("S3_BUCKET", "")
MOUNT_POINT = os.environ.get("MOUNT_POINT", "/data")
VOLUME_ID = os.environ.get("VOLUME_ID", "")
CALICO_VERSION = os.environ.get("CALICO_VERSION", "v3.29.3")
ENVIRONMENT = os.environ.get("ENVIRONMENT", "development")

ADMIN_CONF = "/etc/kubernetes/admin.conf"
SUPER_ADMIN_CONF = "/etc/kubernetes/super-admin.conf"


def _bootstrap_kubeconfig_env() -> dict[str, str]:
    """Return the best kubeconfig env for bootstrap operations.

    Prefers super-admin.conf (kubeadm 1.30+) which bypasses RBAC,
    making bootstrap operations resilient to missing ClusterRoleBindings.
    Falls back to admin.conf for first-boot (before kubeadm init creates it).
    """
    if Path(SUPER_ADMIN_CONF).exists():
        return {"KUBECONFIG": SUPER_ADMIN_CONF}
    return {"KUBECONFIG": ADMIN_CONF}

CALICO_MARKER = "/etc/kubernetes/.calico-installed"
CCM_MARKER = "/etc/kubernetes/.ccm-installed"
EBS_ATTACH_MARKER = "/etc/kubernetes/.ebs-attached"

# EBS attachment constants
EBS_DEVICE_NAME = "/dev/xvdf"
EBS_FILESYSTEM = "ext4"
EBS_MAX_ATTACH_RETRIES = 30
EBS_RETRY_INTERVAL_SECONDS = 10

# DR backup paths
DR_BACKUP_PREFIX = "dr-backups"
DR_RESTORE_MARKER = "/etc/kubernetes/.dr-restored"


# =============================================================================
# Step 0 — Attach and Mount EBS Data Volume
# =============================================================================

def _resolve_nvme_device() -> str:
    """Resolve the NVMe device path for the attached EBS volume.

    On Nitro-based instances (t3, m5, c5, etc.), EBS volumes attached as
    /dev/xvdf appear as /dev/nvme<N>n1 in the kernel. This function finds
    the correct NVMe device by checking for any non-root NVMe block device.

    Returns:
        The device path (e.g. '/dev/nvme1n1') or empty string if not found.
    """
    # Check traditional device name first
    if Path(EBS_DEVICE_NAME).exists():
        return EBS_DEVICE_NAME

    # Scan NVMe devices — the root volume is always nvme0n1
    nvme_devices = sorted(glob.glob("/dev/nvme[1-9]n1"))
    if nvme_devices:
        return nvme_devices[0]

    return ""


def _is_already_mounted(mount_point: str) -> bool:
    """Check if the mount point is already a mounted filesystem."""
    result = run_cmd(
        ["mountpoint", "-q", mount_point],
        check=False,
    )
    return result.returncode == 0


def _describe_volume(volume_id: str) -> dict:
    """Describe an EBS volume and return its state and attachment info.

    Returns:
        Dict with keys: 'state', 'attached_instance', 'device'.
    """
    result = run_cmd(
        ["aws", "ec2", "describe-volumes",
         "--volume-ids", volume_id,
         "--query", "Volumes[0].{State:State,Attachments:Attachments}",
         "--output", "json",
         "--region", AWS_REGION],
        check=True,
    )
    data = json.loads(result.stdout)
    attachments = data.get("Attachments", []) or []
    attached_instance = attachments[0]["InstanceId"] if attachments else ""
    device = attachments[0]["Device"] if attachments else ""

    return {
        "state": data.get("State", "unknown"),
        "attached_instance": attached_instance,
        "device": device,
    }


def _wait_for_volume_available(volume_id: str, instance_id: str) -> str:
    """Wait for the EBS volume to become available for attachment.

    Handles ASG replacement: if the volume is still attached to the old
    (terminating) instance, this retries until it transitions to 'available'.
    If the volume is already attached to THIS instance, returns 'already-attached'.

    Returns:
        'available'          — volume is ready to attach
        'already-attached'   — volume is already attached to this instance

    Raises:
        RuntimeError if the volume does not become available within the retry window.
    """
    for attempt in range(1, EBS_MAX_ATTACH_RETRIES + 1):
        info = _describe_volume(volume_id)
        state = info["state"]
        attached_to = info["attached_instance"]

        if state == "available":
            log_info(f"Volume {volume_id} is available (attempt {attempt})")
            return "available"

        if state == "in-use" and attached_to == instance_id:
            log_info(
                f"Volume {volume_id} already attached to this instance — "
                f"skipping attach"
            )
            return "already-attached"

        if state == "in-use":
            log_warn(
                f"Volume {volume_id} still attached to {attached_to} "
                f"(ASG replacement in progress). "
                f"Waiting {EBS_RETRY_INTERVAL_SECONDS}s... "
                f"(attempt {attempt}/{EBS_MAX_ATTACH_RETRIES})"
            )
        else:
            log_warn(
                f"Volume {volume_id} in unexpected state '{state}'. "
                f"Waiting {EBS_RETRY_INTERVAL_SECONDS}s... "
                f"(attempt {attempt}/{EBS_MAX_ATTACH_RETRIES})"
            )

        time.sleep(EBS_RETRY_INTERVAL_SECONDS)

    raise RuntimeError(
        f"EBS volume {volume_id} did not become available after "
        f"{EBS_MAX_ATTACH_RETRIES * EBS_RETRY_INTERVAL_SECONDS}s. "
        f"Check if the old EC2 instance has fully terminated."
    )


def _attach_volume(volume_id: str, instance_id: str) -> None:
    """Attach the EBS volume to this instance."""
    log_info(
        f"Attaching volume {volume_id} to {instance_id} "
        f"as {EBS_DEVICE_NAME}..."
    )
    run_cmd(
        ["aws", "ec2", "attach-volume",
         "--volume-id", volume_id,
         "--instance-id", instance_id,
         "--device", EBS_DEVICE_NAME,
         "--region", AWS_REGION],
        check=True,
    )
    log_info(f"Attach command sent for {volume_id}")


def _wait_for_device() -> str:
    """Wait for the block device to appear in the OS after attachment.

    Returns:
        The resolved device path (e.g. '/dev/nvme1n1' or '/dev/xvdf').

    Raises:
        RuntimeError if the device does not appear within 60 seconds.
    """
    log_info("Waiting for block device to appear...")
    for i in range(1, 61):
        device = _resolve_nvme_device()
        if device:
            log_info(f"Block device appeared: {device} (waited {i}s)")
            return device
        time.sleep(1)

    raise RuntimeError(
        f"Block device did not appear within 60s after attachment. "
        f"Expected {EBS_DEVICE_NAME} or /dev/nvme<N>n1. "
        f"Run 'lsblk' to inspect available devices."
    )


def _format_if_needed(device: str) -> bool:
    """Format the EBS volume with ext4 if it has no filesystem.

    Returns True if formatting was performed, False if already formatted.
    """
    result = run_cmd(
        ["blkid", "-o", "value", "-s", "TYPE", device],
        check=False,
    )
    existing_fs = result.stdout.strip()

    if existing_fs:
        log_info(f"Device {device} already has filesystem: {existing_fs}")
        return False

    log_info(f"No filesystem on {device} — formatting as {EBS_FILESYSTEM}")
    run_cmd(
        ["mkfs", "-t", EBS_FILESYSTEM, device],
        check=True,
    )
    log_info(f"Formatted {device} as {EBS_FILESYSTEM}")
    return True


def _mount_volume(device: str, mount_point: str) -> None:
    """Mount the device and ensure persistence via fstab."""
    Path(mount_point).mkdir(parents=True, exist_ok=True)

    # Mount the device
    log_info(f"Mounting {device} at {mount_point}")
    run_cmd(["mount", device, mount_point], check=True)

    # Add fstab entry for reboot persistence (idempotent)
    fstab = Path("/etc/fstab")
    fstab_content = fstab.read_text() if fstab.exists() else ""
    if mount_point not in fstab_content:
        # Use nofail so the instance still boots if the volume is missing
        entry = f"{device}  {mount_point}  {EBS_FILESYSTEM}  defaults,nofail  0  2\n"
        with fstab.open("a") as f:
            f.write(entry)
        log_info(f"fstab entry added: {entry.strip()}")
    else:
        log_info(f"fstab already contains entry for {mount_point}")


def _ensure_data_directories(mount_point: str) -> None:
    """Create the required subdirectory structure on the data volume.

    These directories match what the Golden AMI component creates
    in the root filesystem at build time. Once the EBS volume is
    mounted over /data, they need to exist on the volume itself.
    """
    subdirs = ["kubernetes", "k8s-bootstrap", "app-deploy"]
    for subdir in subdirs:
        path = Path(mount_point) / subdir
        path.mkdir(parents=True, exist_ok=True)
    log_info(
        f"Data directories ensured: "
        f"{', '.join(str(Path(mount_point) / d) for d in subdirs)}"
    )


def step_attach_ebs_volume() -> None:
    """Step 0: Attach, format (if needed), and mount the EBS data volume.

    This step runs before everything else to ensure /data is on the
    persistent EBS volume rather than the ephemeral root volume.

    Handles:
    - Idempotent re-runs (marker file + mountpoint check)
    - ASG replacement (waits for volume to detach from old instance)
    - NVMe device naming on Nitro instances
    - First-boot formatting (only if volume has no filesystem)
    - fstab entry for reboot persistence
    """
    with StepRunner("attach-ebs-volume", skip_if=EBS_ATTACH_MARKER) as step:
        if step.skipped:
            return

        if not VOLUME_ID:
            log_warn(
                "VOLUME_ID not set — skipping EBS attachment. "
                "Kubernetes data will use the root volume (not persistent)."
            )
            step.details["action"] = "skipped_no_volume_id"
            return

        # Already mounted (e.g. manual recovery or previous partial run)
        if _is_already_mounted(MOUNT_POINT):
            log_info(
                f"{MOUNT_POINT} is already a mount point — "
                f"skipping attachment"
            )
            step.details["action"] = "skipped_already_mounted"
            _ensure_data_directories(MOUNT_POINT)
            return

        instance_id = get_imds_value("instance-id")
        if not instance_id:
            raise RuntimeError(
                "Failed to retrieve instance ID from IMDS. "
                "Cannot attach EBS volume without knowing the instance ID."
            )

        step.details["volume_id"] = VOLUME_ID
        step.details["instance_id"] = instance_id
        step.details["mount_point"] = MOUNT_POINT

        # Wait for volume to be available (handles ASG replacement)
        availability = _wait_for_volume_available(VOLUME_ID, instance_id)

        # Attach if not already attached to this instance
        if availability == "available":
            _attach_volume(VOLUME_ID, instance_id)
            device = _wait_for_device()
            step.details["action"] = "attached"
        else:
            # Already attached to this instance — resolve the device
            device = _resolve_nvme_device()
            if not device:
                device = _wait_for_device()
            step.details["action"] = "already_attached"

        step.details["device"] = device

        # Format if this is a brand-new volume
        formatted = _format_if_needed(device)
        step.details["formatted"] = formatted

        # Mount and add fstab entry
        _mount_volume(device, MOUNT_POINT)

        # Ensure directory structure exists on the volume
        _ensure_data_directories(MOUNT_POINT)

        log_info(
            f"✓ EBS volume {VOLUME_ID} attached as {device}, "
            f"mounted at {MOUNT_POINT}"
        )


# Step 1 — Validate Golden AMI
# Imported from common: step_validate_ami()


# =============================================================================
# Step 2 — Initialize kubeadm Control Plane
# =============================================================================


def _label_control_plane_node() -> None:
    """Apply workload and environment labels to the control plane node.

    Enables Grafana dashboards to identify the control plane by role
    rather than by IP address. Idempotent — re-labelling an already-labelled
    node is a no-op.
    """
    hostname = run_cmd(
        ["kubectl", "get", "nodes",
         "-l", "node-role.kubernetes.io/control-plane=",
         "-o", "jsonpath={.items[0].metadata.name}"],
        check=False, env=_bootstrap_kubeconfig_env(),
    )
    node_name = hostname.stdout.strip()
    if not node_name:
        log_warn("Could not resolve control plane node name — skipping labelling")
        return

    labels = {
        "workload": "control-plane",
        "environment": ENVIRONMENT,
    }
    label_args = [f"{k}={v}" for k, v in labels.items()]

    result = run_cmd(
        ["kubectl", "label", "node", node_name, "--overwrite", *label_args],
        check=False, env=_bootstrap_kubeconfig_env(),
    )
    if result.returncode == 0:
        log_info(f"Control plane node labelled: {', '.join(label_args)}")
    else:
        log_warn(f"Failed to label control plane node: {result.stderr.strip()}")


def _update_dns_record(private_ip: str) -> None:
    """Update Route 53 A record to point to the current private IP."""
    if not HOSTED_ZONE_ID:
        log_warn("HOSTED_ZONE_ID not set — skipping DNS update")
        return

    log_info(f"Updating DNS: {API_DNS_NAME} → {private_ip}")
    change_batch = json.dumps({
        "Changes": [{
            "Action": "UPSERT",
            "ResourceRecordSet": {
                "Name": API_DNS_NAME,
                "Type": "A",
                "TTL": 30,
                "ResourceRecords": [{"Value": private_ip}],
            },
        }],
    })
    result = run_cmd(
        ["aws", "route53", "change-resource-record-sets",
         "--hosted-zone-id", HOSTED_ZONE_ID,
         "--change-batch", change_batch,
         "--region", AWS_REGION],
        check=False,
    )
    if result.returncode != 0:
        log_error(f"DNS update failed: {result.stderr}")
        raise RuntimeError(
            f"Failed to update {API_DNS_NAME} → {private_ip}. "
            "Check HOSTED_ZONE_ID and IAM permissions."
        )
    log_info(f"DNS updated: {API_DNS_NAME} → {private_ip}")


def _get_apiserver_cert_ips() -> list[str]:
    """Extract the IP SANs from the current API server certificate.

    Returns a list of IP addresses the cert is currently valid for,
    so we can detect when the instance IP has changed (e.g. after ASG replacement).
    """
    result = run_cmd(
        ["openssl", "x509", "-in", "/etc/kubernetes/pki/apiserver.crt",
         "-noout", "-text"],
        check=False,
    )
    if result.returncode != 0:
        return []

    ips: list[str] = []
    in_san = False
    for line in result.stdout.splitlines():
        if "Subject Alternative Name" in line:
            in_san = True
            continue
        if in_san:
            for part in line.split(","):
                part = part.strip()
                if part.startswith("IP Address:"):
                    ips.append(part.removeprefix("IP Address:").strip())
            break
    return ips


def _renew_apiserver_cert(private_ip: str, public_ip: str) -> None:
    """Regenerate the API server certificate with the current instance IPs.

    Called when the instance has a new private IP that is not covered by the
    existing cert SANs — the typical case after ASG replacement where the new
    EC2 instance gets a different IP from the original.

    Steps:
        1. Delete the stale apiserver cert/key (kubeadm will not overwrite them).
        2. Re-run ``kubeadm init phase certs apiserver`` with the correct SANs.
        3. Restart the kube-apiserver static pod by removing its container so
           kubelet recreates it from the updated manifest.
        4. Wait up to 60 s for the API server to become healthy again.
    """
    log_info(f"Renewing API server certificate for IP {private_ip}...")

    # Build the full SAN list — must include everything the original init used
    extra_sans = f"127.0.0.1,{private_ip},{API_DNS_NAME}"
    if public_ip:
        extra_sans += f",{public_ip}"

    # Step 1: Remove stale cert/key so kubeadm regenerates them
    for path in ["/etc/kubernetes/pki/apiserver.crt", "/etc/kubernetes/pki/apiserver.key"]:
        if Path(path).exists():
            Path(path).unlink()
            log_info(f"Removed stale cert: {path}")

    # Step 2: Regenerate with correct SANs
    result = run_cmd(
        [
            "kubeadm", "init", "phase", "certs", "apiserver",
            f"--apiserver-advertise-address={private_ip}",
            f"--apiserver-cert-extra-sans={extra_sans}",
        ],
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"kubeadm cert regeneration failed: {result.stderr.strip()}"
        )
    log_info("✓ API server certificate regenerated")

    # Step 3: Force kube-apiserver static pod to reload the new cert.
    # Removing the running container causes kubelet to recreate it immediately.
    log_info("Restarting kube-apiserver static pod to pick up new certificate...")
    run_cmd(
        ["bash", "-c",
         "crictl rm $(crictl ps --name kube-apiserver -q) 2>/dev/null || true"],
        check=False,
    )

    # Step 4: Wait for the API server to come back up
    log_info("Waiting for API server to become healthy after cert renewal...")
    for i in range(1, 61):
        probe = run_cmd(
            ["kubectl", "get", "--raw", "/healthz"],
            check=False, env=_bootstrap_kubeconfig_env(),
        )
        if probe.returncode == 0 and "ok" in probe.stdout.lower():
            log_info(f"✓ API server healthy after cert renewal (waited {i}s)")
            return
        time.sleep(1)

    raise RuntimeError(
        "API server did not become healthy within 60s after cert renewal. "
        "Check 'crictl ps' and 'journalctl -u kubelet' for details."
    )


def _handle_second_run() -> None:
    """Handle second-run: update DNS and refresh kubeconfig."""
    log_info("Cluster already initialized — running second-run maintenance")
    log_info("Using super-admin.conf for bootstrap operations")

    private_ip = get_imds_value("local-ipv4")
    public_ip = get_imds_value("public-ipv4")

    if private_ip:
        _update_dns_record(private_ip)

    api_endpoint = f"{API_DNS_NAME}:6443"
    log_info(f"Publishing DNS endpoint to SSM: {api_endpoint}")
    ssm_put(f"{SSM_PREFIX}/control-plane-endpoint", api_endpoint)

    result = run_cmd(["id", "ssm-user"], check=False)
    if result.returncode == 0:
        Path("/home/ssm-user/.kube").mkdir(parents=True, exist_ok=True)
        run_cmd(["cp", "-f", ADMIN_CONF, "/home/ssm-user/.kube/config"])
        run_cmd(["chown", "ssm-user:ssm-user", "/home/ssm-user/.kube/config"])
        run_cmd(["chmod", "600", "/home/ssm-user/.kube/config"])

    _publish_kubeconfig_to_ssm()

    # Detect IP mismatch: if the current private IP is not in the cert SANs,
    # the kubelet cannot register and the entire bootstrap will fail downstream.
    # This is the normal case after ASG replacement with a new EC2 instance IP.
    if private_ip:
        cert_ips = _get_apiserver_cert_ips()
        if cert_ips and private_ip not in cert_ips:
            log_warn(
                f"IP mismatch detected — cert SANs: {cert_ips}, "
                f"current IP: {private_ip}. Renewing API server certificate..."
            )
            _renew_apiserver_cert(private_ip, public_ip or "")
        elif not cert_ips:
            log_warn("Could not read cert SANs — skipping IP mismatch check")

    # Verify API server is healthy using super-admin
    result = run_cmd(
        ["kubectl", "get", "nodes"],
        check=False, env=_bootstrap_kubeconfig_env(),
    )
    if result.returncode != 0:
        log_warn("API server not responding via super-admin — certs may need renewal + restart")
        return

    # Check if standard admin.conf works (verifies RBAC is intact)
    admin_result = run_cmd(
        ["kubectl", "get", "nodes"],
        check=False, env={"KUBECONFIG": ADMIN_CONF},
    )
    
    if admin_result.returncode != 0:
        output = (admin_result.stderr + admin_result.stdout).strip()
        if "Forbidden" in output:
            log_warn("admin.conf got 403 Forbidden. RBAC binding 'kubeadm:cluster-admins' is missing. Attempting repair...")
            
            # Recreate the missing kubeadm:cluster-admins binding
            rbac_manifest = """
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubeadm:cluster-admins
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
- apiGroup: rbac.authorization.k8s.io
  kind: User
  name: kubernetes-admin
"""
            repair_result = run_cmd(
                ["kubectl", "apply", "-f", "-"],
                input=rbac_manifest.encode(),
                check=False, env=_bootstrap_kubeconfig_env(),
            )
            if repair_result.returncode != 0:
                raise RuntimeError(f"Failed to repair RBAC binding: {repair_result.stderr}")
            
            log_info("✓ RBAC binding kubeadm:cluster-admins repaired successfully")
        else:
            log_warn(f"admin.conf failed for a non-RBAC reason: {output}")

    log_info("API server healthy — second-run maintenance complete")
    _label_control_plane_node()


def _init_cluster() -> None:
    """Initialize kubeadm cluster on first boot."""
    log_info(f"Initializing kubeadm cluster (v{K8S_VERSION})")

    Path(DATA_DIR).mkdir(parents=True, exist_ok=True)
    run_cmd(["systemctl", "start", "containerd"])
    log_info("containerd started")

    ensure_ecr_credential_provider()

    private_ip = get_imds_value("local-ipv4")
    if not private_ip:
        raise RuntimeError("Failed to retrieve private IP from IMDS")

    Path("/etc/sysconfig").mkdir(parents=True, exist_ok=True)
    Path("/etc/sysconfig/kubelet").write_text(
        "KUBELET_EXTRA_ARGS="
        "--cloud-provider=external"
        f" --node-ip={private_ip}"
        f" --image-credential-provider-config={ECR_PROVIDER_CONFIG}"
        " --image-credential-provider-bin-dir=/usr/local/bin\n"
    )
    log_info(f"Kubelet args configured: cloud-provider=external, node-ip={private_ip}")

    public_ip = get_imds_value("public-ipv4")
    instance_id = get_imds_value("instance-id")

    log_info("Running kubeadm init...")
    _update_dns_record(private_ip)

    api_endpoint = f"{API_DNS_NAME}:6443"
    init_cmd = [
        "kubeadm", "init",
        f"--kubernetes-version={K8S_VERSION}",
        f"--pod-network-cidr={POD_CIDR}",
        f"--service-cidr={SERVICE_CIDR}",
        f"--control-plane-endpoint={api_endpoint}",
        f"--apiserver-cert-extra-sans=127.0.0.1,{private_ip},{API_DNS_NAME}"
        + (f",{public_ip}" if public_ip else ""),
        "--upload-certs",
    ]
    run_cmd(init_cmd, capture=False, timeout=300)

    Path("/root/.kube").mkdir(parents=True, exist_ok=True)
    run_cmd(["cp", "-f", ADMIN_CONF, "/root/.kube/config"])
    run_cmd(["chmod", "600", "/root/.kube/config"])
    if Path(SUPER_ADMIN_CONF).exists():
        run_cmd(["cp", "-f", SUPER_ADMIN_CONF, "/root/.kube/super-admin.conf"])
        run_cmd(["chmod", "600", "/root/.kube/super-admin.conf"])

    result = run_cmd(["id", "ssm-user"], check=False)
    if result.returncode == 0:
        Path("/home/ssm-user/.kube").mkdir(parents=True, exist_ok=True)
        run_cmd(["cp", "-f", ADMIN_CONF, "/home/ssm-user/.kube/config"])
        run_cmd(["chown", "ssm-user:ssm-user", "/home/ssm-user/.kube/config"])
        run_cmd(["chmod", "600", "/home/ssm-user/.kube/config"])
        log_info("Kubeconfig set up for ssm-user")

    log_info("Waiting for control plane to be ready...")
    for i in range(1, 91):
        result = run_cmd(
            ["kubectl", "get", "nodes"],
            check=False, env=_bootstrap_kubeconfig_env(),
        )
        if result.returncode == 0:
            log_info(f"Control plane is ready (waited {i} seconds)")
            break
        if i == 90:
            log_warn("Control plane did not become ready in 90s")
        time.sleep(1)

    log_info("Control plane taint preserved — only Traefik + system pods will run here")
    _label_control_plane_node()

    # Set providerID immediately so the AWS CCM can map this node
    # to its EC2 instance — required for auto-deletion of dead nodes.
    # Control plane uses admin kubeconfig (kubelet.conf not yet trusted).
    patch_provider_id(kubeconfig="/root/.kube/config")

    _publish_ssm_params(private_ip, public_ip, instance_id)
    _publish_kubeconfig_to_ssm()
    _backup_certificates()


def _publish_ssm_params(private_ip: str, public_ip: str, instance_id: str) -> None:
    """Publish join token, CA hash, and endpoint to SSM."""
    log_info("Publishing cluster credentials to SSM...")

    token_result = run_cmd(
        ["kubeadm", "token", "create", "--ttl", "24h"],
        env=_bootstrap_kubeconfig_env(),
    )
    # Validate token format before writing to SSM — catches corruption at source
    join_token = validate_kubeadm_token(
        token_result.stdout.strip(), source="kubeadm token create"
    )
    log_info(f"Join token created and validated (length={len(join_token)})")

    ca_hash_cmd = (
        "openssl x509 -pubkey -in /etc/kubernetes/pki/ca.crt | "
        "openssl rsa -pubin -outform der 2>/dev/null | "
        "openssl dgst -sha256 -hex | awk '{print $2}'"
    )
    ca_result = run_cmd(ca_hash_cmd, shell=True)
    ca_hash = ca_result.stdout.strip()

    api_endpoint = f"{API_DNS_NAME}:6443"
    ssm_put(f"{SSM_PREFIX}/join-token", join_token, param_type="SecureString")
    ssm_put(f"{SSM_PREFIX}/ca-hash", f"sha256:{ca_hash}")
    ssm_put(f"{SSM_PREFIX}/control-plane-endpoint", api_endpoint)
    ssm_put(f"{SSM_PREFIX}/instance-id", instance_id)

    log_info("Cluster credentials published to SSM successfully")
    run_cmd(["kubectl", "get", "nodes", "-o", "wide"], check=False, env=_bootstrap_kubeconfig_env())


def _publish_kubeconfig_to_ssm() -> None:
    """Store a tunnel-ready kubeconfig in SSM for developer access.

    Reads /etc/kubernetes/admin.conf, rewrites the server address to
    https://127.0.0.1:6443 (for SSM port-forwarding tunnel), and stores
    the result as an SSM SecureString parameter. This enables developers
    to run `just k8s-fetch-kubeconfig` to restore cluster access after
    any control plane rebuild.
    """
    admin_conf = Path(ADMIN_CONF)
    if not admin_conf.exists():
        log_warn(f"{ADMIN_CONF} not found — skipping kubeconfig publish")
        return

    kubeconfig_content = admin_conf.read_text()

    # Rewrite the server address so the kubeconfig works through the SSM tunnel
    # Original: server: https://k8s-api.k8s.internal:6443 (or private IP)
    # Rewritten: server: https://127.0.0.1:6443
    tunnel_kubeconfig = re.sub(
        r"server:\s*https?://[^:]+:6443",
        "server: https://127.0.0.1:6443",
        kubeconfig_content,
    )

    ssm_path = f"{SSM_PREFIX}/kubeconfig"
    log_info(f"Publishing tunnel-ready kubeconfig to SSM: {ssm_path}")
    ssm_put(ssm_path, tunnel_kubeconfig, param_type="SecureString", tier="Advanced")


def _backup_certificates() -> None:
    """Archive /etc/kubernetes/pki/ to S3 for disaster recovery.

    Called after kubeadm init and on certificate renewal. The archive
    preserves the cluster's CA identity — without it, recovering from
    a lost EBS volume requires all workers to rejoin with new certs.

    S3 path: s3://<bucket>/dr-backups/pki/<timestamp>.tar.gz
    """
    if not S3_BUCKET:
        log_warn("S3_BUCKET not set — skipping certificate backup")
        return

    pki_dir = Path("/etc/kubernetes/pki")
    if not pki_dir.exists():
        log_warn("PKI directory not found — skipping certificate backup")
        return

    timestamp = time.strftime("%Y%m%d-%H%M%S")
    archive_path = f"/tmp/k8s-pki-{timestamp}.tar.gz"

    try:
        log_info("Backing up PKI certificates to S3...")
        run_cmd(["tar", "czf", archive_path, "-C", "/etc/kubernetes", "pki"])

        s3_key = f"{DR_BACKUP_PREFIX}/pki/{timestamp}.tar.gz"
        run_cmd([
            "aws", "s3", "cp", archive_path,
            f"s3://{S3_BUCKET}/{s3_key}",
            "--sse", "AES256", "--region", AWS_REGION,
        ])

        # Maintain a 'latest' pointer for easy restore
        run_cmd([
            "aws", "s3", "cp", archive_path,
            f"s3://{S3_BUCKET}/{DR_BACKUP_PREFIX}/pki/latest.tar.gz",
            "--sse", "AES256", "--region", AWS_REGION,
        ])

        log_info(f"✓ PKI certificates backed up to s3://{S3_BUCKET}/{s3_key}")
    except Exception as err:
        log_error(f"Certificate backup failed: {err}")
        log_warn("Continuing bootstrap — backup failure is non-fatal")
    finally:
        if Path(archive_path).exists():
            os.remove(archive_path)


# =============================================================================
# Step 2 — Restore from S3 Backup (Disaster Recovery)
# =============================================================================

def _s3_object_exists(s3_path: str) -> bool:
    """Check if an S3 object exists without downloading it."""
    result = run_cmd(
        ["aws", "s3", "ls", s3_path, "--region", AWS_REGION],
        check=False,
    )
    return result.returncode == 0 and bool(result.stdout.strip())


def _restore_certificates() -> bool:
    """Download and extract PKI certificates from S3.

    Returns True if certificates were restored successfully.
    """
    s3_path = f"s3://{S3_BUCKET}/{DR_BACKUP_PREFIX}/pki/latest.tar.gz"
    if not _s3_object_exists(s3_path):
        log_warn("No PKI backup found in S3 — fresh init will generate new certs")
        return False

    archive_path = "/tmp/k8s-pki-restore.tar.gz"
    try:
        log_info(f"Downloading PKI backup from {s3_path}...")
        run_cmd([
            "aws", "s3", "cp", s3_path, archive_path,
            "--region", AWS_REGION,
        ])

        pki_dir = Path("/etc/kubernetes/pki")
        pki_dir.mkdir(parents=True, exist_ok=True)
        run_cmd(["tar", "xzf", archive_path, "-C", "/etc/kubernetes"])

        log_info("✓ PKI certificates restored from S3 backup")
        return True
    except Exception as err:
        log_error(f"Certificate restore failed: {err}")
        return False
    finally:
        if Path(archive_path).exists():
            os.remove(archive_path)


def _restore_etcd_snapshot() -> bool:
    """Download and prepare etcd snapshot for kubeadm init.

    Restores the etcd data directory so kubeadm init finds existing
    etcd data and preserves all Kubernetes objects.

    Returns True if etcd was restored successfully.
    """
    s3_path = f"s3://{S3_BUCKET}/{DR_BACKUP_PREFIX}/etcd/latest.db"
    if not _s3_object_exists(s3_path):
        log_warn("No etcd backup found in S3 — fresh init will start empty")
        return False

    snapshot_path = "/tmp/etcd-restore.db"
    etcd_data_dir = f"{DATA_DIR}/etcd"

    try:
        log_info(f"Downloading etcd snapshot from {s3_path}...")
        run_cmd([
            "aws", "s3", "cp", s3_path, snapshot_path,
            "--region", AWS_REGION,
        ])

        # Resolve etcdctl — prefer binary, fall back to container
        etcdctl = shutil.which("etcdctl")
        if not etcdctl:
            log_warn("etcdctl not found on PATH — attempting restore via container")
            # etcdctl may be available after kubeadm images are pulled
            etcdctl = "etcdctl"

        log_info(f"Restoring etcd snapshot to {etcd_data_dir}...")
        env = {"ETCDCTL_API": "3"}
        run_cmd([
            etcdctl, "snapshot", "restore", snapshot_path,
            "--data-dir", etcd_data_dir,
            "--skip-hash-check",
        ], env=env)

        log_info(f"✓ etcd snapshot restored to {etcd_data_dir}")
        return True
    except Exception as err:
        log_error(f"etcd restore failed: {err}")
        # Clean up partial restore so kubeadm init starts fresh
        if Path(etcd_data_dir).exists():
            shutil.rmtree(etcd_data_dir, ignore_errors=True)
        return False
    finally:
        if Path(snapshot_path).exists():
            os.remove(snapshot_path)


def step_restore_from_backup() -> None:
    """Step 2: Restore etcd + certificates from S3 if EBS is empty.

    This step enables Scenario B disaster recovery:
    - If admin.conf exists (EBS has data) → skip (normal self-healing)
    - If admin.conf missing AND S3 backups exist → restore before init
    - If admin.conf missing AND no S3 backups → skip (fresh init)

    Must run BEFORE step_init_kubeadm so that kubeadm init finds
    the restored certificates and etcd data.
    """
    with StepRunner("restore-backup", skip_if=DR_RESTORE_MARKER) as step:
        if step.skipped:
            return

        # If admin.conf exists, the EBS volume has data — no restore needed
        if Path(ADMIN_CONF).exists():
            log_info("admin.conf exists — EBS volume has data, skipping DR restore")
            step.details["action"] = "skipped_ebs_has_data"
            return

        if not S3_BUCKET:
            log_warn("S3_BUCKET not set — cannot check for backups")
            step.details["action"] = "skipped_no_bucket"
            return

        log_info("EBS volume appears empty — checking S3 for DR backups...")

        # Restore certificates first (required for etcd restore)
        certs_restored = _restore_certificates()
        step.details["certs_restored"] = certs_restored

        # Restore etcd snapshot
        etcd_restored = _restore_etcd_snapshot()
        step.details["etcd_restored"] = etcd_restored

        if certs_restored or etcd_restored:
            log_info(
                "DR restore complete — kubeadm init will use restored data\n"
                f"  Certificates: {'✓ restored' if certs_restored else '✗ not found'}\n"
                f"  etcd data:    {'✓ restored' if etcd_restored else '✗ not found'}"
            )
            step.details["action"] = "restored"
        else:
            log_info("No S3 backups found — kubeadm init will start fresh")
            step.details["action"] = "fresh_init"


def step_init_kubeadm() -> None:
    """Step 3: Initialize kubeadm control plane."""
    with StepRunner("init-kubeadm", skip_if=ADMIN_CONF) as step:
        if step.skipped:
            _handle_second_run()
            return

        _init_cluster()
        step.details["k8s_version"] = K8S_VERSION
        step.details["pod_cidr"] = POD_CIDR
        step.details["service_cidr"] = SERVICE_CIDR


# =============================================================================
# Step 4 — Install Calico CNI
# =============================================================================

CACHED_OPERATOR = "/opt/calico/tigera-operator.yaml"

CALICO_INSTALLATION = f"""apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  calicoNetwork:
    bgp: Disabled
    ipPools:
      - cidr: {POD_CIDR}
        encapsulation: VXLAN
        natOutgoing: Enabled
        nodeSelector: all()
    linuxDataplane: Iptables
"""


def step_install_calico() -> None:
    """Step 4: Install Calico CNI via Tigera operator."""
    with StepRunner("install-calico", skip_if=CALICO_MARKER) as step:
        if step.skipped:
            return

        # Install operator
        if Path(CACHED_OPERATOR).exists():
            log_info("Using pre-cached operator from Golden AMI")
            source = CACHED_OPERATOR
        else:
            log_warn("Pre-cached operator not found, downloading from GitHub")
            source = (
                f"https://raw.githubusercontent.com/projectcalico/calico/"
                f"{CALICO_VERSION}/manifests/tigera-operator.yaml"
            )

        run_cmd(
            ["kubectl", "apply", "--server-side", "--force-conflicts", "-f", source],
            env=_bootstrap_kubeconfig_env(),
        )

        log_info("Waiting for Calico operator deployment...")
        run_cmd(
            ["kubectl", "wait", "--for=condition=Available",
             "deployment/tigera-operator", "-n", "tigera-operator",
             "--timeout=120s"],
            check=False, env=_bootstrap_kubeconfig_env(),
        )

        # Apply Installation CR
        log_info("Applying Calico Installation resource...")
        run_cmd(
            f"echo '{CALICO_INSTALLATION}' | kubectl apply -f -",
            shell=True, env=_bootstrap_kubeconfig_env(),
        )

        # Wait for pods
        log_info("Waiting for Calico pods to become ready...")
        for i in range(1, 121):
            result = run_cmd(
                ["kubectl", "get", "pods", "-n", "calico-system", "--no-headers"],
                check=False, env=_bootstrap_kubeconfig_env(),
            )
            if result.returncode == 0 and result.stdout.strip():
                lines = result.stdout.strip().splitlines()
                total = len(lines)
                running = sum(1 for line in lines if "Running" in line)
                if total > 0 and running == total:
                    log_info(f"Calico pods ready ({running}/{total}, waited {i}s)")
                    break
                if i == 120:
                    log_warn(f"Calico pods not fully ready after 120s ({running}/{total})")
                    run_cmd(
                        ["kubectl", "get", "pods", "-n", "calico-system"],
                        check=False, env=_bootstrap_kubeconfig_env(),
                    )
            time.sleep(1)

        step.details["calico_version"] = CALICO_VERSION
        step.details["pod_cidr"] = POD_CIDR
        log_info("Calico CNI installed successfully")


# =============================================================================
# Step 4b — Install AWS Cloud Controller Manager
# =============================================================================

CCM_HELM_REPO = "https://kubernetes.github.io/cloud-provider-aws"
CCM_HELM_RELEASE = "aws-cloud-controller-manager"
CCM_HELM_CHART = "aws-cloud-controller-manager"
CCM_HELM_NAMESPACE = "kube-system"
CCM_TAINT_TIMEOUT_SECONDS = 120

# Helm values mirroring the ArgoCD Application manifest
# (kubernetes-app/platform/argocd-apps/aws-cloud-controller-manager.yaml)
CCM_HELM_VALUES = """\
args:
  - --v=2
  - --cloud-provider=aws
  - --configure-cloud-routes=false
nodeSelector:
  node-role.kubernetes.io/control-plane: ""
tolerations:
  - key: node-role.kubernetes.io/control-plane
    effect: NoSchedule
  - key: node.cloudprovider.kubernetes.io/uninitialized
    value: "true"
    effect: NoSchedule
hostNetworking: true
"""


def step_install_ccm() -> None:
    """Step 4b: Install AWS Cloud Controller Manager via Helm.

    The CCM removes the 'node.cloudprovider.kubernetes.io/uninitialized'
    taint from nodes, which is required before any pods (including ArgoCD
    and CoreDNS) can be scheduled.

    Installing the CCM here — after Calico networking is ready but before
    ArgoCD bootstrap — breaks the otherwise circular dependency:
      - Kubelet starts with --cloud-provider=external → nodes are tainted
      - CCM removes the taint → pods can schedule
      - ArgoCD can start → remaining platform apps deploy

    ArgoCD will adopt the Helm release on subsequent syncs via the
    aws-cloud-controller-manager Application (sync-wave 2, selfHeal: true).

    Idempotent: skips if the marker file already exists.
    """
    with StepRunner("install-ccm", skip_if=CCM_MARKER) as step:
        if step.skipped:
            return

        # Write Helm values to a temporary file
        values_path = Path("/tmp/ccm-values.yaml")
        values_path.write_text(CCM_HELM_VALUES)

        try:
            # Add the Helm repo
            log_info("Adding cloud-provider-aws Helm repo...")
            run_cmd(
                ["helm", "repo", "add", "aws-cloud-controller-manager",
                 CCM_HELM_REPO, "--force-update"],
                env=_bootstrap_kubeconfig_env(),
            )
            run_cmd(["helm", "repo", "update"], env=_bootstrap_kubeconfig_env())

            # Install (or upgrade if already present) the CCM
            log_info("Installing AWS Cloud Controller Manager...")
            run_cmd(
                ["helm", "upgrade", "--install",
                 CCM_HELM_RELEASE, f"aws-cloud-controller-manager/{CCM_HELM_CHART}",
                 "--namespace", CCM_HELM_NAMESPACE,
                 "--values", str(values_path),
                 "--wait", "--timeout", "120s"],
                env=_bootstrap_kubeconfig_env(),
            )
            log_info("✓ AWS CCM Helm release installed")

            # Wait for the 'uninitialized' taint to be removed
            log_info("Waiting for CCM to remove the 'uninitialized' taint...")
            taint_removed = False
            for i in range(1, CCM_TAINT_TIMEOUT_SECONDS + 1):
                result = run_cmd(
                    ["kubectl", "get", "nodes", "-o",
                     "jsonpath={.items[*].spec.taints}"],
                    check=False, env=_bootstrap_kubeconfig_env(),
                )
                if result.returncode == 0:
                    taints_json = result.stdout.strip()
                    if "node.cloudprovider.kubernetes.io/uninitialized" not in taints_json:
                        log_info(
                            f"✓ 'uninitialized' taint removed from all nodes "
                            f"(waited {i}s)"
                        )
                        taint_removed = True
                        break
                time.sleep(1)

            if not taint_removed:
                log_warn(
                    f"'uninitialized' taint still present after "
                    f"{CCM_TAINT_TIMEOUT_SECONDS}s — ArgoCD may fail to schedule. "
                    f"Check CCM pod logs: kubectl logs -n kube-system "
                    f"-l app.kubernetes.io/name=aws-cloud-controller-manager"
                )

            step.details["helm_release"] = CCM_HELM_RELEASE
            step.details["taint_removed"] = taint_removed
            log_info("AWS Cloud Controller Manager installed successfully")

        finally:
            # Clean up temporary values file
            if values_path.exists():
                values_path.unlink()


# =============================================================================
# Step 5 — Configure kubectl Access
# =============================================================================

KUBECTL_USERS = [
    {"name": "root", "home": "/root"},
    {"name": "ec2-user", "home": "/home/ec2-user"},
]

SSM_KUBECONFIG_SCRIPT = """\
#!/bin/bash
# One-shot: copy kubeconfig for ssm-user on first SSM session
if [ "$(whoami)" = "ssm-user" ] && [ ! -f "$HOME/.kube/config" ]; then
    mkdir -p "$HOME/.kube"
    sudo cp -f /etc/kubernetes/admin.conf "$HOME/.kube/config"
    sudo chown "$(id -u):$(id -g)" "$HOME/.kube/config"
    chmod 600 "$HOME/.kube/config"
fi
"""

BASHRC_KUBECONFIG = """
# --- Kubernetes kubeconfig (added by bootstrap) ---
export KUBECONFIG=/etc/kubernetes/admin.conf
"""


def step_configure_kubectl() -> None:
    """Step 5: Set up kubectl access for root, ec2-user, and ssm-user."""
    with StepRunner("configure-kubectl") as step:
        if step.skipped:
            return

        log_info("Configuring kubectl access...")

        for user in KUBECTL_USERS:
            kube_dir = Path(user["home"]) / ".kube"
            kube_dir.mkdir(parents=True, exist_ok=True)
            config_path = kube_dir / "config"
            run_cmd(["cp", "-f", ADMIN_CONF, str(config_path)])
            if user["name"] != "root":
                run_cmd(["chown", f"{user['name']}:{user['name']}", str(config_path)])
            run_cmd(["chmod", "600", str(config_path)])
            log_info(f"  ✓ kubeconfig for {user['name']}")

        # ssm-user
        result = run_cmd(["id", "ssm-user"], check=False)
        if result.returncode != 0:
            log_info("  ssm-user does not exist — creating it now")
            run_cmd(["useradd", "--system", "--shell", "/bin/bash",
                     "--create-home", "--home-dir", "/home/ssm-user",
                     "ssm-user"], check=False)

        ssm_kube_dir = Path("/home/ssm-user/.kube")
        ssm_kube_dir.mkdir(parents=True, exist_ok=True)
        ssm_config = ssm_kube_dir / "config"
        run_cmd(["cp", "-f", ADMIN_CONF, str(ssm_config)])
        run_cmd(["chown", "ssm-user:ssm-user", str(ssm_config)])
        run_cmd(["chmod", "600", str(ssm_config)])
        log_info("  ✓ kubeconfig for ssm-user")

        script_path = Path("/usr/local/bin/setup-ssm-kubeconfig.sh")
        script_path.write_text(SSM_KUBECONFIG_SCRIPT)
        run_cmd(["chmod", "755", str(script_path)])

        bashrc = Path("/etc/bashrc")
        if bashrc.exists():
            content = bashrc.read_text()
            if "setup-ssm-kubeconfig" not in content:
                with bashrc.open("a") as f:
                    f.write(
                        '[ -x /usr/local/bin/setup-ssm-kubeconfig.sh ] '
                        '&& /usr/local/bin/setup-ssm-kubeconfig.sh\n'
                    )

        # Global kubeconfig
        profile_d = Path("/etc/profile.d/kubernetes.sh")
        profile_d.write_text(f"export KUBECONFIG={ADMIN_CONF}\n")
        run_cmd(["chmod", "644", str(profile_d)])

        if bashrc.exists():
            content = bashrc.read_text()
            if "KUBECONFIG=" not in content:
                with bashrc.open("a") as f:
                    f.write(BASHRC_KUBECONFIG)
        log_info("  ✓ Global KUBECONFIG configured (profile.d + bashrc)")

        os.environ["KUBECONFIG"] = ADMIN_CONF
        run_cmd(["kubectl", "cluster-info"], check=False)
        run_cmd(["kubectl", "get", "namespaces"], check=False)
        log_info("kubectl access configured successfully")


# =============================================================================
# Step 6 — Sync Bootstrap Manifests from S3
# =============================================================================

S3_MAX_RETRIES = 15
S3_RETRY_INTERVAL = 20


def step_sync_manifests() -> None:
    """Step 6: Download bootstrap manifests from S3 with patient retry."""
    with StepRunner("sync-manifests") as step:
        if step.skipped:
            return

        if not S3_BUCKET:
            raise RuntimeError("S3_BUCKET environment variable is required")

        bootstrap_dir = Path(MOUNT_POINT) / "k8s-bootstrap"
        bootstrap_dir.mkdir(parents=True, exist_ok=True)
        s3_prefix = f"s3://{S3_BUCKET}/k8s-bootstrap/"

        found = False
        for attempt in range(1, S3_MAX_RETRIES + 1):
            ls_result = run_cmd(
                ["aws", "s3", "ls", s3_prefix, "--recursive",
                 "--region", AWS_REGION],
                check=False,
            )

            if ls_result.returncode == 0 and ls_result.stdout.strip():
                obj_count = len(ls_result.stdout.strip().splitlines())
                log_info(
                    f"✓ Found {obj_count} objects in S3 bootstrap "
                    f"(attempt {attempt}/{S3_MAX_RETRIES})"
                )

                run_cmd(
                    ["aws", "s3", "sync", s3_prefix, str(bootstrap_dir) + "/",
                     "--region", AWS_REGION],
                )

                for sh_file in bootstrap_dir.rglob("*.sh"):
                    sh_file.chmod(0o755)
                for py_file in bootstrap_dir.rglob("*.py"):
                    py_file.chmod(0o755)

                log_info(f"Bootstrap bundle downloaded: {bootstrap_dir}")
                found = True
                break

            log_info(
                f"No manifests in S3 yet "
                f"(attempt {attempt}/{S3_MAX_RETRIES}). "
                f"Retrying in {S3_RETRY_INTERVAL}s..."
            )
            time.sleep(S3_RETRY_INTERVAL)

        if not found:
            log_warn(
                f"No manifests found in S3 after "
                f"{S3_MAX_RETRIES * S3_RETRY_INTERVAL}s. "
                f"ArgoCD bootstrap will be skipped — run manually when "
                f"S3 content is available."
            )

        step.details["manifests_found"] = found
        step.details["s3_bucket"] = S3_BUCKET
        step.details["bootstrap_dir"] = str(bootstrap_dir)


# =============================================================================
# Step 7 — Bootstrap ArgoCD
# =============================================================================

def step_bootstrap_argocd() -> None:
    """Step 7: Install ArgoCD and apply App-of-Apps root application."""
    with StepRunner("bootstrap-argocd") as step:
        if step.skipped:
            return

        bootstrap_dir = Path(MOUNT_POINT) / "k8s-bootstrap"
        argocd_dir = bootstrap_dir / "system" / "argocd"
        bootstrap_script = argocd_dir / "bootstrap-argocd.sh"

        if not bootstrap_script.exists():
            log_warn(
                f"ArgoCD bootstrap script not found at {bootstrap_script}. "
                f"Manifests may not have been synced from S3 yet."
            )
            raise FileNotFoundError(f"Missing: {bootstrap_script}")

        env = {
            "KUBECONFIG": ADMIN_CONF,
            "ARGOCD_DIR": str(argocd_dir),
        }

        log_info(f"Executing ArgoCD bootstrap: {bootstrap_script}")
        run_cmd(
            [str(bootstrap_script)],
            env=env,
            capture=False,
            timeout=800,
        )

        log_info(
            "ArgoCD bootstrap complete. "
            "ArgoCD now manages: traefik, metrics-server, "
            "aws-ebs-csi-driver, monitoring, nextjs"
        )
        step.details["argocd_dir"] = str(argocd_dir)


# =============================================================================
# Step 8 — Verify Cluster
# =============================================================================

REQUIRED_NAMESPACES = [
    "kube-system",
    "calico-system",
    "tigera-operator",
]


def step_verify_cluster() -> None:
    """Step 8: Lightweight post-boot health checks."""
    with StepRunner("verify-cluster") as step:
        if step.skipped:
            return

        results = {}

        # Node readiness
        log_info("Checking node readiness...")
        result = run_cmd(
            ["kubectl", "get", "nodes", "--no-headers"],
            check=False, env=_bootstrap_kubeconfig_env(),
        )
        node_ready = False
        if result.returncode == 0:
            for line in result.stdout.strip().splitlines():
                if "Ready" in line and "NotReady" not in line:
                    log_info(f"  ✓ Node ready: {line.split()[0]}")
                    node_ready = True
                    break
        if not node_ready:
            log_error("Node is not in Ready state")
        results["node_ready"] = node_ready

        # Core namespaces
        log_info("Checking namespace pods...")
        for ns in REQUIRED_NAMESPACES:
            result = run_cmd(
                ["kubectl", "get", "pods", "-n", ns, "--no-headers"],
                check=False, env=_bootstrap_kubeconfig_env(),
            )
            if result.returncode != 0 or not result.stdout.strip():
                log_warn(f"  ⚠ No pods found in namespace {ns}")
                results[f"ns_{ns}"] = True
                continue

            lines = result.stdout.strip().splitlines()
            total = len(lines)
            healthy = sum(
                1 for line in lines
                if "Running" in line or "Completed" in line
            )
            if healthy == total:
                log_info(f"  ✓ {ns}: {healthy}/{total} pods healthy")
                results[f"ns_{ns}"] = True
            else:
                log_warn(f"  ⚠ {ns}: {healthy}/{total} pods healthy")
                results[f"ns_{ns}"] = False

        # ArgoCD
        log_info("Checking ArgoCD...")
        result = run_cmd(
            ["kubectl", "get", "pods", "-n", "argocd", "--no-headers"],
            check=False, env=_bootstrap_kubeconfig_env(),
        )
        if result.returncode != 0 or not result.stdout.strip():
            log_warn("  ⚠ ArgoCD namespace not found or empty (may not be bootstrapped yet)")
            results["argocd"] = True
        else:
            lines = result.stdout.strip().splitlines()
            total = len(lines)
            running = sum(1 for line in lines if "Running" in line)
            log_info(f"  ✓ argocd: {running}/{total} pods running")
            results["argocd"] = running > 0

        step.details = results
        failures = [k for k, v in results.items() if not v]
        if failures:
            log_warn(f"Verification completed with warnings: {failures}")
        else:
            log_info("✓ All post-boot checks passed")


# =============================================================================
# Step 9 — Install CloudWatch Agent
# =============================================================================

# Step 9 — Install CloudWatch Agent
# Imported from common: step_install_cloudwatch_agent()


# =============================================================================
# Step 10 — Install etcd Backup Timer
# =============================================================================

DR_TIMER_MARKER = "/etc/systemd/system/etcd-backup.timer"


def step_install_etcd_backup() -> None:
    """Step 10: Set up hourly etcd backup to S3 via systemd timer.

    Installs the etcd-backup.sh script and creates a systemd timer
    that runs hourly. The initial backup runs immediately after
    installation.

    Idempotent: skips if the timer unit file already exists.
    """
    with StepRunner("install-etcd-backup", skip_if=DR_TIMER_MARKER) as step:
        if step.skipped:
            return

        # The DR scripts are synced from S3 as part of the bootstrap bundle
        bootstrap_dir = Path(MOUNT_POINT) / "k8s-bootstrap"
        installer = bootstrap_dir / "system" / "dr" / "install-etcd-backup-timer.sh"

        if not installer.exists():
            log_warn(
                f"etcd backup installer not found at {installer}. "
                f"DR scripts may not have been synced from S3 yet."
            )
            step.details["installed"] = False
            return

        log_info(f"Installing etcd backup timer: {installer}")
        run_cmd([str(installer)], capture=False, timeout=120)

        step.details["installed"] = True
        step.details["timer_unit"] = DR_TIMER_MARKER
        log_info("✓ etcd backup timer installed")


# =============================================================================
# Step 11 — Install Token Rotator Timer
# =============================================================================

TOKEN_ROTATOR_MARKER = "/etc/systemd/system/kubeadm-token-rotator.timer"

TOKEN_ROTATOR_SCRIPT = """\
#!/bin/bash
set -euo pipefail

# Generate a new token valid for 24 hours
export KUBECONFIG=/etc/kubernetes/admin.conf
TOKEN=$(kubeadm token create --ttl 24h)

# Validate token format before writing to SSM
if ! echo "$TOKEN" | grep -qE '^[a-z0-9]{{6}}\.[a-z0-9]{{16}}$'; then
    echo "ERROR: kubeadm token create returned invalid token: $TOKEN" >&2
    exit 1
fi

# Push the token to SSM
aws ssm put-parameter \\
    --name "{SSM_PREFIX}/join-token" \\
    --value "$TOKEN" \\
    --type "SecureString" \\
    --overwrite \\
    --region "{AWS_REGION}"

echo "Successfully rotated join token and updated SSM."
"""


def step_install_token_rotator() -> None:
    """Step 11: Install a systemd timer to rotate the kubeadm join token.

    Generates a new token every 12 hours and pushes it to SSM,
    ensuring workers can always join the cluster.
    """
    with StepRunner("install-token-rotator", skip_if=TOKEN_ROTATOR_MARKER) as step:
        if step.skipped:
            return

        script_path = Path("/usr/local/bin/rotate-join-token.sh")
        script_content = TOKEN_ROTATOR_SCRIPT.format(
            SSM_PREFIX=SSM_PREFIX,
            AWS_REGION=AWS_REGION,
        )
        script_path.write_text(script_content)
        run_cmd(["chmod", "755", str(script_path)])

        service_path = Path("/etc/systemd/system/kubeadm-token-rotator.service")
        service_path.write_text(
            "[Unit]\n"
            "Description=Rotate kubeadm join token and update SSM\n"
            "After=network-online.target\n\n"
            "[Service]\n"
            "Type=oneshot\n"
            "ExecStart=/usr/local/bin/rotate-join-token.sh\n"
        )

        timer_path = Path(TOKEN_ROTATOR_MARKER)
        timer_path.write_text(
            "[Unit]\n"
            "Description=Run kubeadm token rotator every 12 hours\n\n"
            "[Timer]\n"
            "OnBootSec=1h\n"
            "OnUnitActiveSec=12h\n"
            "RandomizedDelaySec=5m\n\n"
            "[Install]\n"
            "WantedBy=timers.target\n"
        )

        run_cmd(["systemctl", "daemon-reload"])
        run_cmd(["systemctl", "enable", "--now", "kubeadm-token-rotator.timer"])

        step.details["installed"] = True
        log_info("✓ kubeadm token rotator timer installed")


# =============================================================================
# Main — Sequential Control Plane Bootstrap
# =============================================================================

def main() -> None:
    """Execute all control plane bootstrap steps in order."""
    steps = [
        step_attach_ebs_volume,
        step_validate_ami,
        step_restore_from_backup,
        step_init_kubeadm,
        step_install_calico,
        step_install_ccm,
        step_configure_kubectl,
        step_sync_manifests,
        step_bootstrap_argocd,
        step_verify_cluster,
        step_install_cloudwatch_agent,
        step_install_etcd_backup,
        step_install_token_rotator,
    ]

    log_info(f"Control plane bootstrap starting ({len(steps)} steps)")
    for i, step_fn in enumerate(steps, 1):
        log_info(f"\n{'='*60}")
        log_info(f"Step {i}/{len(steps)}: {step_fn.__name__}")
        log_info(f"{'='*60}")
        step_fn()

    log_info("Control plane bootstrap complete")


if __name__ == "__main__":
    main()
