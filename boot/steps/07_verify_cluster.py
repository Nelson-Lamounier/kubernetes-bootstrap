#!/usr/bin/env python3
"""
@format
Step 07 — Verify Cluster (Lightweight Post-Boot Check)

Performs basic health checks after bootstrap:
- Node is Ready
- System pods are running (kube-apiserver, kube-scheduler, etc.)
- Calico pods are running
- ArgoCD pods are running

This is a lightweight check designed to run quickly after bootstrap.
The full verification (verify-cluster.sh) runs as a separate pipeline step.

Idempotent: read-only checks.

Expected environment variables:
    None required.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import StepRunner, run_cmd, log_info, log_warn, log_error

# =============================================================================
# Configuration
# =============================================================================

KUBECONFIG_ENV = {"KUBECONFIG": "/etc/kubernetes/admin.conf"}

REQUIRED_NAMESPACES = [
    "kube-system",
    "calico-system",
    "tigera-operator",
]


# =============================================================================
# Checks
# =============================================================================

def check_node_ready() -> bool:
    """Verify this node is in Ready state."""
    result = run_cmd(
        ["kubectl", "get", "nodes", "--no-headers"],
        check=False, env=KUBECONFIG_ENV,
    )
    if result.returncode != 0:
        log_error("Cannot query nodes")
        return False

    for line in result.stdout.strip().splitlines():
        if "Ready" in line and "NotReady" not in line:
            log_info(f"  ✓ Node ready: {line.split()[0]}")
            return True

    log_error("Node is not in Ready state")
    return False


def check_namespace_pods(namespace: str) -> bool:
    """Verify pods in a namespace are running."""
    result = run_cmd(
        ["kubectl", "get", "pods", "-n", namespace, "--no-headers"],
        check=False, env=KUBECONFIG_ENV,
    )
    if result.returncode != 0 or not result.stdout.strip():
        log_warn(f"  ⚠ No pods found in namespace {namespace}")
        return True  # Non-fatal: namespace may be empty or managed by ArgoCD

    lines = result.stdout.strip().splitlines()
    total = len(lines)
    healthy = sum(
        1 for line in lines
        if "Running" in line or "Completed" in line
    )

    if healthy == total:
        log_info(f"  ✓ {namespace}: {healthy}/{total} pods healthy")
        return True
    else:
        log_warn(f"  ⚠ {namespace}: {healthy}/{total} pods healthy")
        return False


def check_argocd() -> bool:
    """Check if ArgoCD pods are running."""
    result = run_cmd(
        ["kubectl", "get", "pods", "-n", "argocd", "--no-headers"],
        check=False, env=KUBECONFIG_ENV,
    )
    if result.returncode != 0 or not result.stdout.strip():
        log_warn("  ⚠ ArgoCD namespace not found or empty (may not be bootstrapped yet)")
        return True  # Non-fatal: ArgoCD might bootstrap async

    lines = result.stdout.strip().splitlines()
    total = len(lines)
    running = sum(1 for line in lines if "Running" in line)
    log_info(f"  ✓ argocd: {running}/{total} pods running")
    return running > 0


# =============================================================================
# Main
# =============================================================================

def main() -> None:
    with StepRunner("verify-cluster") as step:
        if step.skipped:
            return

        results = {}

        # 1. Node readiness
        log_info("Checking node readiness...")
        results["node_ready"] = check_node_ready()

        # 2. Core namespaces
        log_info("Checking namespace pods...")
        for ns in REQUIRED_NAMESPACES:
            results[f"ns_{ns}"] = check_namespace_pods(ns)

        # 3. ArgoCD
        log_info("Checking ArgoCD...")
        results["argocd"] = check_argocd()

        # Summary
        step.details = results
        failures = [k for k, v in results.items() if not v]

        if failures:
            log_warn(f"Verification completed with warnings: {failures}")
        else:
            log_info("✓ All post-boot checks passed")


if __name__ == "__main__":
    main()
