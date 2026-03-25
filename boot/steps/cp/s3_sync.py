"""Step 6 — Sync bootstrap manifests from S3 with patient retry."""
from __future__ import annotations

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

S3_MAX_RETRIES = 15
S3_RETRY_INTERVAL = 20


# ── Step ───────────────────────────────────────────────────────────────────

def step_sync_manifests(cfg: BootConfig) -> None:
    """Step 6: Download bootstrap manifests from S3 with patient retry.

    Args:
        cfg: Bootstrap configuration.
    """
    with StepRunner("sync-manifests") as step:
        if step.skipped:
            return

        if not cfg.s3_bucket:
            raise RuntimeError("S3_BUCKET environment variable is required")

        bootstrap_dir = Path(cfg.mount_point) / "k8s-bootstrap"
        bootstrap_dir.mkdir(parents=True, exist_ok=True)
        s3_prefix = f"s3://{cfg.s3_bucket}/k8s-bootstrap/"

        found = False
        for attempt in range(1, S3_MAX_RETRIES + 1):
            ls_result = run_cmd(
                ["aws", "s3", "ls", s3_prefix, "--recursive",
                 "--region", cfg.aws_region],
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
                     "--region", cfg.aws_region],
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
        step.details["s3_bucket"] = cfg.s3_bucket
        step.details["bootstrap_dir"] = str(bootstrap_dir)
