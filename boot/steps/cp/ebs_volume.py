"""Step 0 — Format and mount the launch-template-attached data volume.

The data volume (/dev/xvdf) is provisioned by the EC2 launch template's
block device mapping.  AWS attaches it automatically at instance launch,
so this step only needs to:

1. Detect the block device (handles NVMe renaming on Nitro instances).
2. Format with ext4 if it has no filesystem (first boot only).
3. Mount at the configured mount point and add an fstab entry.
4. Create the required subdirectory structure.

This replaces the legacy ``step_attach_ebs_volume`` which called the
``ec2:AttachVolume`` API to attach a CDK-managed ``ec2.Volume``.
"""
from __future__ import annotations

import glob
import time
from pathlib import Path

from common import (
    StepRunner,
    log_info,
    log_warn,
    run_cmd,
)
from boot_helpers.config import BootConfig

# ── Constants ──────────────────────────────────────────────────────────────

DATA_DEVICE_NAME = "/dev/xvdf"
DATA_FILESYSTEM = "ext4"
DATA_MOUNT_MARKER = "/etc/kubernetes/.data-mounted"

# Maximum seconds to wait for the block device to appear after boot.
# On Nitro instances the NVMe device is typically visible within 5–10s.
DEVICE_WAIT_TIMEOUT_SECONDS = 60


# ── Helpers ────────────────────────────────────────────────────────────────

def resolve_nvme_device() -> str:
    """Resolve the NVMe device path for the data volume.

    On Nitro-based instances (t3, m5, c5, etc.), EBS volumes attached as
    /dev/xvdf appear as /dev/nvme<N>n1 in the kernel.  This function finds
    the correct NVMe device by checking for any non-root NVMe block device.

    Returns:
        The device path (e.g. ``/dev/nvme1n1``) or empty string if not found.
    """
    if Path(DATA_DEVICE_NAME).exists():
        return DATA_DEVICE_NAME

    nvme_devices = sorted(glob.glob("/dev/nvme[1-9]n1"))
    if nvme_devices:
        return nvme_devices[0]

    return ""


def is_already_mounted(mount_point: str) -> bool:
    """Check if the mount point is already a mounted filesystem."""
    result = run_cmd(["mountpoint", "-q", mount_point], check=False)
    return result.returncode == 0


def wait_for_device() -> str:
    """Wait for the data block device to appear in the OS.

    The launch template attaches the volume at instance creation, but the
    kernel may take a few seconds to expose the NVMe device.

    Returns:
        The resolved device path (e.g. ``/dev/nvme1n1`` or ``/dev/xvdf``).

    Raises:
        RuntimeError: If the device does not appear within the timeout.
    """
    log_info("Waiting for data volume block device to appear...")
    for i in range(1, DEVICE_WAIT_TIMEOUT_SECONDS + 1):
        device = resolve_nvme_device()
        if device:
            log_info(f"Block device appeared: {device} (waited {i}s)")
            return device
        time.sleep(1)

    raise RuntimeError(
        f"Data volume block device did not appear within "
        f"{DEVICE_WAIT_TIMEOUT_SECONDS}s. "
        f"Expected {DATA_DEVICE_NAME} or /dev/nvme<N>n1. "
        f"Verify the launch template has a /dev/xvdf block device mapping. "
        f"Run 'lsblk' to inspect available devices."
    )


def format_if_needed(device: str) -> bool:
    """Format the volume with ext4 if it has no filesystem.

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

    log_info(f"No filesystem on {device} — formatting as {DATA_FILESYSTEM}")
    run_cmd(["mkfs", "-t", DATA_FILESYSTEM, device], check=True)
    log_info(f"Formatted {device} as {DATA_FILESYSTEM}")
    return True


def mount_volume(device: str, mount_point: str) -> None:
    """Mount the device and ensure persistence via fstab."""
    Path(mount_point).mkdir(parents=True, exist_ok=True)

    log_info(f"Mounting {device} at {mount_point}")
    run_cmd(["mount", device, mount_point], check=True)

    fstab = Path("/etc/fstab")
    fstab_content = fstab.read_text() if fstab.exists() else ""
    if mount_point not in fstab_content:
        entry = f"{device}  {mount_point}  {DATA_FILESYSTEM}  defaults,nofail  0  2\n"
        with fstab.open("a") as f:
            f.write(entry)
        log_info(f"fstab entry added: {entry.strip()}")
    else:
        log_info(f"fstab already contains entry for {mount_point}")


def ensure_data_directories(mount_point: str) -> None:
    """Create the required subdirectory structure on the data volume.

    Grants group-write access to the ``app-deploy`` subtree so that
    ``ssm-user`` (the SSM Session Manager user) can sync scripts directly
    via ``aws s3 cp`` without needing ``sudo``.  The SSM Run Command
    document runs as ``root``, so bootstrap writes are unaffected.
    """
    subdirs = ["kubernetes", "k8s-bootstrap", "app-deploy"]
    for subdir in subdirs:
        path = Path(mount_point) / subdir
        path.mkdir(parents=True, exist_ok=True)

    # Grant ssm-user write access to app-deploy so that interactive SSM
    # sessions (ssm-shell) can sync deploy.py scripts without a password.
    # SSM Run Command (root) is unaffected by this permission change.
    app_deploy = Path(mount_point) / "app-deploy"
    try:
        run_cmd(
            ["chown", "-R", "root:ssm-user", str(app_deploy)],
            check=False,
        )
        run_cmd(
            ["chmod", "-R", "g+w", str(app_deploy)],
            check=False,
        )
        log_info(
            f"✓ ssm-user granted group-write on {app_deploy} "
            f"(interactive script deployment enabled)"
        )
    except Exception as err:  # noqa: BLE001 — non-fatal; instance may not have ssm-user yet
        log_warn(f"Could not set group permissions on {app_deploy}: {err}")

    log_info(
        f"Data directories ensured: "
        f"{', '.join(str(Path(mount_point) / d) for d in subdirs)}"
    )


# ── Step ───────────────────────────────────────────────────────────────────

def step_mount_data_volume(cfg: BootConfig) -> None:
    """Step 0: Format (if needed) and mount the launch-template data volume.

    The data volume is auto-attached by AWS via the launch template block
    device mapping.  This step only formats + mounts — no EC2 API calls.

    Args:
        cfg: Bootstrap configuration.
    """
    with StepRunner("mount-data-volume", skip_if=DATA_MOUNT_MARKER) as step:
        if step.skipped:
            return

        # Already mounted (e.g. manual recovery or previous partial run)
        if is_already_mounted(cfg.mount_point):
            log_info(
                f"{cfg.mount_point} is already a mount point — "
                f"skipping mount"
            )
            step.details["action"] = "skipped_already_mounted"
            ensure_data_directories(cfg.mount_point)
            return

        # Wait for the block device to appear (NVMe renaming on Nitro)
        device = wait_for_device()
        step.details["device"] = device
        step.details["mount_point"] = cfg.mount_point

        # Format if this is a brand-new volume (first launch)
        formatted = format_if_needed(device)
        step.details["formatted"] = formatted

        # Mount and add fstab entry
        mount_volume(device, cfg.mount_point)

        # Ensure directory structure exists on the volume
        ensure_data_directories(cfg.mount_point)

        log_info(
            f"✓ Data volume mounted: {device} → {cfg.mount_point}"
        )
