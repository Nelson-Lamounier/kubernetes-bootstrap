"""Shared runtime helpers: logging, subprocess runner, and AWS client factories."""
from __future__ import annotations

import os
import subprocess

from helpers.config import Config


def log(msg: str) -> None:
    """Print a message to stdout (captured by SSM RunCommand → CloudWatch)."""
    print(msg, flush=True)


def run(
    cmd: list[str],
    *,
    cfg: Config,
    check: bool = True,
    capture: bool = False,
) -> subprocess.CompletedProcess:
    """Run a subprocess with KUBECONFIG set.

    HOME is set as a fallback for SSM Automation sessions where $HOME
    is undefined — the ArgoCD CLI crashes with "$HOME is not defined"
    without it (affects token generation in Step 10).
    """
    env = {**os.environ, "KUBECONFIG": cfg.kubeconfig, "HOME": os.environ.get("HOME", "/root")}
    if cfg.dry_run:
        log(f"  [DRY-RUN] {' '.join(cmd)}")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
    return subprocess.run(cmd, env=env, check=check, capture_output=capture, text=True)


def get_ssm_client(cfg: Config):
    """Create a boto3 SSM client (lazy import for environments without boto3)."""
    import boto3
    return boto3.client("ssm", region_name=cfg.aws_region)


def get_secrets_client(cfg: Config):
    """Create a boto3 Secrets Manager client (lazy import)."""
    import boto3
    return boto3.client("secretsmanager", region_name=cfg.aws_region)
