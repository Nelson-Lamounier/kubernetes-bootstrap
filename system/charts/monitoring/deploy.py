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
    "prometheus-basic-auth": "PROMETHEUS_BASIC_AUTH",
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


def ensure_cluster_issuer(cfg: MonitoringConfig) -> None:
    """Idempotently apply the cert-manager ClusterIssuer (DNS-01 via Route 53).

    This is the SM-B retry path for bootstrap_argocd.py Step 5d, which runs
    before cert-manager CRDs are available and records 'failed' in SSM when it
    can't complete. By the time SM-B runs, ArgoCD has synced cert-manager and
    the CRD is guaranteed to be present.

    Reads PUBLIC_HOSTED_ZONE_ID and CROSS_ACCOUNT_DNS_ROLE_ARN from SSM
    (written by CDK control-plane-stack). No-ops if the ClusterIssuer already
    exists so repeated SM-B runs are safe.
    """
    import subprocess

    log_info("=== Ensuring cert-manager ClusterIssuer ===")

    kubeconfig = cfg.kubeconfig

    # Check if ClusterIssuer already exists — no-op if present
    check = subprocess.run(
        ["kubectl", "get", "clusterissuer", "letsencrypt"],
        env={**os.environ, "KUBECONFIG": kubeconfig},
        capture_output=True, text=True,
    )
    if check.returncode == 0:
        log_info("ClusterIssuer 'letsencrypt' already exists — skipping")
        return

    log_info("ClusterIssuer not found — reading SSM params and applying")

    boto3_mod, _ = _load_boto3()
    ssm = boto3_mod.client("ssm", region_name=cfg.aws_region)

    try:
        public_hz_id = ssm.get_parameter(
            Name=f"{cfg.ssm_prefix}/public-hosted-zone-id"
        )["Parameter"]["Value"]
    except Exception as e:
        raise RuntimeError(
            f"Cannot apply ClusterIssuer: SSM param "
            f"'{cfg.ssm_prefix}/public-hosted-zone-id' not found — {e}"
        ) from e

    try:
        dns_role_arn = ssm.get_parameter(
            Name=f"{cfg.ssm_prefix}/cross-account-dns-role-arn"
        )["Parameter"]["Value"]
    except Exception as e:
        raise RuntimeError(
            f"Cannot apply ClusterIssuer: SSM param "
            f"'{cfg.ssm_prefix}/cross-account-dns-role-arn' not found — {e}"
        ) from e

    manifest = f"""apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt
  annotations:
    kubernetes.io/description: "Let's Encrypt production issuer via DNS-01 challenge (Route 53)"
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: lamounierleao2025@outlook.com
    privateKeySecretRef:
      name: letsencrypt-account-key
    solvers:
      - dns01:
          route53:
            region: {cfg.aws_region}
            hostedZoneID: {public_hz_id}
            role: {dns_role_arn}
"""

    result = subprocess.run(
        ["kubectl", "apply", "-f", "-"],
        input=manifest, text=True, capture_output=True,
        env={**os.environ, "KUBECONFIG": kubeconfig},
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"kubectl apply ClusterIssuer failed: {result.stderr.strip()}"
        )

    log_info("ClusterIssuer 'letsencrypt' applied with DNS-01 Route 53 solver")

    # Remove ArgoCD tracking annotation — the ClusterIssuer is bootstrap-managed,
    # not ArgoCD-managed. Without this, selfHeal would overwrite or delete it.
    subprocess.run(
        ["kubectl", "annotate", "clusterissuer", "letsencrypt",
         "argocd.argoproj.io/tracking-id-", "--overwrite"],
        env={**os.environ, "KUBECONFIG": kubeconfig},
        capture_output=True,
    )


def ensure_argocd_ingress(cfg: MonitoringConfig) -> None:
    """Idempotently apply ArgoCD IngressRoutes and rate-limit middleware.

    SM-B retry path for bootstrap_argocd.py Step 7, which runs before Traefik
    CRDs are available and records 'failed' in SSM. By the time SM-B runs,
    ArgoCD has synced Traefik and the CRD is guaranteed present.

    Applies three resources to the argocd namespace:
      - rate-limit Middleware
      - argocd-ingress IngressRoute  (ops.nelsonlamounier.com/argocd)
      - argocd-webhook-ingress IngressRoute  (/argocd/api/webhook)
    """
    import subprocess

    log_info("=== Ensuring ArgoCD IngressRoutes ===")

    kubeconfig = cfg.kubeconfig
    env = {**os.environ, "KUBECONFIG": kubeconfig}

    # Check if main IngressRoute already exists — no-op if present
    check = subprocess.run(
        ["kubectl", "get", "ingressroute", "argocd-ingress", "-n", "argocd"],
        env=env, capture_output=True, text=True,
    )
    if check.returncode == 0:
        log_info("ArgoCD IngressRoute already exists — skipping")
        return

    log_info("ArgoCD IngressRoute not found — applying ingress manifests")

    manifests = [
        ("rate-limit Middleware", """apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: rate-limit
  namespace: argocd
  labels:
    app.kubernetes.io/part-of: argocd
spec:
  rateLimit:
    average: 100
    burst: 50
"""),
        ("argocd-ingress IngressRoute", """apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: argocd-ingress
  namespace: argocd
  labels:
    app.kubernetes.io/part-of: argocd
spec:
  entryPoints:
    - websecure
  routes:
    - match: Host(`ops.nelsonlamounier.com`) && PathPrefix(`/argocd`)
      kind: Rule
      priority: 100
      middlewares:
        - name: admin-ip-allowlist
        - name: rate-limit
      services:
        - name: argocd-server
          port: 80
  tls: {}
"""),
        ("argocd-webhook-ingress IngressRoute", """apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: argocd-webhook-ingress
  namespace: argocd
  labels:
    app.kubernetes.io/part-of: argocd
spec:
  entryPoints:
    - websecure
  routes:
    - match: Host(`ops.nelsonlamounier.com`) && PathPrefix(`/argocd/api/webhook`)
      kind: Rule
      priority: 200
      services:
        - name: argocd-server
          port: 80
  tls: {}
"""),
    ]

    for label, manifest in manifests:
        result = subprocess.run(
            ["kubectl", "apply", "-f", "-"],
            input=manifest, text=True, capture_output=True, env=env,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"kubectl apply {label} failed: {result.stderr.strip()}"
            )
        log_info(f"{label} applied")


def ensure_argocd_ip_allowlist(cfg: MonitoringConfig) -> None:
    """Idempotently create the admin-ip-allowlist Middleware in the argocd namespace.

    SM-B retry path for bootstrap_argocd.py Step 7b, which had a missing
    KUBECONFIG bug and ran before Traefik CRDs were available. Reads admin IPs
    from SSM and applies the Traefik IPAllowList middleware. No-ops if the
    middleware already exists with the correct IPs.
    """
    import subprocess

    log_info("=== Ensuring ArgoCD IP allowlist middleware ===")

    kubeconfig = cfg.kubeconfig
    env = {**os.environ, "KUBECONFIG": kubeconfig}

    boto3_mod, _ = _load_boto3()
    ssm = boto3_mod.client("ssm", region_name=cfg.aws_region)

    source_ranges: list[str] = []
    for param in ["monitoring/allow-ipv4", "monitoring/allow-ipv6"]:
        try:
            value = ssm.get_parameter(
                Name=f"{cfg.ssm_prefix}/{param}"
            )["Parameter"]["Value"]
            source_ranges.append(value)
            log_info(f"  {param}: {value}")
        except Exception as e:
            log_warn(f"  {param} not found in SSM — {e}")

    if not source_ranges:
        raise RuntimeError(
            "No admin IPs found in SSM — admin-ip-allowlist middleware not created. "
            "Ensure ALLOW_IPV4/ALLOW_IPV6 are set and Phase 1 of the pipeline has run."
        )

    source_range_yaml = "\n".join(f'      - "{ip}"' for ip in source_ranges)
    manifest = f"""apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: admin-ip-allowlist
  namespace: argocd
  labels:
    app.kubernetes.io/part-of: argocd
spec:
  ipAllowList:
    sourceRange:
{source_range_yaml}
"""

    result = subprocess.run(
        ["kubectl", "apply", "-f", "-"],
        input=manifest, text=True, capture_output=True, env=env,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"kubectl apply admin-ip-allowlist failed: {result.stderr.strip()}"
        )
    log_info(f"admin-ip-allowlist middleware applied with {len(source_ranges)} IP(s)")


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

    # Prometheus Basic Auth credentials
    prometheus_auth = secrets.get("PROMETHEUS_BASIC_AUTH")
    if prometheus_auth:
        import base64
        # Traefik requires basic auth string to be formatted like user:password_hash
        upsert_secret(
            v1,
            name="prometheus-basic-auth-secret",
            namespace=cfg.namespace,
            # For traefik basicAuth middleware, secret should contain "users" key
            data={"users": prometheus_auth},
        )
        log_info("prometheus-basic-auth-secret created/updated")


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

    # Step 5: Ensure cert-manager ClusterIssuer exists (SM-B retry path)
    # bootstrap_argocd.py Step 5d runs before cert-manager CRDs are ready and
    # records 'failed' in SSM. This step retries idempotently now that ArgoCD
    # has cert-manager healthy. No-ops if the ClusterIssuer already exists.
    ensure_cluster_issuer(cfg)

    # Step 6: Ensure ArgoCD IngressRoutes exist (SM-B retry path)
    # bootstrap_argocd.py Step 7 runs before Traefik CRDs are available and
    # records 'failed' in SSM. No-ops if argocd-ingress already exists.
    ensure_argocd_ingress(cfg)

    # Step 7: Ensure ArgoCD IP allowlist middleware exists (SM-B retry path)
    # bootstrap_argocd.py Step 7b had a missing KUBECONFIG bug and ran before
    # Traefik CRDs were available. No-ops handled per-resource by kubectl apply.
    ensure_argocd_ip_allowlist(cfg)

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
