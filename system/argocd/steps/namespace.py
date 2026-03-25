"""Steps 1–3b: Namespace, deploy key, repo secret, and signing key preservation."""
from __future__ import annotations

import base64
import os
import subprocess
from pathlib import Path

from helpers.config import Config
from helpers.runner import get_ssm_client, log, run


# ---------------------------------------------------------------------------
# Step 1: Create argocd namespace
# ---------------------------------------------------------------------------
def create_namespace(cfg: Config) -> None:
    """Apply the argocd namespace manifest."""
    log("=== Step 1: Creating argocd namespace ===")
    namespace_yaml = Path(cfg.argocd_dir) / "namespace.yaml"
    run(["kubectl", "apply", "-f", str(namespace_yaml)], cfg=cfg)
    log("✓ argocd namespace ready\n")


# ---------------------------------------------------------------------------
# Step 2: Resolve SSH Deploy Key from SSM
# ---------------------------------------------------------------------------
def resolve_deploy_key(cfg: Config) -> str:
    """Read the SSH deploy key from SSM Parameter Store.

    Falls back to the DEPLOY_KEY environment variable for testing.
    """
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
    """Upsert the SSH deploy key as a Kubernetes Secret for ArgoCD repo access."""
    log("=== Step 3: Creating repo credentials (SSH Deploy Key) ===")

    if not deploy_key:
        log("  ⚠ Skipping — no Deploy Key available\n")
        return

    if cfg.dry_run:
        log("  [DRY-RUN] Would create repo-cdk-monitoring secret in argocd namespace\n")
        return

    try:
        from kubernetes import client
        from kubernetes import config as k8s_config

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
# Step 3b: Preserve ArgoCD signing key (before install.yaml blanks it)
# ---------------------------------------------------------------------------
def preserve_argocd_secret(cfg: Config) -> str | None:
    """Extract the JWT signing key from argocd-secret before re-install.

    install.yaml (server-side apply) resets argocd-secret to an empty Secret,
    which regenerates ``server.secretkey``. This invalidates ALL existing JWT
    tokens (including the CI bot token). By extracting the key beforehand,
    we can patch it back after installation, preserving token validity.

    Returns the base64-decoded signing key, or None if it doesn't exist
    (first install — no key to preserve).
    """
    log("=== Step 3b: Preserving ArgoCD JWT signing key ===")

    if cfg.dry_run:
        log("  [DRY-RUN] Would extract server.secretkey from argocd-secret\n")
        return None

    result = subprocess.run(
        ["kubectl", "get", "secret", "argocd-secret", "-n", "argocd",
         "-o", "jsonpath={.data.server\\.secretkey}"],
        env={**os.environ, "KUBECONFIG": cfg.kubeconfig},
        capture_output=True, text=True,
    )

    if result.returncode != 0 or not result.stdout.strip():
        log("  ℹ No existing argocd-secret found — first install")
        log("    A new signing key will be generated\n")
        return None

    signing_key = result.stdout.strip()
    log("  ✓ JWT signing key preserved (will be restored after install)\n")
    return signing_key
