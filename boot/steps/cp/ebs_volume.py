"""Step 0 — Attach, format, and mount the EBS data volume.

Handles:
- Idempotent re-runs (marker file + mountpoint check)
- ASG replacement (waits for volume to detach from old instance)
- NVMe device naming on Nitro instances
- First-boot formatting (only if volume has no filesystem)
- fstab entry for reboot persistence
"""
from __future__ import annotations

import glob
import json
import time
from pathlib import Path

from common import (
    StepRunner,
    get_imds_value,
    log_info,
    log_warn,
    run_cmd,
)
from boot_helpers.config import BootConfig

# ── Constants ──────────────────────────────────────────────────────────────

EBS_DEVICE_NAME = "/dev/xvdf"
EBS_FILESYSTEM = "ext4"
EBS_MAX_ATTACH_RETRIES = 30
EBS_RETRY_INTERVAL_SECONDS = 10
EBS_ATTACH_MARKER = "/etc/kubernetes/.ebs-attached"


# ── Helpers ────────────────────────────────────────────────────────────────

def resolve_nvme_device() -> str:
    """Resolve the NVMe device path for the attached EBS volume.

    On Nitro-based instances (t3, m5, c5, etc.), EBS volumes attached as
    /dev/xvdf appear as /dev/nvme<N>n1 in the kernel. This function finds
    the correct NVMe device by checking for any non-root NVMe block device.

    Returns:
        The device path (e.g. ``/dev/nvme1n1``) or empty string if not found.
    """
    if Path(EBS_DEVICE_NAME).exists():
        return EBS_DEVICE_NAME

    nvme_devices = sorted(glob.glob("/dev/nvme[1-9]n1"))
    if nvme_devices:
        return nvme_devices[0]

    return ""


def is_already_mounted(mount_point: str) -> bool:
    """Check if the mount point is already a mounted filesystem."""
    result = run_cmd(["mountpoint", "-q", mount_point], check=False)
    return result.returncode == 0


def describe_volume(volume_id: str, aws_region: str) -> dict:
    """Describe an EBS volume and return its state and attachment info.

    Returns:
        Dict with keys: ``state``, ``attached_instance``, ``device``.
    """
    result = run_cmd(
        ["aws", "ec2", "describe-volumes",
         "--volume-ids", volume_id,
         "--query", "Volumes[0].{State:State,Attachments:Attachments}",
         "--output", "json",
         "--region", aws_region],
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


def wait_for_volume_available(
    volume_id: str,
    instance_id: str,
    aws_region: str,
) -> str:
    """Wait for the EBS volume to become available for attachment.

    Handles ASG replacement: if the volume is still attached to the old
    (terminating) instance, this retries until it transitions to ``available``.

    Returns:
        ``available`` or ``already-attached``.

    Raises:
        RuntimeError: If the volume does not become available within the retry window.
    """
    for attempt in range(1, EBS_MAX_ATTACH_RETRIES + 1):
        info = describe_volume(volume_id, aws_region)
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


def attach_volume(volume_id: str, instance_id: str, aws_region: str) -> None:
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
         "--region", aws_region],
        check=True,
    )
    log_info(f"Attach command sent for {volume_id}")


def wait_for_device() -> str:
    """Wait for the block device to appear in the OS after attachment.

    Returns:
        The resolved device path (e.g. ``/dev/nvme1n1`` or ``/dev/xvdf``).

    Raises:
        RuntimeError: If the device does not appear within 60 seconds.
    """
    log_info("Waiting for block device to appear...")
    for i in range(1, 61):
        device = resolve_nvme_device()
        if device:
            log_info(f"Block device appeared: {device} (waited {i}s)")
            return device
        time.sleep(1)

    raise RuntimeError(
        f"Block device did not appear within 60s after attachment. "
        f"Expected {EBS_DEVICE_NAME} or /dev/nvme<N>n1. "
        f"Run 'lsblk' to inspect available devices."
    )


def format_if_needed(device: str) -> bool:
    """Format the EBS volume with ext4 if it has no filesystem.

    Returns:
        ``True`` if formatting was performed, ``False`` if already formatted.
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
    run_cmd(["mkfs", "-t", EBS_FILESYSTEM, device], check=True)
    log_info(f"Formatted {device} as {EBS_FILESYSTEM}")
    return True


def mount_volume(device: str, mount_point: str) -> None:
    """Mount the device and ensure persistence via fstab."""
    Path(mount_point).mkdir(parents=True, exist_ok=True)

    log_info(f"Mounting {device} at {mount_point}")
    run_cmd(["mount", device, mount_point], check=True)

    fstab = Path("/etc/fstab")
    fstab_content = fstab.read_text() if fstab.exists() else ""
    if mount_point not in fstab_content:
        entry = f"{device}  {mount_point}  {EBS_FILESYSTEM}  defaults,nofail  0  2\n"
        with fstab.open("a") as f:
            f.write(entry)
        log_info(f"fstab entry added: {entry.strip()}")
    else:
        log_info(f"fstab already contains entry for {mount_point}")


def ensure_data_directories(mount_point: str) -> None:
    """Create the required subdirectory structure on the data volume."""
    subdirs = ["kubernetes", "k8s-bootstrap", "app-deploy"]
    for subdir in subdirs:
        path = Path(mount_point) / subdir
        path.mkdir(parents=True, exist_ok=True)
    log_info(
        f"Data directories ensured: "
        f"{', '.join(str(Path(mount_point) / d) for d in subdirs)}"
    )


# ── Step ───────────────────────────────────────────────────────────────────

def step_attach_ebs_volume(cfg: BootConfig) -> None:
    """Step 0: Attach, format (if needed), and mount the EBS data volume.

    Args:
        cfg: Bootstrap configuration.
    """
    with StepRunner("attach-ebs-volume", skip_if=EBS_ATTACH_MARKER) as step:
        if step.skipped:
            return

        if not cfg.volume_id:
            log_warn(
                "VOLUME_ID not set — skipping EBS attachment. "
                "Kubernetes data will use the root volume (not persistent)."
            )
            step.details["action"] = "skipped_no_volume_id"
            return

        if is_already_mounted(cfg.mount_point):
            log_info(
                f"{cfg.mount_point} is already a mount point — "
                f"skipping attachment"
            )
            step.details["action"] = "skipped_already_mounted"
            ensure_data_directories(cfg.mount_point)
            return

        instance_id = get_imds_value("instance-id")
        if not instance_id:
            raise RuntimeError(
                "Failed to retrieve instance ID from IMDS. "
                "Cannot attach EBS volume without knowing the instance ID."
            )

        step.details["volume_id"] = cfg.volume_id
        step.details["instance_id"] = instance_id
        step.details["mount_point"] = cfg.mount_point

        availability = wait_for_volume_available(
            cfg.volume_id, instance_id, cfg.aws_region,
        )

        if availability == "available":
            attach_volume(cfg.volume_id, instance_id, cfg.aws_region)
            device = wait_for_device()
            step.details["action"] = "attached"
        else:
            device = resolve_nvme_device()
            if not device:
                device = wait_for_device()
            step.details["action"] = "already_attached"

        step.details["device"] = device

        formatted = format_if_needed(device)
        step.details["formatted"] = formatted

        mount_volume(device, cfg.mount_point)
        ensure_data_directories(cfg.mount_point)

        log_info(
            f"✓ EBS volume {cfg.volume_id} attached as {device}, "
            f"mounted at {cfg.mount_point}"
        )
