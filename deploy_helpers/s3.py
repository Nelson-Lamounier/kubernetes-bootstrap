"""S3 sync helper for deploy scripts.

Wraps the ``aws s3 sync`` CLI command to pull the latest manifests
from S3 before each deployment. The boto3 library does not provide
an equivalent high-level sync operation, so the CLI is used directly.

Usage::

    from deploy_helpers.s3 import sync_from_s3

    sync_from_s3(
        bucket="my-scripts-bucket",
        key_prefix="app-deploy/nextjs",
        target_dir="/data/app-deploy/nextjs",
        region="eu-west-1",
    )
"""

from __future__ import annotations

from pathlib import Path

from deploy_helpers.logging import log_info
from deploy_helpers.runner import run_cmd


def sync_from_s3(
    bucket: str,
    key_prefix: str,
    target_dir: str,
    region: str,
) -> None:
    """Sync deploy scripts from S3 to a local directory.

    Makes all ``.sh`` files executable after sync.

    Args:
        bucket: S3 bucket name.
        key_prefix: S3 key prefix (e.g. ``app-deploy/nextjs``).
        target_dir: Local directory to sync into.
        region: AWS region for the S3 API call.
    """
    src = f"s3://{bucket}/{key_prefix}/"
    log_info("Syncing from S3", source=src, target=target_dir)

    run_cmd(
        ["aws", "s3", "sync", src, f"{target_dir}/", "--region", region],
        check=True,
    )

    # Make shell scripts executable
    for sh in Path(target_dir).rglob("*.sh"):
        sh.chmod(sh.stat().st_mode | 0o111)

    log_info("S3 sync complete", source=src)
