"""Steps 6–7c: ArgoCD readiness wait, ingress, IP allowlist, and webhook secret."""
from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

from helpers.config import Config
from helpers.runner import get_ssm_client, log, run


# ---------------------------------------------------------------------------
# Step 6: Wait for ArgoCD server readiness (must pass before Step 7 ingress)
# ---------------------------------------------------------------------------
def _has_worker_nodes(cfg: Config) -> bool:
    """Check if any worker nodes (without control-plane taint) exist."""
    result = run(
        ["kubectl", "get", "nodes",
         "-l", "!node-role.kubernetes.io/control-plane",
         "-o", "name"],
        cfg=cfg, check=False, capture=True,
    )
    nodes = [n for n in result.stdout.strip().split("\n") if n] if result.returncode == 0 else []
    return len(nodes) > 0


def wait_for_argocd(cfg: Config) -> None:
    """Wait for ArgoCD server, repo-server, and application-controller to be ready."""
    log("=== Step 6: Waiting for ArgoCD server ===")

    if cfg.dry_run:
        log("  [DRY-RUN] Would wait for argocd-server, repo-server, application-controller\n")
        return

    # On Day-0, only the control plane node exists (with NoSchedule taint).
    # ArgoCD pods can't be scheduled until workers join — skip the wait.
    if not _has_worker_nodes(cfg):
        log("  ℹ No worker nodes available yet — ArgoCD pods will remain Pending")
        log("  ℹ Pods will start automatically once workers join the cluster")
        log("  → Skipping readiness wait (control plane has NoSchedule taint)\n")
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
# Step 7: Apply ArgoCD ingress (after ArgoCD is ready and syncing Traefik)
# ---------------------------------------------------------------------------
def apply_ingress(cfg: Config) -> None:
    """Apply ingress manifests, retrying while Traefik CRDs become available."""
    log("=== Step 7: Applying ArgoCD ingress ===")
    argocd_path = Path(cfg.argocd_dir)

    # Collect all ingress manifests to apply
    ingress_files = [
        ("ingress.yaml", "Main ArgoCD ingress"),
        ("webhook-ingress.yaml", "GitHub webhook ingress"),
    ]

    manifests_to_apply: list[tuple[Path, str]] = []
    for filename, label in ingress_files:
        path = argocd_path / filename
        if path.exists():
            manifests_to_apply.append((path, label))
        else:
            log(f"  ⚠ {filename} not found — skipping {label}")

    if not manifests_to_apply:
        log("  ⚠ No ingress manifests found — skipping\n")
        return

    # Traefik CRDs (IngressRoute, Middleware) are installed by ArgoCD via the
    # root app. ArgoCD is now running (Step 6 passed), but it may still be
    # syncing Traefik. Retry with generous backoff.
    log("  → Waiting for Traefik CRDs before applying ingress...")
    max_retries = 10
    for attempt in range(1, max_retries + 1):
        all_applied = True
        for manifest_path, label in manifests_to_apply:
            result = run(
                ["kubectl", "apply", "-f", str(manifest_path)],
                cfg=cfg, check=False,
            )
            if result.returncode == 0:
                log(f"  ✓ {label} applied")
            else:
                all_applied = False
        if all_applied:
            break
        if attempt < max_retries:
            log(f"  Attempt {attempt}/{max_retries} — Traefik CRDs not ready, waiting 30s...")
            time.sleep(30)
        else:
            log("  ⚠ Ingress not applied — Traefik CRDs not available after 5 min.")
            log("    ArgoCD will install Traefik shortly. Apply manually:")
            for manifest_path, _ in manifests_to_apply:
                log(f"    kubectl apply -f {manifest_path}")

    log("")


# ---------------------------------------------------------------------------
# Step 7b: Create ArgoCD IP Allowlist Middleware from SSM
# ---------------------------------------------------------------------------
def create_argocd_ip_allowlist(cfg: Config) -> None:
    """Create the admin-ip-allowlist Middleware in the argocd namespace.

    Reads admin IPs from SSM (same parameters as the monitoring chart)
    and creates the Traefik IPAllowList middleware dynamically, keeping
    secrets out of version control.
    """
    log("=== Step 7b: Creating ArgoCD IP Allowlist Middleware ===")

    ip_ssm_paths = [
        f"{cfg.ssm_prefix}/monitoring/allow-ipv4",
        f"{cfg.ssm_prefix}/monitoring/allow-ipv6",
    ]

    if cfg.dry_run:
        log("  [DRY-RUN] Would read IPs from SSM and create middleware\n")
        return

    # Collect IPs from SSM
    source_ranges: list[str] = []
    for ip_ssm_path in ip_ssm_paths:
        try:
            ssm = get_ssm_client(cfg)
            resp = ssm.get_parameter(Name=ip_ssm_path)
            ip_value = resp["Parameter"]["Value"]
            source_ranges.append(ip_value)
            log(f"  ✓ {ip_ssm_path}: {ip_value}")
        except Exception as e:
            log(f"  ⚠ IP not found in SSM ({ip_ssm_path}) — {e}")

    if not source_ranges:
        log("  ⚠ No IPs found — skipping middleware creation")
        log("    ArgoCD ingress will reject all traffic until middleware exists\n")
        return

    # Build the Middleware manifest
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
        input=manifest, text=True, capture_output=True,
    )

    if result.returncode == 0:
        log(f"  ✓ ArgoCD IP allowlist middleware created with {len(source_ranges)} IP(s)")
    else:
        log(f"  ⚠ Failed to create middleware: {result.stderr.strip()}")

    log("")


# ---------------------------------------------------------------------------
# Step 7c: Configure ArgoCD GitHub webhook secret
# ---------------------------------------------------------------------------
def configure_webhook_secret(cfg: Config) -> None:
    """Generate a random webhook secret and patch it into argocd-secret.

    ArgoCD validates incoming GitHub webhook payloads using HMAC-SHA256
    with the secret stored at 'webhook.github.secret' in argocd-secret.
    The same secret value must be configured in the GitHub repository's
    webhook settings.

    The secret is also stored in SSM so it can be retrieved when
    configuring the GitHub webhook (manually or via GitHub Actions).
    """
    log("=== Step 7c: Configuring ArgoCD GitHub webhook secret ===")

    ssm_path = f"{cfg.ssm_prefix}/argocd-webhook-secret"

    if cfg.dry_run:
        log(f"  [DRY-RUN] Would generate webhook secret and store at: {ssm_path}")
        log("  [DRY-RUN] Would patch argocd-secret with webhook.github.secret\n")
        return

    # 1. Check if a webhook secret already exists in SSM (idempotent)
    existing_secret: str | None = None
    try:
        ssm = get_ssm_client(cfg)
        resp = ssm.get_parameter(Name=ssm_path, WithDecryption=True)
        existing_secret = resp["Parameter"]["Value"]
        log("  ✓ Webhook secret already exists in SSM — reusing")
    except Exception:
        pass  # Secret doesn't exist yet — generate a new one

    # 2. Generate a new secret if one doesn't exist
    if existing_secret:
        webhook_secret = existing_secret
    else:
        import secrets as secrets_mod
        webhook_secret = secrets_mod.token_hex(32)
        log("  ✓ Generated new webhook secret (64 hex chars)")

        # Store in SSM for retrieval when configuring the GitHub webhook
        try:
            from botocore.exceptions import ClientError

            ssm = get_ssm_client(cfg)
            try:
                ssm.put_parameter(
                    Name=ssm_path,
                    Description="ArgoCD GitHub webhook secret for HMAC validation",
                    Value=webhook_secret,
                    Type="SecureString",
                )
                log(f"  ✓ Webhook secret stored in SSM: {ssm_path}")
            except ClientError as e:
                if e.response["Error"]["Code"] == "ParameterAlreadyExists":
                    ssm.put_parameter(
                        Name=ssm_path,
                        Value=webhook_secret,
                        Type="SecureString",
                        Overwrite=True,
                    )
                    log(f"  ✓ Webhook secret updated in SSM: {ssm_path}")
                else:
                    raise
        except Exception as e:
            log(f"  ⚠ Failed to store webhook secret in SSM: {e}")
            log(f"    Store it manually: aws ssm put-parameter --name {ssm_path} ...")

    # 3. Patch argocd-secret with the webhook secret
    patch = json.dumps({
        "stringData": {
            "webhook.github.secret": webhook_secret,
        }
    })

    result = run(
        ["kubectl", "-n", "argocd", "patch", "secret", "argocd-secret",
         "--type", "merge", "-p", patch],
        cfg=cfg, check=False,
    )

    if result.returncode == 0:
        log("  ✓ argocd-secret patched with webhook.github.secret")
    else:
        log("  ⚠ Failed to patch argocd-secret")
        log("    Manual fix: kubectl -n argocd patch secret argocd-secret ...")

    log("")
