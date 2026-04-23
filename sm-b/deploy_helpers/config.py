"""Base deployment configuration dataclass.

Provides a shared ``DeployConfig`` base class for all deploy scripts.
App-specific scripts (nextjs, monitoring) subclass this to add their
own fields and derived properties.

All fields have sensible defaults for the development environment.
Override via environment variables set by SSM Automation parameters.

Usage::

    from deploy_helpers.config import DeployConfig

    cfg = DeployConfig.from_env()
    print(cfg.ssm_prefix)   # /k8s/development
    print(cfg.aws_region)   # eu-west-1
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime, timezone

from deploy_helpers.logging import log_info


@dataclass
class DeployConfig:
    """Base deployment configuration populated from environment variables.

    Attributes:
        ssm_prefix: SSM Parameter Store prefix (e.g. ``/k8s/development``).
        aws_region: AWS region for API calls.
        kubeconfig: Path to kubeconfig on the control plane node.
        s3_bucket: S3 bucket for manifest re-sync (optional).
        s3_key_prefix: S3 key prefix for manifest sync.
        namespace: Target Kubernetes namespace.
        dry_run: If True, print config and exit without changes.
    """

    ssm_prefix: str = field(
        default_factory=lambda: os.getenv("SSM_PREFIX", "/k8s/development"),
    )
    aws_region: str = field(
        default_factory=lambda: os.getenv("AWS_REGION", "eu-west-1"),
    )
    kubeconfig: str = field(
        default_factory=lambda: os.getenv(
            "KUBECONFIG", "/etc/kubernetes/admin.conf"
        ),
    )
    s3_bucket: str = field(
        default_factory=lambda: os.getenv("S3_BUCKET", ""),
    )
    s3_key_prefix: str = field(
        default_factory=lambda: os.getenv("S3_KEY_PREFIX", "k8s"),
    )

    namespace: str = "default"
    dry_run: bool = False

    # Resolved at runtime by the app-specific script
    secrets: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> DeployConfig:
        """Create a DeployConfig from the current environment variables."""
        return cls()

    def print_banner(self, title: str) -> None:
        """Print a deployment banner with current configuration.

        Args:
            title: Banner title (e.g. 'Next.js Secret Deployment').
        """
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        log_info(f"=== {title} ===")
        log_info("Configuration", **{
            "ssm_prefix": self.ssm_prefix,
            "aws_region": self.aws_region,
            "namespace": self.namespace,
            "triggered": now,
        })
