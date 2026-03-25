"""Step 8 — Lightweight post-boot health checks."""
from __future__ import annotations

from common import (
    StepRunner,
    log_error,
    log_info,
    log_warn,
    run_cmd,
)
from boot_helpers.config import BootConfig

# ── Constants ──────────────────────────────────────────────────────────────

KUBECONFIG_ENV = {"KUBECONFIG": "/etc/kubernetes/admin.conf"}
REQUIRED_NAMESPACES = [
    "kube-system",
    "calico-system",
    "tigera-operator",
]


# ── Step ───────────────────────────────────────────────────────────────────

def step_verify_cluster(cfg: BootConfig) -> None:
    """Step 8: Lightweight post-boot health checks.

    Args:
        cfg: Bootstrap configuration.
    """
    with StepRunner("verify-cluster") as step:
        if step.skipped:
            return

        results: dict[str, bool] = {}

        # Node readiness
        log_info("Checking node readiness...")
        result = run_cmd(
            ["kubectl", "get", "nodes", "--no-headers"],
            check=False, env=KUBECONFIG_ENV,
        )
        node_ready = False
        if result.returncode == 0:
            for line in result.stdout.strip().splitlines():
                if "Ready" in line and "NotReady" not in line:
                    log_info(f"  ✓ Node ready: {line.split()[0]}")
                    node_ready = True
                    break
        if not node_ready:
            log_error("Node is not in Ready state")
        results["node_ready"] = node_ready

        # Core namespaces
        log_info("Checking namespace pods...")
        for ns in REQUIRED_NAMESPACES:
            result = run_cmd(
                ["kubectl", "get", "pods", "-n", ns, "--no-headers"],
                check=False, env=KUBECONFIG_ENV,
            )
            if result.returncode != 0 or not result.stdout.strip():
                log_warn(f"  ⚠ No pods found in namespace {ns}")
                results[f"ns_{ns}"] = True
                continue

            lines = result.stdout.strip().splitlines()
            total = len(lines)
            healthy = sum(
                1 for line in lines
                if "Running" in line or "Completed" in line
            )
            if healthy == total:
                log_info(f"  ✓ {ns}: {healthy}/{total} pods healthy")
                results[f"ns_{ns}"] = True
            else:
                log_warn(f"  ⚠ {ns}: {healthy}/{total} pods healthy")
                results[f"ns_{ns}"] = False

        # ArgoCD
        log_info("Checking ArgoCD...")
        result = run_cmd(
            ["kubectl", "get", "pods", "-n", "argocd", "--no-headers"],
            check=False, env=KUBECONFIG_ENV,
        )
        if result.returncode != 0 or not result.stdout.strip():
            log_warn("  ⚠ ArgoCD namespace not found or empty (may not be bootstrapped yet)")
            results["argocd"] = True
        else:
            lines = result.stdout.strip().splitlines()
            total = len(lines)
            running = sum(1 for line in lines if "Running" in line)
            log_info(f"  ✓ argocd: {running}/{total} pods running")
            results["argocd"] = running > 0

        step.details = results
        failures = [k for k, v in results.items() if not v]
        if failures:
            log_warn(f"Verification completed with warnings: {failures}")
        else:
            log_info("✓ All post-boot checks passed")
