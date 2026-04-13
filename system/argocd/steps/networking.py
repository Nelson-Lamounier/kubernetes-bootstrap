"""Steps 6–7c: ArgoCD readiness wait, ingress, IP allowlist, and webhook secret."""
from __future__ import annotations

import json
import os
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


def _argocd_pods_pending(cfg: Config) -> bool:
    """Return True if ALL ArgoCD pods are still Pending (not yet scheduled).

    Used to detect the case where pods exist but can't schedule — continuing
    to wait for a rollout in this state will always time out.
    """
    result = run(
        ["kubectl", "get", "pods", "-n", "argocd",
         "--field-selector=status.phase=Pending",
         "-o", "name"],
        cfg=cfg, check=False, capture=True,
    )
    if result.returncode != 0:
        return False
    pending = [p for p in result.stdout.strip().split("\n") if p]

    running_result = run(
        ["kubectl", "get", "pods", "-n", "argocd",
         "--field-selector=status.phase=Running",
         "-o", "name"],
        cfg=cfg, check=False, capture=True,
    )
    running = (
        [p for p in running_result.stdout.strip().split("\n") if p]
        if running_result.returncode == 0 else []
    )
    return len(pending) > 0 and len(running) == 0


def wait_for_argocd(cfg: Config) -> None:
    """Wait for ArgoCD server, repo-server, and application-controller to be ready.

    Uses a single overall deadline (3 × argo_timeout) shared across all
    components so the step cannot block indefinitely. Fails fast if all pods
    are stuck in Pending — a rollout wait in that state will never succeed.
    """
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

    # Fail fast: if every ArgoCD pod is Pending, rollout status will always
    # time out — no point burning the full timeout per component.
    if _argocd_pods_pending(cfg):
        log("  ⚠ All ArgoCD pods are Pending (not yet scheduled)")
        log("  ⚠ Check node taints, resource limits, or image pull status")
        log("  → Skipping rollout wait — re-run bootstrap once pods are Running\n")
        return

    targets = [
        ("deployment", "argocd-server"),
        ("deployment", "argocd-repo-server"),
        ("statefulset", "argocd-application-controller"),
    ]

    # Overall deadline shared across all components — prevents the step from
    # blocking for N × argo_timeout when multiple components are unhealthy.
    overall_deadline = time.time() + (len(targets) * cfg.argo_timeout)
    not_ready: list[str] = []

    for kind, name in targets:
        remaining = int(overall_deadline - time.time())
        if remaining <= 0:
            log(f"  ⚠ Overall deadline reached — skipping wait for {name}")
            not_ready.append(name)
            continue

        per_component_timeout = min(cfg.argo_timeout, remaining)
        log(f"  → Waiting for {name} (timeout: {per_component_timeout}s)...")
        result = run(
            ["kubectl", "rollout", "status", f"{kind}/{name}",
             "-n", "argocd", f"--timeout={per_component_timeout}s"],
            cfg=cfg, check=False,
        )
        if result.returncode != 0:
            log(f"  ⚠ {name} not ready within {per_component_timeout}s")
            not_ready.append(name)
        else:
            log(f"  ✓ {name} ready")

    if not_ready:
        log(f"  ⚠ Components not ready: {', '.join(not_ready)}")
        log("  ⚠ ArgoCD may be partially functional — check pod logs")
        log("    kubectl get pods -n argocd")
        log("    kubectl describe pod -n argocd <pod-name>")
    log("")


# ---------------------------------------------------------------------------
# Step 7: Apply ArgoCD ingress (after ArgoCD is ready and syncing Traefik)
# ---------------------------------------------------------------------------
def apply_ingress(cfg: Config) -> None:
    """Apply ingress manifests after Traefik CRDs are available.

    Waits for the ``ingressroutes.traefik.io`` CRD to be registered before
    attempting ``kubectl apply``. Uses an extended 300s timeout (60 × 5s)
    because ArgoCD may take 3–4 minutes to sync Traefik after the root app
    is applied. Includes post-apply verification to confirm the IngressRoute
    actually exists in the cluster.

    Applied manifests:
      - rate-limit-middleware.yaml — ArgoCD-local rate-limit (avoids cross-namespace ref)
      - ingress.yaml — ArgoCD UI IngressRoute (``/argocd``)
      - webhook-ingress.yaml — GitHub webhook IngressRoute
    """
    log("=== Step 7: Applying ArgoCD ingress ===")
    argocd_path = Path(cfg.argocd_dir)

    if cfg.dry_run:
        log("  [DRY-RUN] Would apply ingress manifests\n")
        return

    # Collect all ingress manifests to apply
    ingress_files = [
        ("rate-limit-middleware.yaml", "ArgoCD rate-limit middleware"),
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

    # Wait for Traefik CRDs to be installed by ArgoCD.
    # The root app triggers ArgoCD to sync Traefik, but CRD registration
    # can take minutes depending on cluster load and sync wave ordering.
    #
    # Extended timeout: 300s (60 × 5s) — ArgoCD typically syncs Traefik
    # within 3–4 minutes. The previous 60s timeout was too aggressive and
    # caused silent skips during DR recovery.
    #
    # Fast-fail: if all ArgoCD pods are Pending (not yet scheduled), Traefik
    # will never sync — skip the wait immediately rather than burning 5 minutes.
    traefik_crd = "ingressroutes.traefik.io"
    crd_max_attempts = 60  # 60 × 5s = 300s (5 minutes)
    log(f"  → Waiting for Traefik CRD '{traefik_crd}' (timeout: 300s)...")

    # Check if ArgoCD is even running before polling
    argocd_running = subprocess.run(
        ["kubectl", "get", "pods", "-n", "argocd",
         "--field-selector=status.phase=Running", "-o", "name"],
        env={**os.environ, "KUBECONFIG": cfg.kubeconfig},
        capture_output=True, text=True,
    )
    running_pods = [p for p in argocd_running.stdout.strip().split("\n") if p]
    if not running_pods:
        raise RuntimeError(
            "No ArgoCD pods Running — Traefik will not sync yet. "
            "SM-B (monitoring deploy.py) will retry once ArgoCD is healthy."
        )

    crd_ready = False
    for attempt in range(1, crd_max_attempts + 1):
        check = subprocess.run(
            ["kubectl", "get", "crd", traefik_crd],
            env={**os.environ, "KUBECONFIG": cfg.kubeconfig},
            capture_output=True, text=True,
        )
        if check.returncode == 0:
            log(f"  ✓ Traefik CRD ready (attempt {attempt}/{crd_max_attempts})")
            crd_ready = True
            break
        if attempt < crd_max_attempts:
            # Log progress every 12 attempts (60s) to avoid log spam
            if attempt % 12 == 0:
                log(f"    Attempt {attempt}/{crd_max_attempts} — CRD not found, still waiting...")
            time.sleep(5)

    if not crd_ready:
        raise RuntimeError(
            f"Traefik CRD '{traefik_crd}' not available after 300s — ArgoCD not yet synced. "
            "SM-B (monitoring deploy.py) will retry once Traefik is healthy."
        )

    # Apply all ingress manifests now that CRDs are available
    applied: list[str] = []
    for manifest_path, label in manifests_to_apply:
        result = run(
            ["kubectl", "apply", "-f", str(manifest_path)],
            cfg=cfg, check=False,
        )
        if result.returncode == 0:
            log(f"  ✓ {label} applied")
            applied.append(label)
        else:
            log(f"  ⚠ Failed to apply {label}: {manifest_path}")

    # ── Post-apply verification ──────────────────────────────────────────
    #
    # Confirm the IngressRoute actually exists in the cluster. This catches
    # race conditions where the apply succeeds but the resource is immediately
    # removed by a CRD reconciliation cycle (observed during DR recovery).
    if applied:
        log("  → Verifying IngressRoute exists in cluster...")
        verify_max = 3
        for attempt in range(1, verify_max + 1):
            verify = subprocess.run(
                ["kubectl", "get", "ingressroute", "argocd-ingress",
                 "-n", "argocd", "-o", "name"],
                env={**os.environ, "KUBECONFIG": cfg.kubeconfig},
                capture_output=True, text=True,
            )
            if verify.returncode == 0 and verify.stdout.strip():
                log("  ✓ IngressRoute verified — argocd-ingress exists in cluster")
                break
            if attempt < verify_max:
                log(f"    Verification attempt {attempt}/{verify_max} — not found, re-applying in 5s...")
                time.sleep(5)
                # Re-apply the main ingress if it disappeared
                run(
                    ["kubectl", "apply", "-f", str(argocd_path / "ingress.yaml")],
                    cfg=cfg, check=False,
                )
            else:
                log("  ⚠ IngressRoute verification failed after 3 attempts")
                log("    Manual fix: kubectl apply -f ingress.yaml")

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
        raise RuntimeError(
            "No admin IPs found in SSM — middleware not created. "
            "Ensure ALLOW_IPV4/ALLOW_IPV6 are set and Phase 1 of the pipeline has run. "
            "SM-B (monitoring deploy.py) will retry once IPs are present."
        )

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
        env={**os.environ, "KUBECONFIG": cfg.kubeconfig},
    )

    if result.returncode == 0:
        log(f"  ✓ ArgoCD IP allowlist middleware created with {len(source_ranges)} IP(s)")
    else:
        raise RuntimeError(
            f"kubectl apply admin-ip-allowlist failed: {result.stderr.strip()}. "
            "SM-B (monitoring deploy.py) will retry."
        )

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
