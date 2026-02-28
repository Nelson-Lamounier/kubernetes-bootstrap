#!/usr/bin/env python3
"""
@format
Step 05 — Sync Bootstrap Manifests from S3

Downloads the k8s-bootstrap directory from S3 to the local data volume.
Uses a "patient retry" pattern for Day-1 coordination where the CI sync
job may not have uploaded manifests yet.

Idempotent: S3 sync is additive and overwrites changed files.

Expected environment variables:
    S3_BUCKET        — S3 bucket containing bootstrap content
    MOUNT_POINT      — Local mount point (default: /data)
    AWS_REGION       — AWS region
"""

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import StepRunner, run_cmd, log_info, log_warn

# =============================================================================
# Configuration
# =============================================================================

S3_BUCKET = os.environ.get("S3_BUCKET", "")
MOUNT_POINT = os.environ.get("MOUNT_POINT", "/data")
AWS_REGION = os.environ.get("AWS_REGION", "eu-west-1")

MAX_RETRIES = 15
RETRY_INTERVAL = 20  # seconds


# =============================================================================
# Logic
# =============================================================================

def sync_bootstrap_from_s3() -> bool:
    """
    Download k8s-bootstrap from S3 with patient retry.

    Returns True if manifests were found and synced, False if S3 was empty
    after all retries (non-fatal — ArgoCD bootstrap will be skipped).
    """
    bootstrap_dir = Path(MOUNT_POINT) / "k8s-bootstrap"
    bootstrap_dir.mkdir(parents=True, exist_ok=True)

    s3_prefix = f"s3://{S3_BUCKET}/k8s-bootstrap/"

    for attempt in range(1, MAX_RETRIES + 1):
        # Check if S3 prefix has objects
        ls_result = run_cmd(
            ["aws", "s3", "ls", s3_prefix, "--recursive",
             "--region", AWS_REGION],
            check=False,
        )

        if ls_result.returncode == 0 and ls_result.stdout.strip():
            obj_count = len(ls_result.stdout.strip().splitlines())
            log_info(
                f"✓ Found {obj_count} objects in S3 bootstrap "
                f"(attempt {attempt}/{MAX_RETRIES})"
            )

            # Sync
            run_cmd(
                ["aws", "s3", "sync", s3_prefix, str(bootstrap_dir) + "/",
                 "--region", AWS_REGION],
            )

            # Make scripts executable
            for sh_file in bootstrap_dir.rglob("*.sh"):
                sh_file.chmod(0o755)
            for py_file in bootstrap_dir.rglob("*.py"):
                py_file.chmod(0o755)

            log_info(f"Bootstrap bundle downloaded: {bootstrap_dir}")
            return True

        log_info(
            f"No manifests in S3 yet "
            f"(attempt {attempt}/{MAX_RETRIES}). "
            f"Retrying in {RETRY_INTERVAL}s..."
        )
        time.sleep(RETRY_INTERVAL)

    log_warn(
        f"No manifests found in S3 after "
        f"{MAX_RETRIES * RETRY_INTERVAL}s. "
        f"ArgoCD bootstrap will be skipped — run manually when "
        f"S3 content is available."
    )
    return False


# =============================================================================
# Main
# =============================================================================

def main() -> None:
    with StepRunner("sync-manifests") as step:
        if step.skipped:
            return

        if not S3_BUCKET:
            raise RuntimeError("S3_BUCKET environment variable is required")

        found = sync_bootstrap_from_s3()
        step.details["manifests_found"] = found
        step.details["s3_bucket"] = S3_BUCKET
        step.details["bootstrap_dir"] = str(Path(MOUNT_POINT) / "k8s-bootstrap")


if __name__ == "__main__":
    main()
