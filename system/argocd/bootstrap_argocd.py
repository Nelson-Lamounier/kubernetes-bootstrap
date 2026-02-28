#!/usr/bin/env python3
"""bootstrap_argocd.py — Bootstrap ArgoCD on Kubernetes.

Installs ArgoCD and configures it to watch the private GitHub repo.
Run once during first boot (via user-data → boot-k8s.sh) after kubeadm
cluster is ready.

Converted from bootstrap-argocd.sh (294-line Bash) to Python for:
  - Typed config (dataclass) instead of unvalidated env vars
  - boto3 for SSM / Secrets Manager (proper error handling)
  - kubernetes client for secret upsert (idempotent, base64-safe)
  - --dry-run mode for local development

Steps:
  1.  Create argocd namespace
  2.  Resolve SSH deploy key from SSM
  3.  Create repo credentials secret
  4.  Install ArgoCD (kubectl apply)
  5.  Apply ingress + Application CRDs
  6.  Wait for ArgoCD server readiness
  7.  Install ArgoCD CLI
  8.  Create CI bot account
  9.  Generate API token → Secrets Manager
  10. Summary
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
@dataclass
class Config:
    ssm_prefix: str = field(default_factory=lambda: os.environ.get("SSM_PREFIX", "/k8s/development"))
    aws_region: str = field(default_factory=lambda: os.environ.get("AWS_REGION", "eu-west-1"))
    kubeconfig: str = field(default_factory=lambda: os.environ.get("KUBECONFIG", "/etc/kubernetes/admin.conf"))
    argocd_dir: str = field(default_factory=lambda: os.environ.get(
        "ARGOCD_DIR", "/data/k8s-bootstrap/system/argocd"
    ))
    argocd_cli_version: str = field(default_factory=lambda: os.environ.get("ARGOCD_CLI_VERSION", "v2.14.11"))
    argo_timeout: int = field(default_factory=lambda: int(os.environ.get("ARGO_TIMEOUT", "120")))
    dry_run: bool = False

    @property
    def env(self) -> str:
        """Extract environment from SSM prefix: /k8s/development → development."""
        return self.ssm_prefix.rstrip("/").split("/")[-1]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def log(msg: str) -> None:
    print(msg, flush=True)


def run(cmd: list[str], *, cfg: Config, check: bool = True, capture: bool = False) -> subprocess.CompletedProcess:
    """Run a subprocess with KUBECONFIG set."""
    env = {**os.environ, "KUBECONFIG": cfg.kubeconfig}
    if cfg.dry_run:
        log(f"  [DRY-RUN] {' '.join(cmd)}")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
    return subprocess.run(cmd, env=env, check=check, capture_output=capture, text=True)


def get_ssm_client(cfg: Config):
    import boto3
    return boto3.client("ssm", region_name=cfg.aws_region)


def get_secrets_client(cfg: Config):
    import boto3
    return boto3.client("secretsmanager", region_name=cfg.aws_region)


# ---------------------------------------------------------------------------
# Step 1: Create argocd namespace
# ---------------------------------------------------------------------------
def create_namespace(cfg: Config) -> None:
    log("=== Step 1: Creating argocd namespace ===")
    namespace_yaml = Path(cfg.argocd_dir) / "namespace.yaml"
    run(["kubectl", "apply", "-f", str(namespace_yaml)], cfg=cfg)
    log("✓ argocd namespace ready\n")


# ---------------------------------------------------------------------------
# Step 2: Resolve SSH Deploy Key from SSM
# ---------------------------------------------------------------------------
def resolve_deploy_key(cfg: Config) -> str:
    log("=== Step 2: Resolving SSH Deploy Key from SSM ===")

    # Allow env override for testing
    deploy_key = os.environ.get("DEPLOY_KEY", "")
    if deploy_key:
        log("  ✓ Using environment override\n")
        return deploy_key

    ssm_path = f"{cfg.ssm_prefix}/deploy-key"
    log(f"  → Resolving from SSM: {ssm_path}")

    if cfg.dry_run:
        log("  [DRY-RUN] Would resolve deploy key from SSM\n")
        return ""

    try:
        ssm = get_ssm_client(cfg)
        resp = ssm.get_parameter(Name=ssm_path, WithDecryption=True)
        log("  ✓ SSH Deploy Key resolved from SSM\n")
        return resp["Parameter"]["Value"]
    except Exception as e:
        log(f"  ⚠ Deploy Key not found in SSM — {e}")
        log(f"  ⚠ Store Deploy Key at: {ssm_path}\n")
        return ""


# ---------------------------------------------------------------------------
# Step 3: Create repo credentials secret (SSH Deploy Key)
# ---------------------------------------------------------------------------
def create_repo_secret(cfg: Config, deploy_key: str) -> None:
    log("=== Step 3: Creating repo credentials (SSH Deploy Key) ===")

    if not deploy_key:
        log("  ⚠ Skipping — no Deploy Key available\n")
        return

    if cfg.dry_run:
        log("  [DRY-RUN] Would create repo-cdk-monitoring secret in argocd namespace\n")
        return

    try:
        from kubernetes import client, config as k8s_config

        k8s_config.load_kube_config(config_file=cfg.kubeconfig)
        v1 = client.CoreV1Api()

        secret_data = {
            "type": base64.b64encode(b"git").decode(),
            "url": base64.b64encode(b"git@github.com:Nelson-Lamounier/cdk-monitoring.git").decode(),
            "sshPrivateKey": base64.b64encode(deploy_key.encode()).decode(),
        }

        secret = client.V1Secret(
            metadata=client.V1ObjectMeta(
                name="repo-cdk-monitoring",
                namespace="argocd",
                labels={"argocd.argoproj.io/secret-type": "repository"},
            ),
            data=secret_data,
            type="Opaque",
        )

        try:
            v1.create_namespaced_secret("argocd", secret)
            log("  ✓ SSH Deploy Key repo credentials created")
        except client.exceptions.ApiException as e:
            if e.status == 409:
                v1.replace_namespaced_secret("repo-cdk-monitoring", "argocd", secret)
                log("  ✓ SSH Deploy Key repo credentials updated")
            else:
                raise
    except Exception as e:
        log(f"  ⚠ Failed to create repo secret: {e}")

    log("")


# ---------------------------------------------------------------------------
# Step 4: Install ArgoCD (non-HA)
# ---------------------------------------------------------------------------
def install_argocd(cfg: Config) -> None:
    log("=== Step 4: Installing ArgoCD ===")
    install_yaml = Path(cfg.argocd_dir) / "install.yaml"
    # --server-side: ArgoCD CRDs (applicationsets.argoproj.io) exceed the 262KB
    # annotation limit imposed by client-side kubectl apply. Server-side apply
    # avoids the last-applied-configuration annotation entirely.
    # --force-conflicts: Required on re-apply to take ownership of fields that
    # were previously managed by client-side apply.
    run(
        ["kubectl", "apply", "-n", "argocd", "-f", str(install_yaml),
         "--server-side", "--force-conflicts"],
        cfg=cfg,
    )
    log("✓ ArgoCD core installed\n")


# ---------------------------------------------------------------------------
# Step 5: Apply App-of-Apps root + ArgoCD ingress
# ---------------------------------------------------------------------------
def apply_applications(cfg: Config) -> None:
    log("=== Step 5: Applying App-of-Apps root and ingress ===")
    argocd_path = Path(cfg.argocd_dir)

    # 1. App-of-Apps root FIRST — this triggers ArgoCD to install all child
    #    Applications (Traefik, metrics-server, local-path-provisioner, etc.).
    #    Traefik must be running before we can apply the ingress.
    root_app = argocd_path / "root-app.yaml"
    if root_app.exists():
        log(f"  → Applying App-of-Apps root: {root_app.name}")
        run(["kubectl", "apply", "-f", str(root_app)], cfg=cfg)
    else:
        log(f"  ⚠ root-app.yaml not found at {root_app}")

    # 2. Ingress AFTER — uses Traefik CRDs (IngressRoute, Middleware).
    #    On Day-0, Traefik is still being installed by ArgoCD (~2-3 min),
    #    so the CRDs may not exist yet. We retry a few times before giving up.
    ingress_yaml = argocd_path / "ingress.yaml"
    if ingress_yaml.exists():
        log("  → Waiting for Traefik CRDs before applying ingress...")
        max_retries = 6
        for attempt in range(1, max_retries + 1):
            result = run(
                ["kubectl", "apply", "-f", str(ingress_yaml)],
                cfg=cfg, check=False,
            )
            if result.returncode == 0:
                log("  ✓ Ingress applied")
                break
            if attempt < max_retries:
                log(f"  Attempt {attempt}/{max_retries} — Traefik CRDs not ready, waiting 30s...")
                time.sleep(30)
            else:
                log("  ⚠ Ingress not applied — Traefik CRDs not available yet.")
                log("    ArgoCD will install Traefik shortly. Re-run this script or apply manually:")
                log(f"    kubectl apply -f {ingress_yaml}")

    log("✓ App-of-Apps root applied\n")


# ---------------------------------------------------------------------------
# Step 6: Wait for ArgoCD server readiness
# ---------------------------------------------------------------------------
def wait_for_argocd(cfg: Config) -> None:
    log("=== Step 6: Waiting for ArgoCD server ===")

    if cfg.dry_run:
        log("  [DRY-RUN] Would wait for argocd-server, repo-server, application-controller\n")
        return

    targets = [
        ("deployment", "argocd-server"),
        ("deployment", "argocd-repo-server"),
        ("statefulset", "argocd-application-controller"),
    ]

    for kind, name in targets:
        log(f"  → Waiting for {name}...")
        result = run(
            ["kubectl", "rollout", "status", f"{kind}/{name}",
             "-n", "argocd", f"--timeout={cfg.argo_timeout}s"],
            cfg=cfg, check=False,
        )
        if result.returncode != 0:
            log(f"  ⚠ {name} not ready within {cfg.argo_timeout}s")

    log("")


# ---------------------------------------------------------------------------
# Step 7: Install ArgoCD CLI
# ---------------------------------------------------------------------------
def install_argocd_cli(cfg: Config) -> bool:
    log("=== Step 7: Installing ArgoCD CLI ===")

    if cfg.dry_run:
        log(f"  [DRY-RUN] Would install ArgoCD CLI {cfg.argocd_cli_version}\n")
        return True

    import platform
    arch_map = {"x86_64": "amd64", "aarch64": "arm64", "arm64": "arm64"}
    cli_arch = arch_map.get(platform.machine(), "amd64")

    url = (
        f"https://github.com/argoproj/argo-cd/releases/download/"
        f"{cfg.argocd_cli_version}/argocd-linux-{cli_arch}"
    )
    log(f"  → Downloading ArgoCD CLI {cfg.argocd_cli_version} ({cli_arch})...")

    result = run(
        ["bash", "-c", f'curl -sSL -o /usr/local/bin/argocd "{url}" && chmod +x /usr/local/bin/argocd'],
        cfg=cfg, check=False,
    )

    if result.returncode == 0:
        version_result = run(
            ["argocd", "version", "--client", "--short"],
            cfg=cfg, check=False, capture=True,
        )
        version = version_result.stdout.strip() if version_result.returncode == 0 else cfg.argocd_cli_version
        log(f"  ✓ ArgoCD CLI installed: {version}\n")
        return True
    else:
        log("  ⚠ ArgoCD CLI install failed — skipping CI bot token generation\n")
        return False


# ---------------------------------------------------------------------------
# Step 8: Create CI bot account
# ---------------------------------------------------------------------------
def create_ci_bot(cfg: Config) -> None:
    log("=== Step 8: Creating CI bot account ===")

    if cfg.dry_run:
        log("  [DRY-RUN] Would patch argocd-cm and argocd-rbac-cm\n")
        return

    # Register ci-bot account
    cm_patch = json.dumps({"data": {"accounts.ci-bot": "apiKey"}})
    result = run(
        ["kubectl", "patch", "configmap", "argocd-cm", "-n", "argocd",
         "--type", "merge", "-p", cm_patch],
        cfg=cfg, check=False,
    )
    if result.returncode == 0:
        log("  ✓ ci-bot account registered in argocd-cm")
    else:
        log("  ⚠ Failed to patch argocd-cm")

    # Grant ci-bot read-only RBAC
    rbac_csv = (
        "p, role:ci-readonly, applications, get, */*, allow\\n"
        "p, role:ci-readonly, applications, list, */*, allow\\n"
        "g, ci-bot, role:ci-readonly"
    )
    rbac_patch = json.dumps({"data": {"policy.csv": rbac_csv}})
    result = run(
        ["kubectl", "patch", "configmap", "argocd-rbac-cm", "-n", "argocd",
         "--type", "merge", "-p", rbac_patch],
        cfg=cfg, check=False,
    )
    if result.returncode == 0:
        log("  ✓ ci-bot RBAC policy applied (read-only)")
    else:
        log("  ⚠ Failed to patch argocd-rbac-cm")

    # Wait for ConfigMap pickup
    time.sleep(5)
    log("")


# ---------------------------------------------------------------------------
# Step 9: Generate API token → Secrets Manager
# ---------------------------------------------------------------------------
def generate_ci_token(cfg: Config) -> None:
    log("=== Step 9: Generating CI bot token ===")

    secret_name = f"k8s/{cfg.env}/argocd-ci-token"

    if cfg.dry_run:
        log(f"  [DRY-RUN] Would generate token and store at: {secret_name}\n")
        return

    log("  → Generating API token for ci-bot...")
    result = run(
        ["argocd", "account", "generate-token", "--account", "ci-bot", "--core", "--grpc-web"],
        cfg=cfg, check=False, capture=True,
    )

    ci_token = result.stdout.strip() if result.returncode == 0 else ""

    if not ci_token:
        log("  ⚠ Token generation failed — CI pipeline will skip ArgoCD verification\n")
        return

    log("  ✓ API token generated")
    log(f"  → Pushing token to Secrets Manager: {secret_name}")

    try:
        sm = get_secrets_client(cfg)
        try:
            sm.create_secret(
                Name=secret_name,
                Description="ArgoCD CI bot API token for pipeline verification",
                SecretString=ci_token,
            )
            log("  ✓ Secret created in Secrets Manager")
        except sm.exceptions.ResourceExistsException:
            sm.update_secret(SecretId=secret_name, SecretString=ci_token)
            log("  ✓ Secret updated in Secrets Manager")
    except Exception as e:
        log(f"  ⚠ Failed to store token in Secrets Manager: {e}")

    log("")


# ---------------------------------------------------------------------------
# Step 10: Summary
# ---------------------------------------------------------------------------
def print_summary(cfg: Config) -> None:
    log("=== ArgoCD Bootstrap Summary ===\n")

    if cfg.dry_run:
        log("  [DRY-RUN] Would show pods and applications\n")
        return

    run(["kubectl", "get", "pods", "-n", "argocd", "-o", "wide"], cfg=cfg, check=False)
    log("")
    run(["kubectl", "get", "applications", "-n", "argocd"], cfg=cfg, check=False)
    log("")

    # Retrieve initial admin password
    result = run(
        ["kubectl", "-n", "argocd", "get", "secret", "argocd-initial-admin-secret",
         "-o", "jsonpath={.data.password}"],
        cfg=cfg, check=False, capture=True,
    )

    if result.returncode == 0 and result.stdout.strip():
        try:
            password = base64.b64decode(result.stdout.strip()).decode()
            log("=== ArgoCD Admin Access ===")
            log(f"  URL:      https://<eip>/argocd")
            log(f"  User:     admin")
            log(f"  Password: {password}")
            log("")
            log("  (Change the password after first login)")
        except Exception:
            pass

    log(f"\n✓ ArgoCD bootstrap complete ({datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')})")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(description="Bootstrap ArgoCD on Kubernetes")
    parser.add_argument("--dry-run", action="store_true", help="Print actions without executing")
    args = parser.parse_args()

    cfg = Config(dry_run=args.dry_run)

    log("=== ArgoCD Bootstrap ===")
    log(f"SSM prefix: {cfg.ssm_prefix}")
    log(f"Region:     {cfg.aws_region}")
    log(f"ArgoCD dir: {cfg.argocd_dir}")
    log(f"Triggered:  {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}")
    log("")

    if cfg.dry_run:
        log("=== DRY RUN — no changes will be made ===")
        log(f"  kubeconfig:       {cfg.kubeconfig}")
        log(f"  argocd_dir:       {cfg.argocd_dir} (exists: {Path(cfg.argocd_dir).exists()})")
        log(f"  cli_version:      {cfg.argocd_cli_version}")
        log(f"  argo_timeout:     {cfg.argo_timeout}s")
        log(f"  environment:      {cfg.env}")
        log("")

    # Step 1: Namespace
    create_namespace(cfg)

    # Step 2: Resolve deploy key
    deploy_key = resolve_deploy_key(cfg)

    # Step 3: Repo secret
    create_repo_secret(cfg, deploy_key)

    # Step 4: Install ArgoCD
    install_argocd(cfg)

    # Step 5: Applications
    apply_applications(cfg)

    # Step 6: Wait for readiness
    wait_for_argocd(cfg)

    # Step 7: CLI
    cli_installed = install_argocd_cli(cfg)

    if cli_installed:
        # Step 8: CI bot account
        create_ci_bot(cfg)

        # Step 9: API token
        generate_ci_token(cfg)
    else:
        log("=== Step 8-9: Skipping — ArgoCD CLI not available ===\n")

    # Step 10: Summary
    print_summary(cfg)


if __name__ == "__main__":
    main()
