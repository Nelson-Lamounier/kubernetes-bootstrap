"""Step 10 — Set up hourly etcd backup to S3 via systemd timer."""
from __future__ import annotations

from pathlib import Path

from common import (
    StepRunner,
    log_info,
    log_warn,
    run_cmd,
)
from boot_helpers.config import BootConfig

# ── Constants ──────────────────────────────────────────────────────────────

DR_TIMER_MARKER = "/etc/systemd/system/etcd-backup.timer"


# ── Step ───────────────────────────────────────────────────────────────────

def step_install_etcd_backup(cfg: BootConfig) -> None:
    """Step 10: Set up hourly etcd backup to S3 via systemd timer.

    Installs the etcd-backup.sh script and creates a systemd timer
    that runs hourly. The initial backup runs immediately after
    installation.

    Idempotent: skips if the timer unit file already exists.

    Args:
        cfg: Bootstrap configuration.
    """
    with StepRunner("install-etcd-backup", skip_if=DR_TIMER_MARKER) as step:
        if step.skipped:
            return

        bootstrap_dir = Path(cfg.mount_point) / "k8s-bootstrap"
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
