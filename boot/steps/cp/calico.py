"""Step 4 — Install Calico CNI via Tigera operator."""
from __future__ import annotations

import time
from pathlib import Path

from common import (
    StepRunner,
    get_imds_value,
    log_info,
    log_warn,
    run_cmd,
)
from boot_helpers.config import BootConfig

# ── Constants ──────────────────────────────────────────────────────────────

CALICO_MARKER = "/etc/kubernetes/.calico-installed"
CACHED_OPERATOR = "/opt/calico/tigera-operator.yaml"
KUBECONFIG_ENV = {"KUBECONFIG": "/etc/kubernetes/admin.conf"}


def _calico_installation_yaml(pod_cidr: str) -> str:
    """Generate the Calico Installation custom resource YAML."""
    return f"""apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  calicoNetwork:
    bgp: Disabled
    ipPools:
      - cidr: {pod_cidr}
        encapsulation: VXLAN
        natOutgoing: Enabled
        nodeSelector: all()
    linuxDataplane: Iptables
"""


# ── Step ───────────────────────────────────────────────────────────────────

def step_install_calico(cfg: BootConfig) -> None:
    """Step 4: Install Calico CNI via Tigera operator.

    Args:
        cfg: Bootstrap configuration.
    """
    with StepRunner("install-calico", skip_if=CALICO_MARKER) as step:
        if step.skipped:
            return

        # Install operator
        if Path(CACHED_OPERATOR).exists():
            log_info("Using pre-cached operator from Golden AMI")
            source = CACHED_OPERATOR
        else:
            log_warn("Pre-cached operator not found, downloading from GitHub")
            source = (
                f"https://raw.githubusercontent.com/projectcalico/calico/"
                f"{cfg.calico_version}/manifests/tigera-operator.yaml"
            )

        run_cmd(
            ["kubectl", "apply", "--server-side", "--force-conflicts", "-f", source],
            env=KUBECONFIG_ENV,
        )

        # The tigera-operator uses the kubernetes ClusterIP (10.96.0.1) by default
        # to reach the API server. On a fresh node the pod network doesn't exist yet,
        # so that address is unreachable — the operator loops on i/o timeout and never
        # reconciles the Installation CR. Providing this ConfigMap tells the operator
        # to use the node IP directly, bypassing the ClusterIP entirely.
        private_ip = get_imds_value("local-ipv4")
        if private_ip:
            log_info(
                f"Creating kubernetes-services-endpoint ConfigMap "
                f"(operator → {private_ip}:6443)"
            )
            endpoint_cm = f"""apiVersion: v1
kind: ConfigMap
metadata:
  name: kubernetes-services-endpoint
  namespace: tigera-operator
data:
  KUBERNETES_SERVICE_HOST: "{private_ip}"
  KUBERNETES_SERVICE_PORT: "6443"
"""
            run_cmd(
                ["kubectl", "apply", "-f", "-"],
                input=endpoint_cm.encode(),
                env=KUBECONFIG_ENV,
            )
        else:
            log_warn(
                "Could not retrieve private IP from IMDS — "
                "skipping kubernetes-services-endpoint ConfigMap. "
                "Calico operator may fail to reach the API server."
            )

        log_info("Waiting for Calico operator deployment...")
        run_cmd(
            ["kubectl", "wait", "--for=condition=Available",
             "deployment/tigera-operator", "-n", "tigera-operator",
             "--timeout=120s"],
            check=False, env=KUBECONFIG_ENV,
        )

        # Apply Installation CR
        installation_yaml = _calico_installation_yaml(cfg.pod_cidr)
        log_info("Applying Calico Installation resource...")
        run_cmd(
            f"echo '{installation_yaml}' | kubectl apply -f -",
            shell=True, env=KUBECONFIG_ENV,
        )

        # Wait for pods
        log_info("Waiting for Calico pods to become ready...")
        for i in range(1, 121):
            result = run_cmd(
                ["kubectl", "get", "pods", "-n", "calico-system", "--no-headers"],
                check=False, env=KUBECONFIG_ENV,
            )
            if result.returncode == 0 and result.stdout.strip():
                lines = result.stdout.strip().splitlines()
                total = len(lines)
                running = sum(1 for line in lines if "Running" in line)
                if total > 0 and running == total:
                    log_info(f"Calico pods ready ({running}/{total}, waited {i}s)")
                    break
                if i == 120:
                    log_warn(f"Calico pods not fully ready after 120s ({running}/{total})")
                    run_cmd(
                        ["kubectl", "get", "pods", "-n", "calico-system"],
                        check=False, env=KUBECONFIG_ENV,
                    )
            time.sleep(1)

        step.details["calico_version"] = cfg.calico_version
        step.details["pod_cidr"] = cfg.pod_cidr
        log_info("Calico CNI installed successfully")
