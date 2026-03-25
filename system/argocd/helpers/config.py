"""Bootstrap configuration dataclass and CLI argument parsing."""
from __future__ import annotations

import argparse
import os
from dataclasses import dataclass, field


@dataclass
class Config:
    """Bootstrap configuration populated from environment variables.

    All fields have sensible defaults for the development environment.
    Override via environment variables or ``--dry-run`` CLI flag.
    """

    ssm_prefix: str = field(default_factory=lambda: os.environ.get("SSM_PREFIX", "/k8s/development"))
    aws_region: str = field(default_factory=lambda: os.environ.get("AWS_REGION", "eu-west-1"))
    kubeconfig: str = field(default_factory=lambda: os.environ.get("KUBECONFIG", "/etc/kubernetes/admin.conf"))
    argocd_dir: str = field(default_factory=lambda: os.environ.get(
        "ARGOCD_DIR", "/data/k8s-bootstrap/system/argocd",
    ))
    argocd_cli_version: str = field(default_factory=lambda: os.environ.get("ARGOCD_CLI_VERSION", "v2.14.11"))
    argo_timeout: int = field(default_factory=lambda: int(os.environ.get("ARGO_TIMEOUT", "120")))
    dry_run: bool = False

    @property
    def env(self) -> str:
        """Extract environment from SSM prefix: /k8s/development → development."""
        return self.ssm_prefix.rstrip("/").split("/")[-1]


def parse_args() -> Config:
    """Parse CLI arguments and return a Config instance."""
    parser = argparse.ArgumentParser(description="Bootstrap ArgoCD on Kubernetes")
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without applying")
    args = parser.parse_args()

    cfg = Config()
    cfg.dry_run = args.dry_run
    return cfg
