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

import base64
import logging
import os
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# Third-party imports are loaded lazily in _load_dependencies() so that
# --dry-run works on dev machines without boto3/kubernetes installed.
boto3 = None
ClientError = None
k8s_client = None
k8s_config = None


def _load_dependencies() -> None:
    """Import third-party libraries. Called once from main() before real work."""
    global boto3, ClientError, k8s_client, k8s_config

    import boto3 as _boto3
    from botocore.exceptions import ClientError as _ClientError
    from kubernetes import client as _k8s_client
    from kubernetes import config as _k8s_config

    boto3 = _boto3
    ClientError = _ClientError
    k8s_client = _k8s_client
    k8s_config = _k8s_config


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("monitoring-deploy")


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
@dataclass
class Config:
    """Deployment configuration sourced from environment variables."""

    ssm_prefix: str = field(
        default_factory=lambda: os.getenv("SSM_PREFIX", "/k8s/development")
    )
    aws_region: str = field(
        default_factory=lambda: os.getenv("AWS_REGION", "eu-west-1")
    )
    kubeconfig: str = field(
        default_factory=lambda: os.getenv(
            "KUBECONFIG", "/etc/kubernetes/admin.conf"
        )
    )
    s3_bucket: str = field(
        default_factory=lambda: os.getenv("S3_BUCKET", "")
    )
    s3_key_prefix: str = field(
        default_factory=lambda: os.getenv(
            "S3_KEY_PREFIX", "platform/charts/monitoring"
        )
    )

    namespace: str = "monitoring"
    dry_run: bool = False

    # Resolved at runtime
    secrets: dict[str, str] = field(default_factory=dict)

    def print_banner(self) -> None:
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        log.info("=== Monitoring Secret Deployment ===")
        log.info("SSM prefix:  %s", self.ssm_prefix)
        log.info("Region:      %s", self.aws_region)
        log.info("Namespace:   %s", self.namespace)
        log.info("Triggered:   %s", now)
        log.info("")


# ---------------------------------------------------------------------------
# Step 1: S3 sync (thin CLI wrapper — s3 sync has no boto3 equivalent)
# ---------------------------------------------------------------------------
def sync_from_s3(cfg: Config) -> None:
    """Re-sync deploy scripts from S3 when S3_BUCKET is set."""
    if not cfg.s3_bucket:
        return

    log.info("=== Step 1: Re-syncing scripts from S3 ===")
    sync_dir = "/data/platform/charts/monitoring"
    src = f"s3://{cfg.s3_bucket}/{cfg.s3_key_prefix}/"

    _run_cmd(
        ["aws", "s3", "sync", src, f"{sync_dir}/", "--region", cfg.aws_region],
        check=True,
    )

    # Make scripts executable
    for sh in Path(sync_dir).rglob("*.sh"):
        sh.chmod(sh.stat().st_mode | 0o111)

    log.info("✓ Scripts synced from %s", src)
    log.info("")


# ---------------------------------------------------------------------------
# Step 2: Resolve secrets from SSM
# ---------------------------------------------------------------------------
SSM_SECRET_MAP = {
    "grafana-admin-password": "GRAFANA_ADMIN_PASSWORD",
    "github-token": "GITHUB_TOKEN",
    "github-webhook-token": "GITHUB_WEBHOOK_TOKEN",
    "github-org": "GITHUB_ORG",
}


def resolve_ssm_secrets(cfg: Config) -> dict[str, str]:
    """Fetch secrets from SSM Parameter Store using boto3.

    Returns a dict of env_var_name → value for all resolved secrets.
    If a value already exists as a non-placeholder env var, it is preserved.
    """
    log.info("=== Step 2: Resolving secrets from SSM ===")

    ssm = boto3.client("ssm", region_name=cfg.aws_region)
    secrets: dict[str, str] = {}

    for param_name, env_var in SSM_SECRET_MAP.items():
        # Check for environment override
        existing = os.getenv(env_var, "")
        if existing and existing != f"__{env_var}__":
            log.info("  ✓ %s: using environment override", env_var)
            secrets[env_var] = existing
            continue

        ssm_path = f"{cfg.ssm_prefix}/{param_name}"
        log.info("  → Resolving %s from SSM: %s", env_var, ssm_path)

        try:
            resp = ssm.get_parameter(Name=ssm_path, WithDecryption=True)
            value = resp["Parameter"]["Value"]
            secrets[env_var] = value
            log.info("  ✓ %s: resolved from SSM", env_var)
        except ClientError as exc:
            code = exc.response["Error"]["Code"]
            if code == "ParameterNotFound":
                log.warning("  ⚠ %s: not found in SSM, skipping", env_var)
            else:
                log.warning("  ⚠ %s: SSM error (%s)", env_var, code)

    log.info("")
    return secrets


# ---------------------------------------------------------------------------
# Step 3: Create/update Kubernetes secrets
# ---------------------------------------------------------------------------
def create_k8s_secrets(
    v1: k8s_client.CoreV1Api,
    cfg: Config,
) -> None:
    """Create or update Kubernetes Secrets from resolved SSM values.

    Uses an idempotent upsert pattern: try create, on 409 Conflict → replace.
    """
    log.info("=== Step 3: Creating Kubernetes secrets ===")

    # Ensure namespace exists
    _ensure_namespace(v1, cfg.namespace)

    secrets = cfg.secrets

    # Grafana credentials
    grafana_pw = secrets.get("GRAFANA_ADMIN_PASSWORD")
    if grafana_pw:
        _upsert_secret(
            v1,
            name="grafana-credentials",
            namespace=cfg.namespace,
            data={"admin-user": "admin", "admin-password": grafana_pw},
        )
        log.info("  ✓ grafana-credentials secret created/updated")

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
        _upsert_secret(
            v1,
            name="github-actions-exporter-credentials",
            namespace=cfg.namespace,
            data=exporter_data,
        )
        log.info("  ✓ github-actions-exporter-credentials secret created/updated")

    log.info("")


def _ensure_namespace(v1: k8s_client.CoreV1Api, namespace: str) -> None:
    """Create the namespace if it doesn't exist."""
    try:
        v1.read_namespace(name=namespace)
    except k8s_client.ApiException as exc:
        if exc.status == 404:
            v1.create_namespace(
                body=k8s_client.V1Namespace(
                    metadata=k8s_client.V1ObjectMeta(name=namespace)
                )
            )
            log.info("  ✓ Namespace '%s' created", namespace)
        else:
            raise


def _upsert_secret(
    v1: k8s_client.CoreV1Api,
    name: str,
    namespace: str,
    data: dict[str, str],
) -> None:
    """Create or replace a Kubernetes Secret (idempotent)."""
    encoded = {k: base64.b64encode(v.encode()).decode() for k, v in data.items()}
    secret = k8s_client.V1Secret(
        metadata=k8s_client.V1ObjectMeta(name=name, namespace=namespace),
        type="Opaque",
        data=encoded,
    )
    try:
        v1.create_namespaced_secret(namespace=namespace, body=secret)
    except k8s_client.ApiException as exc:
        if exc.status == 409:
            v1.replace_namespaced_secret(name=name, namespace=namespace, body=secret)
        else:
            raise


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _run_cmd(
    cmd: list[str],
    check: bool = True,
) -> subprocess.CompletedProcess:
    """Run a shell command, streaming output to stdout."""
    log.debug("  $ %s", " ".join(cmd))
    result = subprocess.run(cmd, capture_output=False, text=True, check=False)
    if check and result.returncode != 0:
        log.error("Command failed (exit %d): %s", result.returncode, " ".join(cmd))
        raise SystemExit(result.returncode)
    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    cfg = Config()

    # Handle --dry-run flag
    if "--dry-run" in sys.argv:
        cfg.dry_run = True
        cfg.print_banner()
        log.info("=== DRY RUN — no changes will be made ===")
        log.info("  ssm_prefix:   %s", cfg.ssm_prefix)
        log.info("  aws_region:   %s", cfg.aws_region)
        log.info("  kubeconfig:   %s", cfg.kubeconfig)
        log.info("  s3_bucket:    %s", cfg.s3_bucket or "(none)")
        log.info("  namespace:    %s", cfg.namespace)
        return

    # Load third-party dependencies (boto3, kubernetes)
    _load_dependencies()

    cfg.print_banner()

    # Step 1: S3 sync
    sync_from_s3(cfg)

    # Load kubeconfig for K8s API calls
    os.environ["KUBECONFIG"] = cfg.kubeconfig
    k8s_config.load_kube_config(config_file=cfg.kubeconfig)
    v1 = k8s_client.CoreV1Api()

    # Step 2: Resolve secrets from SSM
    cfg.secrets = resolve_ssm_secrets(cfg)

    # Step 3: Create Kubernetes secrets
    create_k8s_secrets(v1, cfg)

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    log.info("")
    log.info("✓ Monitoring secrets deployed successfully (%s)", now)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log.info("\n✗ Deployment interrupted")
        sys.exit(130)
    except SystemExit:
        raise
    except Exception as exc:
        log.error("✗ Deployment failed: %s", exc, exc_info=True)
        sys.exit(1)
