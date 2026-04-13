"""Steps 8–11: CLI install, CI bot, token, admin password, TLS backup, signing key backup, summary."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from helpers.config import Config
from helpers.runner import get_secrets_client, get_ssm_client, log, run

_ARGOCD_SERVER_DEPLOYMENT = "deployment/argocd-server"

# ---------------------------------------------------------------------------
# Step 8: Install ArgoCD CLI
# ---------------------------------------------------------------------------
def install_argocd_cli(cfg: Config) -> bool:
    """Download and install the ArgoCD CLI binary."""
    log("=== Step 8: Installing ArgoCD CLI ===")

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
# Step 9: Create CI bot account
# ---------------------------------------------------------------------------
def create_ci_bot(cfg: Config) -> None:
    """Register the ci-bot account in ArgoCD and grant read-only RBAC.

    Guards against restarting argocd-server when it is already mid-rollout.
    If a rollout is in progress (e.g. from Step 4c rootpath config or Step
    3b-restore signing key), we wait for it to settle before triggering our
    own restart — preventing the cascading double-wait that caused the
    2026-04-13 SM-A timeout at poll count 19.
    """
    log("=== Step 9: Creating CI bot account ===")

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
        "p, role:ci-readonly, applications, get, */*, allow\n"
        "p, role:ci-readonly, applications, list, */*, allow\n"
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

    # ── Restart argocd-server to load ci-bot account ──────────────────────
    #
    # argocd-server must be restarted so it picks up the new ci-bot account
    # from argocd-cm. Without this, the server won't recognise the ci-bot
    # token and the CI pipeline health check will fail with HTTP 401.
    #
    # Guard: if a rollout is already in progress (old replica still
    # terminating from a previous step — e.g. Step 4c rootpath config or
    # Step 3b-restore signing key), triggering a *second* restart stacks
    # a new wait on top of an already-recovering pod. This was the root
    # cause of the 2026-04-13 SM-A timeout at Step 9 / poll count 19.
    #
    # Strategy:
    #   1. Quick 10s probe: is argocd-server already fully ready?
    #   2a. If ready → restart cleanly. Pod comes up fast from a clean state.
    #   2b. If mid-rollout → wait for the existing rollout to settle first,
    #       then restart. Avoids a cascading double-wait.
    #   3. Wait for the post-restart rollout to complete before Step 10
    #      generates the CI bot token (server must know about the account).
    log("  → Checking argocd-server rollout state before restart...")

    pre_check = run(
        ["kubectl", "rollout", "status", _ARGOCD_SERVER_DEPLOYMENT,
         "-n", "argocd", "--timeout=10s"],
        cfg=cfg, check=False,
    )

    if pre_check.returncode == 0:
        log("  ✓ argocd-server is fully ready — proceeding with restart")
    else:
        # A rollout is in progress: wait up to argo_timeout for it to settle
        # before we trigger our own restart, to avoid a cascading double-wait.
        log(f"  ⚠ argocd-server rollout in progress — waiting up to {cfg.argo_timeout}s for it to settle...")
        settle = run(
            ["kubectl", "rollout", "status", _ARGOCD_SERVER_DEPLOYMENT,
             "-n", "argocd", f"--timeout={cfg.argo_timeout}s"],
            cfg=cfg, check=False,
        )
        if settle.returncode == 0:
            log("  ✓ Existing rollout settled — continuing with ci-bot restart")
        else:
            log(f"  ⚠ Rollout did not settle within {cfg.argo_timeout}s — restarting anyway")
            log("    (ci-bot account must be loaded; Step 10 has retry logic)")

    log("  → Restarting argocd-server to load ci-bot account...")
    result = run(
        ["kubectl", "rollout", "restart", _ARGOCD_SERVER_DEPLOYMENT,
         "-n", "argocd"],
        cfg=cfg, check=False,
    )
    if result.returncode == 0:
        log("  ✓ argocd-server restart triggered")
        # Wait for the new pods to be ready before generating the token
        result = run(
            ["kubectl", "rollout", "status", _ARGOCD_SERVER_DEPLOYMENT,
             "-n", "argocd", f"--timeout={cfg.argo_timeout}s"],
            cfg=cfg, check=False,
        )
        if result.returncode == 0:
            log("  ✓ argocd-server rollout complete — ci-bot account loaded")
        else:
            log(f"  ⚠ argocd-server rollout not ready within {cfg.argo_timeout}s")
    else:
        log("  ⚠ Failed to restart argocd-server — token may not work for health check")

    log("")


# ---------------------------------------------------------------------------
# Step 10: Generate API token → Secrets Manager
# ---------------------------------------------------------------------------
def _resolve_admin_password(cfg: Config) -> str:
    """Resolve the active ArgoCD admin password.

    Tries two sources in order:
      1. SSM Parameter Store (set by previous bootstrap's Step 10b)
      2. argocd-initial-admin-secret (Day-0 only — before first 10b run)

    Returns:
        The plaintext admin password, or empty string if unresolvable.
    """
    # Source 1: SSM — covers re-bootstrap scenarios where Step 10b
    # previously rotated the password away from the initial secret.
    ssm_path = f"{cfg.ssm_prefix}/argocd-admin-password"
    try:
        ssm = get_ssm_client(cfg)
        resp = ssm.get_parameter(Name=ssm_path, WithDecryption=True)
        password = resp["Parameter"]["Value"]
        log(f"  ✓ Admin password resolved from SSM: {ssm_path}")
        return password
    except Exception:
        log(f"  ⚠ SSM parameter {ssm_path} not found — trying initial-admin-secret")

    # Source 2: argocd-initial-admin-secret — Day-0 only.
    # The auto-generated password is base64-encoded in the Secret.
    result = run(
        ["kubectl", "-n", "argocd", "get", "secret", "argocd-initial-admin-secret",
         "-o", "jsonpath={.data.password}"],
        cfg=cfg, check=False, capture=True,
    )
    if result.returncode == 0 and result.stdout.strip():
        import base64
        password = base64.b64decode(result.stdout.strip()).decode()
        log("  ✓ Admin password resolved from argocd-initial-admin-secret (Day-0)")
        return password

    log("  ⚠ No admin password available from SSM or initial-admin-secret")
    return ""


# ArgoCD service endpoint accessible from the control plane node.
# Uses plaintext HTTP (:80) since TLS termination is handled by Traefik.
_ARGOCD_API_ENDPOINT = "argocd-server.argocd.svc.cluster.local"


def generate_ci_token(cfg: Config) -> None:
    """Generate a CI bot API token and store it in Secrets Manager.

    Uses the ArgoCD REST API (not ``--core`` mode) to avoid Kubernetes
    RBAC dependencies. The ``--core`` flag requires the calling context
    to have ``list services`` permission in the argocd namespace, which
    the node's kubeconfig may not grant in all deployment scenarios.

    Hardened with:
      - Retry with backoff (3 attempts): covers the timing window where
        argocd-server is still rolling out after Step 3b-restore
      - Token validation: curls the ArgoCD API with the new token to
        confirm HTTP 200 before writing to Secrets Manager
      - Safe store: never overwrites a working token with a broken one

    Flow:
      1. Resolve admin password (SSM → initial-admin-secret fallback)
      2. Login to ArgoCD API via in-cluster service endpoint (with retry)
      3. Generate CI bot API token via ArgoCD API
      4. Validate token against ArgoCD API
      5. Store token in Secrets Manager (only if validated)
    """
    log("=== Step 10: Generating CI bot token ===")

    secret_name = f"k8s/{cfg.env}/argocd-ci-token"

    if cfg.dry_run:
        log(f"  [DRY-RUN] Would generate token and store at: {secret_name}\n")
        return

    # 1. Resolve admin password
    log("  → Resolving ArgoCD admin password...")
    admin_password = _resolve_admin_password(cfg)
    if not admin_password:
        log("  ⚠ Cannot generate CI bot token without admin credentials\n")
        return

    # 2-3. Login + generate token with retry
    retry_delays = [15, 30, 60]  # seconds between retries
    ci_token = ""

    for attempt, delay in enumerate(retry_delays, start=1):
        log(f"  → Attempt {attempt}/{len(retry_delays)}: login + token generation...")

        # Login to ArgoCD API (not --core mode)
        login_result = run(
            ["argocd", "login", _ARGOCD_API_ENDPOINT,
             "--username", "admin", "--password", admin_password, "--plaintext"],
            cfg=cfg, check=False,
        )

        if login_result.returncode != 0:
            log(f"    ⚠ ArgoCD API login failed (attempt {attempt})")
            if attempt < len(retry_delays):
                log(f"    → Retrying in {delay}s (server may still be starting)...")
                time.sleep(delay)
            continue

        log("    ✓ ArgoCD API login successful")

        # Generate token via ArgoCD API
        result = run(
            ["argocd", "account", "generate-token", "--account", "ci-bot"],
            cfg=cfg, check=False, capture=True,
        )

        ci_token = result.stdout.strip() if result.returncode == 0 else ""

        if ci_token:
            log("    ✓ API token generated")
            break

        log(f"    ⚠ Token generation failed (attempt {attempt})")
        if attempt < len(retry_delays):
            log(f"    → Retrying in {delay}s...")
            time.sleep(delay)

    if not ci_token:
        log("  ✗ Token generation failed after all attempts")
        log("    CI pipeline will use existing token in Secrets Manager\n")
        return

    # 4. Validate the token before storing
    log("  → Validating token against ArgoCD API...")
    validate_result = subprocess.run(
        ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
         "--max-time", "10",
         "-H", f"Authorization: Bearer {ci_token}",
         f"http://{_ARGOCD_API_ENDPOINT}/argocd/api/v1/applications"],
        env={**os.environ, "KUBECONFIG": cfg.kubeconfig},
        capture_output=True, text=True,
    )

    http_code = validate_result.stdout.strip() if validate_result.returncode == 0 else "000"

    if http_code != "200":
        log(f"  ✗ Token validation failed (HTTP {http_code})")
        log("    Will NOT overwrite Secrets Manager — existing token may still be valid\n")
        return

    log("  ✓ Token validated (HTTP 200)")

    # 5. Store token in Secrets Manager
    log(f"  → Pushing token to Secrets Manager: {secret_name}")

    try:
        from botocore.exceptions import ClientError

        sm = get_secrets_client(cfg)
        try:
            sm.create_secret(
                Name=secret_name,
                Description="ArgoCD CI bot API token for pipeline verification",
                SecretString=ci_token,
            )
            log("  ✓ Secret created in Secrets Manager")
        except ClientError as e:
            if e.response["Error"]["Code"] == "ResourceExistsException":
                sm.update_secret(SecretId=secret_name, SecretString=ci_token)
                log("  ✓ Secret updated in Secrets Manager")
            else:
                raise
    except Exception as e:
        log(f"  ⚠ Failed to store token in Secrets Manager: {e}")

    log("")


# ---------------------------------------------------------------------------
# Step 10b: Set ArgoCD admin password from SSM Parameter Store
# ---------------------------------------------------------------------------
def set_admin_password(cfg: Config) -> None:
    """Read the ArgoCD admin password from SSM and patch argocd-secret.

    Follows the same pattern as Grafana credentials — the admin password
    is stored as an SSM SecureString parameter and applied to the cluster
    during bootstrap.

    Flow:
      1. Read plaintext password from SSM: {ssm_prefix}/argocd-admin-password
      2. Hash the password using bcrypt (ArgoCD stores bcrypt hashes)
      3. Patch the 'argocd-secret' Kubernetes Secret with:
         - admin.password: bcrypt hash
         - admin.passwordMtime: current UTC timestamp (triggers ArgoCD refresh)
      4. Restart argocd-server so it picks up the new password

    If the SSM parameter does not exist, this step is skipped gracefully.
    The auto-generated password in argocd-initial-admin-secret remains
    usable as a fallback.

    Prerequisites:
      - SSM parameter: {ssm_prefix}/argocd-admin-password (SecureString)
      - IAM: ssm:GetParameter with WithDecryption on the parameter
      - Python: bcrypt package (installed via requirements.txt)

    Related:
      - Grafana uses the same SSM -> K8s Secret pattern via deploy.py
      - ArgoCD password reset guide: docs/troubleshooting/argocd_admin_reset.md
    """
    log("=== Step 10b: Setting ArgoCD admin password from SSM ===")

    if cfg.dry_run:
        log(f"  [DRY-RUN] Would read {cfg.ssm_prefix}/argocd-admin-password from SSM")
        log("  [DRY-RUN] Would hash with bcrypt and patch argocd-secret\n")
        return

    # 1. Read the admin password from SSM Parameter Store (SecureString)
    ssm_path = f"{cfg.ssm_prefix}/argocd-admin-password"
    log(f"  → Reading admin password from SSM: {ssm_path}")

    try:
        ssm = get_ssm_client(cfg)
        resp = ssm.get_parameter(Name=ssm_path, WithDecryption=True)
        password = resp["Parameter"]["Value"]
        log("  ✓ Admin password resolved from SSM")
    except Exception as e:
        log(f"  ⚠ ArgoCD admin password not found in SSM — {e}")
        log(f"  ⚠ Store the password at: {ssm_path} (SecureString)")
        log("  ⚠ The auto-generated password (argocd-initial-admin-secret) remains usable\n")
        return

    # 2. Hash the password with bcrypt
    #    ArgoCD stores passwords as bcrypt hashes in argocd-secret.
    #    The hash format must be $2a$ or $2b$ (OpenBSD bcrypt).
    try:
        import bcrypt as bcrypt_lib
        hashed = bcrypt_lib.hashpw(password.encode(), bcrypt_lib.gensalt()).decode()
        log("  ✓ Password hashed with bcrypt")
    except ImportError:
        log("  ⚠ bcrypt package not installed — cannot hash password")
        log("  ⚠ Install with: pip3 install bcrypt\n")
        return
    except Exception as e:
        log(f"  ⚠ Failed to hash password — {e}\n")
        return

    # 3. Patch argocd-secret with the bcrypt hash and a passwordMtime timestamp
    #    The passwordMtime field triggers ArgoCD to reload the password.
    #    Without updating this field, the server may continue using the
    #    cached password until the next full restart.
    mtime = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    patch = json.dumps({
        "stringData": {
            "admin.password": hashed,
            "admin.passwordMtime": mtime,
        }
    })

    result = run(
        ["kubectl", "-n", "argocd", "patch", "secret", "argocd-secret",
         "--type", "merge", "-p", patch],
        cfg=cfg, check=False,
    )

    if result.returncode == 0:
        log("  ✓ argocd-secret patched with SSM-managed password")
    else:
        log("  ⚠ Failed to patch argocd-secret")
        log("    Manual fix: see docs/troubleshooting/argocd_admin_reset.md\n")
        return

    # 4. Restart argocd-server to pick up the new password immediately
    result = run(
        ["kubectl", "rollout", "restart", _ARGOCD_SERVER_DEPLOYMENT,
         "-n", "argocd"],
        cfg=cfg, check=False,
    )

    if result.returncode == 0:
        log("  ✓ argocd-server restarted to load new password")
    else:
        log("  ⚠ Failed to restart argocd-server — password will apply on next restart")

    log("")


# ---------------------------------------------------------------------------
# Step 10c: Back up TLS certificate to SSM (for next redeploy)
# ---------------------------------------------------------------------------
def backup_tls_cert(cfg: Config) -> None:
    """Back up the TLS certificate AND ACME account key to SSM after bootstrap.

    cert-manager may still be issuing the certificate when this runs.
    We wait up to 5 minutes for the TLS Secret to appear, then back it up.
    The ACME account key is backed up immediately (it's created when the
    ClusterIssuer first registers with Let's Encrypt).

    If the cert isn't ready yet (e.g. rate-limited), we log a warning
    and skip the TLS backup — the next successful bootstrap will back it up.
    The ACME key backup is always attempted regardless.
    """
    log("=== Step 10c: Backing up TLS certificate + ACME key to SSM ===")

    cert_manager_dir = Path(cfg.argocd_dir).parent / "cert-manager"
    persist_script = cert_manager_dir / "persist-tls-cert.py"

    if not persist_script.exists():
        log(f"  ⚠ {persist_script} not found — skipping TLS backup\n")
        return

    env = {
        **os.environ,
        "KUBECONFIG": cfg.kubeconfig,
        "SSM_PREFIX": cfg.ssm_prefix,
        "AWS_REGION": cfg.aws_region,
    }

    # Wait for the TLS Secret to appear (cert-manager may still be issuing)
    tls_ready = True
    if not cfg.dry_run:
        log("  → Waiting for ops-tls-cert Secret to be ready...")
        max_wait = 10  # attempts × 30s = 5 min
        tls_ready = False
        for attempt in range(1, max_wait + 1):
            check = subprocess.run(
                ["kubectl", "get", "secret", "ops-tls-cert", "-n", "kube-system",
                 "-o", "jsonpath={.data.tls\\.crt}"],
                env={**os.environ, "KUBECONFIG": cfg.kubeconfig},
                capture_output=True, text=True,
            )
            if check.returncode == 0 and check.stdout.strip():
                log(f"  ✓ TLS Secret ready (attempt {attempt}/{max_wait})")
                tls_ready = True
                break
            if attempt < max_wait:
                log(f"    Attempt {attempt}/{max_wait} — not ready, waiting 30s...")
                time.sleep(30)

        if not tls_ready:
            log("  ⚠ TLS Secret not ready after 5 min — skipping TLS backup")
            log("    This is expected if cert-manager is rate-limited")

    # Back up both secrets. The ACME key is always backed up (it's created
    # immediately). The TLS cert is only backed up if it's ready.
    secrets_to_backup = [
        ("letsencrypt-account-key", "cert-manager"),
    ]
    if tls_ready:
        secrets_to_backup.insert(0, ("ops-tls-cert", "kube-system"))

    for secret_name, namespace in secrets_to_backup:
        log(f"  → Backing up {namespace}/{secret_name}...")
        args = [
            sys.executable, str(persist_script),
            "--backup",
            "--secret", secret_name,
            "--namespace", namespace,
        ]
        if cfg.dry_run:
            args.append("--dry-run")

        result = subprocess.run(args, env=env, check=False)

        if result.returncode == 0:
            log(f"  ✓ {secret_name} backup completed")
        else:
            log(f"  ⚠ {secret_name} backup failed — will retry on next bootstrap")

    log("")


# ---------------------------------------------------------------------------
# Step 10d: Back up ArgoCD JWT signing key to SSM
# ---------------------------------------------------------------------------
def backup_argocd_secret_key(cfg: Config) -> None:
    """Persist the ArgoCD JWT signing key to SSM Parameter Store.

    Stores the ``server.secretkey`` from argocd-secret as a SecureString
    in SSM. This enables DR recovery — on a fresh cluster, the signing
    key can be restored from SSM, preserving CI bot token validity.

    The key is stored at: {ssm_prefix}/argocd/server-secret-key
    """
    log("=== Step 10d: Backing up ArgoCD JWT signing key to SSM ===")

    if cfg.dry_run:
        log("  [DRY-RUN] Would read server.secretkey and store in SSM\n")
        return

    # Read current signing key from the cluster
    result = subprocess.run(
        ["kubectl", "get", "secret", "argocd-secret", "-n", "argocd",
         "-o", "jsonpath={.data.server\\.secretkey}"],
        env={**os.environ, "KUBECONFIG": cfg.kubeconfig},
        capture_output=True, text=True,
    )

    if result.returncode != 0 or not result.stdout.strip():
        log("  ⚠ Could not read server.secretkey — skipping SSM backup\n")
        return

    signing_key_b64 = result.stdout.strip()

    try:
        ssm = get_ssm_client(cfg)
        param_name = f"{cfg.ssm_prefix}/argocd/server-secret-key"

        ssm.put_parameter(
            Name=param_name,
            Value=signing_key_b64,
            Type="SecureString",
            Overwrite=True,
            Description="ArgoCD JWT signing key (base64) — preserved across bootstrap re-runs",
        )
        log(f"  ✓ Signing key backed up to SSM: {param_name}\n")

    except Exception as e:
        log(f"  ⚠ Failed to back up signing key to SSM — {e}")
        log("    Token validity is still preserved in-cluster\n")


# ---------------------------------------------------------------------------
# Step 11: Summary
# ---------------------------------------------------------------------------
def print_summary(cfg: Config) -> None:
    """Print ArgoCD pods, applications, and admin access info."""
    log("=== ArgoCD Bootstrap Summary ===\n")

    if cfg.dry_run:
        log("  [DRY-RUN] Would show pods and applications\n")
        return

    run(["kubectl", "get", "pods", "-n", "argocd", "-o", "wide"], cfg=cfg, check=False)
    log("")
    run(["kubectl", "get", "applications", "-n", "argocd"], cfg=cfg, check=False)
    log("")

    # Display ArgoCD admin access info
    #
    # The admin password is now managed via SSM Parameter Store
    # (SecureString) at {ssm_prefix}/argocd-admin-password.
    # It is applied during Step 10b.
    #
    # If SSM was not configured, the auto-generated password in
    # argocd-initial-admin-secret is still usable.
    log("=== ArgoCD Admin Access ===")
    log("  URL:  https://<eip>/argocd")
    log("  User: admin")
    log(f"  Password source: SSM '{cfg.ssm_prefix}/argocd-admin-password'")
    log("")
    log("  If SSM parameter is not set, retrieve the auto-generated password:")
    log("    kubectl -n argocd get secret argocd-initial-admin-secret \\")
    log('      -o jsonpath="{.data.password}" | base64 -d && echo')

    log(f"\n✓ ArgoCD bootstrap complete ({datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')})")
