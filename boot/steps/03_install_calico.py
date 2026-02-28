#!/usr/bin/env python3
"""
@format
Step 03 — Install Calico CNI

Installs the Calico CNI (Container Network Interface) using the Tigera
operator. Configures IP pools with the cluster's pod CIDR.

Idempotent: uses kubectl apply (create-or-update semantics).

Expected environment variables:
    POD_CIDR         — Pod network CIDR (default: 192.168.0.0/16)
    CALICO_VERSION   — Calico version (default: v3.29.3)
"""

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import StepRunner, run_cmd, log_info, log_warn

# =============================================================================
# Configuration
# =============================================================================

POD_CIDR = os.environ.get("POD_CIDR", "192.168.0.0/16")
CALICO_VERSION = os.environ.get("CALICO_VERSION", "v3.29.3")
KUBECONFIG_ENV = {"KUBECONFIG": "/etc/kubernetes/admin.conf"}
CACHED_OPERATOR = "/opt/calico/tigera-operator.yaml"

CALICO_INSTALLATION = f"""apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  calicoNetwork:
    ipPools:
      - cidr: {POD_CIDR}
        encapsulation: VXLANCrossSubnet
        natOutgoing: Enabled
        nodeSelector: all()
    linuxDataplane: Iptables
"""


# =============================================================================
# Logic
# =============================================================================

def install_operator() -> None:
    """Apply the Tigera operator manifest (prefer cached from Golden AMI)."""
    if Path(CACHED_OPERATOR).exists():
        log_info("Using pre-cached operator from Golden AMI")
        source = CACHED_OPERATOR
    else:
        log_warn("Pre-cached operator not found, downloading from GitHub")
        source = (
            f"https://raw.githubusercontent.com/projectcalico/calico/"
            f"{CALICO_VERSION}/manifests/tigera-operator.yaml"
        )

    # create-or-apply pattern
    result = run_cmd(
        ["kubectl", "create", "-f", source],
        check=False, env=KUBECONFIG_ENV,
    )
    if result.returncode != 0:
        run_cmd(["kubectl", "apply", "-f", source], env=KUBECONFIG_ENV)

    # Wait for operator
    log_info("Waiting for Calico operator deployment...")
    run_cmd(
        ["kubectl", "wait", "--for=condition=Available",
         "deployment/tigera-operator", "-n", "tigera-operator",
         "--timeout=120s"],
        check=False, env=KUBECONFIG_ENV,
    )


def apply_installation() -> None:
    """Apply the Calico Installation custom resource."""
    log_info("Applying Calico Installation resource...")
    run_cmd(
        f"echo '{CALICO_INSTALLATION}' | kubectl apply -f -",
        shell=True, env=KUBECONFIG_ENV,
    )


def wait_for_calico_pods() -> None:
    """Wait for all Calico pods to reach Running state."""
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
                return
            if i == 120:
                log_warn(f"Calico pods not fully ready after 120s ({running}/{total})")
                run_cmd(
                    ["kubectl", "get", "pods", "-n", "calico-system"],
                    check=False, env=KUBECONFIG_ENV,
                )
        time.sleep(1)


# =============================================================================
# Main
# =============================================================================

def main() -> None:
    with StepRunner("install-calico") as step:
        if step.skipped:
            return

        install_operator()
        apply_installation()
        wait_for_calico_pods()

        step.details["calico_version"] = CALICO_VERSION
        step.details["pod_cidr"] = POD_CIDR
        log_info("Calico CNI installed successfully")


if __name__ == "__main__":
    main()
