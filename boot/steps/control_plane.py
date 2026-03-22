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
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import (
    StepRunner, run_cmd, ssm_get, ssm_put, log_info, log_warn, log_error,
    get_imds_value, ensure_ecr_credential_provider, ECR_PROVIDER_CONFIG,
    SSM_PREFIX as DEFAULT_SSM_PREFIX, AWS_REGION as DEFAULT_AWS_REGION,
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

ADMIN_CONF = "/etc/kubernetes/admin.conf"
KUBECONFIG_ENV = {"KUBECONFIG": ADMIN_CONF}
CALICO_MARKER = "/etc/kubernetes/.calico-installed"
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


# =============================================================================
# Step 1 — Validate Golden AMI
# =============================================================================

REQUIRED_BINARIES = ["containerd", "kubeadm", "kubelet", "kubectl", "helm"]
REQUIRED_KERNEL_MODULES = ["overlay", "br_netfilter"]
REQUIRED_SYSCTL = {
    "net.bridge.bridge-nf-call-iptables": "1",
    "net.bridge.bridge-nf-call-ip6tables": "1",
    "net.ipv4.ip_forward": "1",
}


def _validate_binaries() -> list[str]:
    """Check that all required binaries are on $PATH. Returns missing list."""
    missing = []
    found = []
    for binary in REQUIRED_BINARIES:
        path = shutil.which(binary)
        if path:
            found.append(f"{binary} -> {path}")
        else:
            missing.append(binary)
    for f in found:
        log_info(f"  ✓ {f}")
    return missing


def _validate_kernel_modules() -> list[str]:
    """Check kernel modules are loaded. Returns missing list."""
    missing = []
    try:
        loaded = Path("/proc/modules").read_text()
    except FileNotFoundError:
        log_error("/proc/modules not found — cannot validate kernel modules")
        return REQUIRED_KERNEL_MODULES

    for mod in REQUIRED_KERNEL_MODULES:
        if mod in loaded:
            log_info(f"  ✓ Kernel module: {mod}")
        else:
            missing.append(mod)
    return missing


def _validate_sysctl() -> list[str]:
    """Check sysctl settings. Returns misconfigured list."""
    errors = []
    for key, expected in REQUIRED_SYSCTL.items():
        sysctl_path = Path(f"/proc/sys/{key.replace('.', '/')}")
        try:
            actual = sysctl_path.read_text().strip()
            if actual == expected:
                log_info(f"  ✓ sysctl {key} = {actual}")
            else:
                errors.append(f"{key}: expected={expected}, actual={actual}")
        except FileNotFoundError:
            errors.append(f"{key}: not found at {sysctl_path}")
    return errors


def step_validate_ami() -> None:
    """Step 1: Validate Golden AMI binaries and kernel settings."""
    with StepRunner("validate-ami") as step:
        if step.skipped:
            return

        log_info("Checking required binaries...")
        missing_bins = _validate_binaries()
        step.details["binaries_checked"] = REQUIRED_BINARIES
        step.details["binaries_missing"] = missing_bins

        log_info("Checking kernel modules...")
        missing_mods = _validate_kernel_modules()
        step.details["modules_missing"] = missing_mods

        log_info("Checking sysctl settings...")
        sysctl_errors = _validate_sysctl()
        step.details["sysctl_errors"] = sysctl_errors

        errors = []
        if missing_bins:
            errors.append(f"Missing binaries: {', '.join(missing_bins)}")
        if missing_mods:
            errors.append(f"Missing kernel modules: {', '.join(missing_mods)}")
        if sysctl_errors:
            errors.append(f"Sysctl errors: {'; '.join(sysctl_errors)}")

        if errors:
            msg = (
                "Golden AMI validation FAILED.\n"
                "  The bootstrap script does NOT install packages at boot time.\n"
                "  All binaries must be pre-baked into the Golden AMI.\n\n"
                f"  Errors:\n" +
                "\n".join(f"    - {e}" for e in errors) +
                "\n\n  Resolution: Rebuild the Golden AMI with the missing components."
            )
            raise RuntimeError(msg)

        log_info("✓ Golden AMI validated — all required binaries and settings present")


# =============================================================================
# Step 2 — Initialize kubeadm Control Plane
# =============================================================================

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


def _handle_second_run() -> None:
    """Handle second-run: update DNS and refresh kubeconfig."""
    log_info("Cluster already initialized — running second-run maintenance")

    private_ip = get_imds_value("local-ipv4")
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

    result = run_cmd(
        ["kubectl", "get", "nodes"],
        check=False, env=KUBECONFIG_ENV,
    )
    if result.returncode != 0:
        log_warn("API server not responding — certs may need renewal + restart")
    else:
        log_info("API server healthy — second-run maintenance complete")


def _init_cluster() -> None:
    """Initialize kubeadm cluster on first boot."""
    log_info(f"Initializing kubeadm cluster (v{K8S_VERSION})")

    Path(DATA_DIR).mkdir(parents=True, exist_ok=True)
    run_cmd(["systemctl", "start", "containerd"])
    log_info("containerd started")

    ensure_ecr_credential_provider()

    Path("/etc/sysconfig").mkdir(parents=True, exist_ok=True)
    Path("/etc/sysconfig/kubelet").write_text(
        "KUBELET_EXTRA_ARGS="
        f"--image-credential-provider-config={ECR_PROVIDER_CONFIG}"
        " --image-credential-provider-bin-dir=/usr/local/bin\n"
    )
    log_info("Kubelet ECR credential provider args configured")

    private_ip = get_imds_value("local-ipv4")
    public_ip = get_imds_value("public-ipv4")
    instance_id = get_imds_value("instance-id")

    if not private_ip:
        raise RuntimeError("Failed to retrieve private IP from IMDS")

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
            check=False, env=KUBECONFIG_ENV,
        )
        if result.returncode == 0:
            log_info(f"Control plane is ready (waited {i} seconds)")
            break
        if i == 90:
            log_warn("Control plane did not become ready in 90s")
        time.sleep(1)

    log_info("Control plane taint preserved — only Traefik + system pods will run here")
    _publish_ssm_params(private_ip, public_ip, instance_id)
    _publish_kubeconfig_to_ssm()
    _backup_certificates()


def _publish_ssm_params(private_ip: str, public_ip: str, instance_id: str) -> None:
    """Publish join token, CA hash, and endpoint to SSM."""
    log_info("Publishing cluster credentials to SSM...")

    token_result = run_cmd(
        ["kubeadm", "token", "create", "--ttl", "24h"],
        env=KUBECONFIG_ENV,
    )
    join_token = token_result.stdout.strip()

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
    run_cmd(["kubectl", "get", "nodes", "-o", "wide"], check=False, env=KUBECONFIG_ENV)


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
            env=KUBECONFIG_ENV,
        )

        log_info("Waiting for Calico operator deployment...")
        run_cmd(
            ["kubectl", "wait", "--for=condition=Available",
             "deployment/tigera-operator", "-n", "tigera-operator",
             "--timeout=120s"],
            check=False, env=KUBECONFIG_ENV,
        )

        # Apply Installation CR
        log_info("Applying Calico Installation resource...")
        run_cmd(
            f"echo '{CALICO_INSTALLATION}' | kubectl apply -f -",
            shell=True, env=KUBECONFIG_ENV,
        )

        # Wait for pods
        log_info("Waiting for Calico pods to become ready...")
        for i in range(1, 121):
            result = run_cmd(
                ["kubectl", "get", "pods", "-n", "calico-system", "--no-headers"],
                check=False, env=KUBECONFIG_ENV,
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
                        check=False, env=KUBECONFIG_ENV,
                    )
            time.sleep(1)

        step.details["calico_version"] = CALICO_VERSION
        step.details["pod_cidr"] = POD_CIDR
        log_info("Calico CNI installed successfully")


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
            "local-path-provisioner, monitoring, nextjs"
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
            check=False, env=KUBECONFIG_ENV,
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
                check=False, env=KUBECONFIG_ENV,
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
            check=False, env=KUBECONFIG_ENV,
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

CW_MARKER_FILE = "/tmp/.cw-agent-installed"
CW_AGENT_CTL = "/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl"
CW_AGENT_CONFIG_PATH = "/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json"
K8S_ENV_FILE = "/etc/profile.d/k8s-env.sh"

CW_LOG_FILES = [
    {"file_path": "/var/log/messages", "log_stream_name": "{instance_id}/messages"},
    {"file_path": "/var/log/user-data.log", "log_stream_name": "{instance_id}/user-data"},
    {"file_path": "/var/log/cloud-init-output.log", "log_stream_name": "{instance_id}/cloud-init"},
]


def _resolve_log_group_name() -> str:
    """Resolve the CloudWatch log group name from environment or k8s-env.sh."""
    log_group = os.environ.get("LOG_GROUP_NAME", "")
    if log_group:
        return log_group

    env_file = Path(K8S_ENV_FILE)
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line.startswith("export LOG_GROUP_NAME="):
                value = line.split("=", 1)[1].strip().strip('"').strip("'")
                if value:
                    return value
    return ""


def step_install_cloudwatch_agent() -> None:
    """Step 9: Install and configure CloudWatch Agent for log streaming."""
    with StepRunner("install-cloudwatch-agent", skip_if=CW_MARKER_FILE) as step:
        if step.skipped:
            return

        log_group_name = _resolve_log_group_name()
        if not log_group_name:
            log_warn(
                "LOG_GROUP_NAME not found in environment or k8s-env.sh — "
                "skipping CloudWatch Agent installation"
            )
            step.details["skipped_reason"] = "LOG_GROUP_NAME not set"
            return

        log_info(f"Target log group: {log_group_name}")
        step.details["log_group_name"] = log_group_name

        log_info("Installing amazon-cloudwatch-agent...")
        result = run_cmd(
            "dnf install -y amazon-cloudwatch-agent 2>/dev/null || "
            "yum install -y amazon-cloudwatch-agent",
            shell=True, check=True, timeout=120,
        )
        step.details["install_exit_code"] = result.returncode

        collect_list = []
        for lf in CW_LOG_FILES:
            collect_list.append({
                "file_path": lf["file_path"],
                "log_group_name": log_group_name,
                "log_stream_name": lf["log_stream_name"],
                "retention_in_days": 30,
            })

        config = {
            "agent": {
                "metrics_collection_interval": 60,
                "logfile": "/opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log",
            },
            "logs": {
                "logs_collected": {
                    "files": {"collect_list": collect_list},
                },
            },
        }

        config_path = Path(CW_AGENT_CONFIG_PATH)
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(json.dumps(config, indent=2))
        log_info(f"Agent config written to {CW_AGENT_CONFIG_PATH}")
        step.details["log_files"] = [lf["file_path"] for lf in CW_LOG_FILES]

        log_info("Starting CloudWatch Agent...")
        run_cmd([
            CW_AGENT_CTL,
            "-a", "fetch-config",
            "-m", "ec2",
            "-c", f"file:{CW_AGENT_CONFIG_PATH}",
            "-s",
        ], timeout=60)

        result = run_cmd([CW_AGENT_CTL, "-a", "status"], check=False)
        if result.returncode == 0 and "running" in result.stdout.lower():
            log_info("CloudWatch Agent is running")
            step.details["agent_status"] = "running"
        else:
            log_warn("CloudWatch Agent may not be running — check agent logs")
            step.details["agent_status"] = "unknown"


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
        step_configure_kubectl,
        step_sync_manifests,
        step_bootstrap_argocd,
        step_verify_cluster,
        step_install_cloudwatch_agent,
        step_install_etcd_backup,
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
