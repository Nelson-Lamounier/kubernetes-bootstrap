"""Step 4b — Install AWS Cloud Controller Manager via Helm.

The CCM removes the ``node.cloudprovider.kubernetes.io/uninitialized``
taint from nodes, which is required before any pods (including ArgoCD
and CoreDNS) can be scheduled. ArgoCD will adopt the Helm release on
subsequent syncs via the aws-cloud-controller-manager Application.
"""
from __future__ import annotations

import time
from pathlib import Path

from common import (
    StepRunner,
    log_info,
    log_warn,
    run_cmd,
)
from boot_helpers.config import BootConfig

# ── Constants ──────────────────────────────────────────────────────────────

CCM_MARKER = "/etc/kubernetes/.ccm-installed"
CCM_HELM_REPO = "https://kubernetes.github.io/cloud-provider-aws"
CCM_HELM_RELEASE = "aws-cloud-controller-manager"
CCM_HELM_CHART = "aws-cloud-controller-manager"
CCM_HELM_NAMESPACE = "kube-system"
CCM_TAINT_TIMEOUT_SECONDS = 120
KUBECONFIG_ENV = {"KUBECONFIG": "/etc/kubernetes/admin.conf"}

CCM_HELM_VALUES = """\
args:
  - --v=2
  - --cloud-provider=aws
  - --configure-cloud-routes=false
nodeSelector:
  node-role.kubernetes.io/control-plane: ""
tolerations:
  - key: node-role.kubernetes.io/control-plane
    effect: NoSchedule
  - key: node.cloudprovider.kubernetes.io/uninitialized
    value: "true"
    effect: NoSchedule
hostNetworking: true
"""


# ── Step ───────────────────────────────────────────────────────────────────

def step_install_ccm(cfg: BootConfig) -> None:
    """Step 4b: Install AWS Cloud Controller Manager via Helm.

    Args:
        cfg: Bootstrap configuration.
    """
    with StepRunner("install-ccm", skip_if=CCM_MARKER) as step:
        if step.skipped:
            return

        values_path = Path("/tmp/ccm-values.yaml")
        values_path.write_text(CCM_HELM_VALUES)

        try:
            log_info("Adding cloud-provider-aws Helm repo...")
            run_cmd(
                ["helm", "repo", "add", "aws-cloud-controller-manager",
                 CCM_HELM_REPO, "--force-update"],
                env=KUBECONFIG_ENV,
            )
            run_cmd(["helm", "repo", "update"], env=KUBECONFIG_ENV)

            log_info("Installing AWS Cloud Controller Manager...")
            run_cmd(
                ["helm", "upgrade", "--install",
                 CCM_HELM_RELEASE, f"aws-cloud-controller-manager/{CCM_HELM_CHART}",
                 "--namespace", CCM_HELM_NAMESPACE,
                 "--values", str(values_path),
                 "--wait", "--timeout", "120s"],
                env=KUBECONFIG_ENV,
            )
            log_info("✓ AWS CCM Helm release installed")

            log_info("Waiting for CCM to remove the 'uninitialised' taint...")
            taint_removed = False
            for i in range(1, CCM_TAINT_TIMEOUT_SECONDS + 1):
                result = run_cmd(
                    ["kubectl", "get", "nodes", "-o",
                     "jsonpath={.items[*].spec.taints}"],
                    check=False, env=KUBECONFIG_ENV,
                )
                if result.returncode == 0:
                    taints_json = result.stdout.strip()
                    if "node.cloudprovider.kubernetes.io/uninitialized" not in taints_json:
                        log_info(
                            f"✓ 'uninitialised' taint removed from all nodes "
                            f"(waited {i}s)"
                        )
                        taint_removed = True
                        break
                time.sleep(1)

            if not taint_removed:
                log_warn(
                    f"'uninitialised' taint still present after "
                    f"{CCM_TAINT_TIMEOUT_SECONDS}s — ArgoCD may fail to schedule. "
                    f"Check CCM pod logs: kubectl logs -n kube-system "
                    f"-l app.kubernetes.io/name=aws-cloud-controller-manager"
                )

            step.details["helm_release"] = CCM_HELM_RELEASE
            step.details["taint_removed"] = taint_removed
            log_info("AWS Cloud Controller Manager installed successfully")

        finally:
            if values_path.exists():
                values_path.unlink()
