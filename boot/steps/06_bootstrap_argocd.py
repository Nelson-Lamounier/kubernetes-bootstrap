#!/usr/bin/env python3
"""
@format
Step 06 — Bootstrap ArgoCD

Delegates to the existing bootstrap_argocd.py script which handles:
- ArgoCD namespace creation
- ArgoCD manifest installation (install.yaml)
- Git repository secret configuration
- Root Application (App-of-Apps) creation

Idempotent: bootstrap_argocd.py uses create-or-apply semantics.

Expected environment variables:
    MOUNT_POINT      — Local mount point (default: /data)
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import StepRunner, run_cmd, log_info, log_warn

# =============================================================================
# Configuration
# =============================================================================

MOUNT_POINT = os.environ.get("MOUNT_POINT", "/data")
ADMIN_CONF = "/etc/kubernetes/admin.conf"


# =============================================================================
# Logic
# =============================================================================

def bootstrap_argocd() -> None:
    """Execute the ArgoCD bootstrap via the existing wrapper script."""
    bootstrap_dir = Path(MOUNT_POINT) / "k8s-bootstrap"
    argocd_dir = bootstrap_dir / "system" / "argocd"
    bootstrap_script = argocd_dir / "bootstrap-argocd.sh"

    if not bootstrap_script.exists():
        log_warn(
            f"ArgoCD bootstrap script not found at {bootstrap_script}. "
            f"Manifests may not have been synced from S3 yet."
        )
        raise FileNotFoundError(f"Missing: {bootstrap_script}")

    # Set required env vars
    env = {
        "KUBECONFIG": ADMIN_CONF,
        "ARGOCD_DIR": str(argocd_dir),
    }

    log_info(f"Executing ArgoCD bootstrap: {bootstrap_script}")
    run_cmd(
        [str(bootstrap_script)],
        env=env,
        capture=False,
        timeout=600,
    )

    log_info(
        "ArgoCD bootstrap complete. "
        "ArgoCD now manages: traefik, metrics-server, "
        "local-path-provisioner, monitoring, nextjs"
    )


# =============================================================================
# Main
# =============================================================================

def main() -> None:
    with StepRunner("bootstrap-argocd") as step:
        if step.skipped:
            return

        bootstrap_argocd()
        step.details["argocd_dir"] = str(
            Path(MOUNT_POINT) / "k8s-bootstrap" / "system" / "argocd"
        )


if __name__ == "__main__":
    main()
