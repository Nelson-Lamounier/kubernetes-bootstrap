"""Step 7 — Bootstrap ArgoCD and apply App-of-Apps root application."""
from __future__ import annotations

from pathlib import Path

from common import (
    StepRunner,
    log_info,
    log_warn,
    run_cmd,
)
from boot_helpers.config import BootConfig

# ── Constants ──────────────────────────────────────────────────────────────

ADMIN_CONF = "/etc/kubernetes/admin.conf"


# ── Step ───────────────────────────────────────────────────────────────────

def step_bootstrap_argocd(cfg: BootConfig) -> None:
    """Step 7: Install ArgoCD and apply App-of-Apps root application.

    Args:
        cfg: Bootstrap configuration.
    """
    with StepRunner("bootstrap-argocd") as step:
        if step.skipped:
            return

        bootstrap_dir = Path(cfg.mount_point) / "k8s-bootstrap"
        argocd_dir = bootstrap_dir / "system" / "argocd"
        bootstrap_script = argocd_dir / "bootstrap-argocd.sh"

        if not bootstrap_script.exists():
            log_warn(
                f"ArgoCD bootstrap script not found at {bootstrap_script}. "
                f"Manifests may not have been synced from S3 yet."
            )
            raise FileNotFoundError(f"Missing: {bootstrap_script}")

        env = {
            "KUBECONFIG": ADMIN_CONF,
            "ARGOCD_DIR": str(argocd_dir),
        }

        log_info(f"Executing ArgoCD bootstrap: {bootstrap_script}")
        run_cmd(
            [str(bootstrap_script)],
            env=env,
            capture=False,
            timeout=800,
        )

        log_info(
            "ArgoCD bootstrap complete. "
            "ArgoCD now manages: traefik, metrics-server, "
            "aws-ebs-csi-driver, monitoring, nextjs"
        )
        step.details["argocd_dir"] = str(argocd_dir)
