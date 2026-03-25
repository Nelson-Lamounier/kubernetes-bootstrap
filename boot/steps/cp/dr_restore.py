"""Step 2 — Restore etcd + certificates from S3 (disaster recovery).

Enables Scenario B disaster recovery:
- If admin.conf exists (EBS has data) → skip (normal self-healing)
- If admin.conf missing AND S3 backups exist → restore before init
- If admin.conf missing AND no S3 backups → skip (fresh init)

Must run BEFORE ``step_init_kubeadm`` so that ``kubeadm init`` finds
the restored certificates and etcd data.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

from common import (
    StepRunner,
    log_error,
    log_info,
    log_warn,
    run_cmd,
)
from boot_helpers.config import BootConfig

# ── Constants ──────────────────────────────────────────────────────────────

ADMIN_CONF = "/etc/kubernetes/admin.conf"
DR_BACKUP_PREFIX = "dr-backups"
DR_RESTORE_MARKER = "/etc/kubernetes/.dr-restored"


# ── Helpers ────────────────────────────────────────────────────────────────

def s3_object_exists(s3_path: str, aws_region: str) -> bool:
    """Check if an S3 object exists without downloading it."""
    result = run_cmd(
        ["aws", "s3", "ls", s3_path, "--region", aws_region],
        check=False,
    )
    return result.returncode == 0 and bool(result.stdout.strip())


def restore_certificates(cfg: BootConfig) -> bool:
    """Download and extract PKI certificates from S3.

    Returns:
        ``True`` if certificates were restored successfully.
    """
    s3_path = f"s3://{cfg.s3_bucket}/{DR_BACKUP_PREFIX}/pki/latest.tar.gz"
    if not s3_object_exists(s3_path, cfg.aws_region):
        log_warn("No PKI backup found in S3 — fresh init will generate new certs")
        return False

    archive_path = "/tmp/k8s-pki-restore.tar.gz"
    try:
        log_info(f"Downloading PKI backup from {s3_path}...")
        run_cmd([
            "aws", "s3", "cp", s3_path, archive_path,
            "--region", cfg.aws_region,
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


def restore_etcd_snapshot(cfg: BootConfig) -> bool:
    """Download and prepare etcd snapshot for kubeadm init.

    Returns:
        ``True`` if etcd was restored successfully.
    """
    s3_path = f"s3://{cfg.s3_bucket}/{DR_BACKUP_PREFIX}/etcd/latest.db"
    if not s3_object_exists(s3_path, cfg.aws_region):
        log_warn("No etcd backup found in S3 — fresh init will start empty")
        return False

    snapshot_path = "/tmp/etcd-restore.db"
    etcd_data_dir = f"{cfg.data_dir}/etcd"

    try:
        log_info(f"Downloading etcd snapshot from {s3_path}...")
        run_cmd([
            "aws", "s3", "cp", s3_path, snapshot_path,
            "--region", cfg.aws_region,
        ])

        etcdctl = shutil.which("etcdctl")
        if not etcdctl:
            log_warn("etcdctl not found on PATH — attempting restore via container")
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
        if Path(etcd_data_dir).exists():
            shutil.rmtree(etcd_data_dir, ignore_errors=True)
        return False
    finally:
        if Path(snapshot_path).exists():
            os.remove(snapshot_path)


# ── Step ───────────────────────────────────────────────────────────────────

def step_restore_from_backup(cfg: BootConfig) -> None:
    """Step 2: Restore etcd + certificates from S3 if EBS is empty.

    Args:
        cfg: Bootstrap configuration.
    """
    with StepRunner("restore-backup", skip_if=DR_RESTORE_MARKER) as step:
        if step.skipped:
            return

        if Path(ADMIN_CONF).exists():
            log_info("admin.conf exists — EBS volume has data, skipping DR restore")
            step.details["action"] = "skipped_ebs_has_data"
            return

        if not cfg.s3_bucket:
            log_warn("S3_BUCKET not set — cannot check for backups")
            step.details["action"] = "skipped_no_bucket"
            return

        log_info("EBS volume appears empty — checking S3 for DR backups...")

        certs_restored = restore_certificates(cfg)
        step.details["certs_restored"] = certs_restored

        etcd_restored = restore_etcd_snapshot(cfg)
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
