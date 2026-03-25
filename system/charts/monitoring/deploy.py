#!/usr/bin/env python3
"""Create monitoring Kubernetes secrets from SSM parameters.

Called by the SSM Automation pipeline on the control plane instance.
Resolves secrets from SSM Parameter Store and creates/updates the
grafana-credentials and github-actions-exporter-credentials K8s Secrets.
Helm chart deployment is handled by ArgoCD.

Usage:
    KUBECONFIG=/etc/kubernetes/admin.conf python3 deploy.py
    python3 deploy.py --dry-run   # Print config and exit

Environment overrides:
    SSM_PREFIX    — SSM parameter path  (default: /k8s/development)
    AWS_REGION    — AWS region          (default: eu-west-1)
    KUBECONFIG    — kubeconfig path     (default: /etc/kubernetes/admin.conf)
    S3_BUCKET     — re-sync from S3     (optional)
    S3_KEY_PREFIX — S3 key prefix       (default: platform/charts/monitoring)
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Ensure deploy_helpers is importable from the k8s-bootstrap directory.
# On EC2: /data/k8s-bootstrap/deploy_helpers/
# Locally: relative to this file's grandparent (kubernetes-app/k8s-bootstrap/)
_BOOTSTRAP_DIR = os.environ.get(
    "DEPLOY_HELPERS_PATH",
    str(Path(__file__).resolve().parents[2] / "k8s-bootstrap"),
)
if _BOOTSTRAP_DIR not in sys.path:
    sys.path.insert(0, _BOOTSTRAP_DIR)

from deploy_helpers.config import DeployConfig
from deploy_helpers.k8s import ensure_namespace, load_k8s, upsert_secret
from deploy_helpers.logging import log_info, log_warn
from deploy_helpers.s3 import sync_from_s3
from deploy_helpers.ssm import resolve_secrets

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SSM_SECRET_MAP: dict[str, str] = {
    "grafana-admin-password": "GRAFANA_ADMIN_PASSWORD",
    "github-token": "GITHUB_TOKEN",
    "github-webhook-token": "GITHUB_WEBHOOK_TOKEN",
    "github-org": "GITHUB_ORG",
}


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

@dataclass
class MonitoringConfig(DeployConfig):
    """Monitoring-specific deployment configuration.

    Extends ``DeployConfig`` with monitoring defaults.
    """

    s3_key_prefix: str = field(
        default_factory=lambda: os.getenv(
            "S3_KEY_PREFIX", "platform/charts/monitoring"
        ),
    )
    namespace: str = "monitoring"


# ---------------------------------------------------------------------------
# App-specific: K8s secret creation
# ---------------------------------------------------------------------------

def _load_boto3() -> tuple:
    """Lazily import boto3 and ClientError.

    Returns:
        Tuple of (boto3_module, ClientError_class).
    """
    import boto3 as _boto3
    from botocore.exceptions import ClientError as _ClientError

    return _boto3, _ClientError


def create_monitoring_k8s_secrets(v1: object, cfg: MonitoringConfig) -> None:
    """Create or update monitoring Kubernetes Secrets.

    Creates two secrets:
    - ``grafana-credentials``: Grafana admin user/password
    - ``github-actions-exporter-credentials``: GitHub token and org

    Args:
        v1: Kubernetes ``CoreV1Api`` instance.
        cfg: Monitoring deployment configuration with resolved secrets.
    """
    log_info("=== Creating Kubernetes secrets ===")
    ensure_namespace(v1, cfg.namespace)

    secrets = cfg.secrets

    # Grafana credentials
    grafana_pw = secrets.get("GRAFANA_ADMIN_PASSWORD")
    if grafana_pw:
        upsert_secret(
            v1,
            name="grafana-credentials",
            namespace=cfg.namespace,
            data={"admin-user": "admin", "admin-password": grafana_pw},
        )
        log_info("grafana-credentials created/updated")

    # GitHub Actions Exporter credentials
    gh_token = secrets.get("GITHUB_TOKEN")
    gh_webhook = secrets.get("GITHUB_WEBHOOK_TOKEN")
    gh_org = secrets.get("GITHUB_ORG")
    if gh_token or gh_webhook or gh_org:
        exporter_data: dict[str, str] = {}
        if gh_token:
            exporter_data["github-token"] = gh_token
        if gh_webhook:
            exporter_data["github-webhook-token"] = gh_webhook
        if gh_org:
            exporter_data["github-org"] = gh_org
        upsert_secret(
            v1,
            name="github-actions-exporter-credentials",
            namespace=cfg.namespace,
            data=exporter_data,
        )
        log_info("github-actions-exporter-credentials created/updated")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    """Entry point for monitoring secret deployment."""
    cfg = MonitoringConfig.from_env()

    # Handle --dry-run flag
    if "--dry-run" in sys.argv:
        cfg.dry_run = True
        cfg.print_banner("Monitoring Secret Deployment — DRY RUN")
        log_info("Dry run configuration", **{
            "kubeconfig": cfg.kubeconfig,
            "s3_bucket": cfg.s3_bucket or "(none)",
        })
        return

    # Load third-party dependencies
    boto3_mod, client_error_cls = _load_boto3()

    cfg.print_banner("Monitoring Secret Deployment")

    # Step 1: S3 sync (optional)
    if cfg.s3_bucket:
        sync_from_s3(
            cfg.s3_bucket,
            cfg.s3_key_prefix,
            "/data/platform/charts/monitoring",
            cfg.aws_region,
        )

    # Step 2: Load Kubernetes client
    v1 = load_k8s(cfg.kubeconfig)

    # Step 3: Resolve secrets from SSM
    ssm_client = boto3_mod.client("ssm", region_name=cfg.aws_region)
    cfg.secrets = resolve_secrets(
        ssm_client,
        cfg.ssm_prefix,
        SSM_SECRET_MAP,
        client_error_cls=client_error_cls,
    )

    # Step 4: Create Kubernetes secrets
    create_monitoring_k8s_secrets(v1, cfg)

    log_info("Monitoring secrets deployed successfully")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log_info("Deployment interrupted")
        sys.exit(130)
    except SystemExit:
        raise
    except Exception as exc:
        from deploy_helpers.logging import log_error

        log_error("Deployment failed", error=str(exc))
        sys.exit(1)
