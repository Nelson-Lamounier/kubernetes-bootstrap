"""Step 8 — Comprehensive post-boot health checks.

Validates cluster readiness across five dimensions:
1. Node readiness (all nodes in Ready state)
2. Core namespace pods (kube-system, calico-system, tigera-operator)
3. ArgoCD pods health
4. ArgoCD Application sync status (if argocd CLI is present)
5. Outside-in API Server connectivity via Load Balancer DNS
"""
from __future__ import annotations

import os

from common import (
    StepRunner,
    log_error,
    log_info,
    log_warn,
    run_cmd,
    ssm_get,
)
from boot_helpers.config import BootConfig

# ── Constants ──────────────────────────────────────────────────────────────

KUBECONFIG_ENV = {"KUBECONFIG": "/etc/kubernetes/admin.conf"}
REQUIRED_NAMESPACES = [
    "kube-system",
    "calico-system",
    "tigera-operator",
]
SSM_PREFIX = os.environ.get("SSM_PREFIX", "/k8s/development")

# API Server port used in the kubeadm configuration
API_SERVER_PORT = 6443


# ── Step ───────────────────────────────────────────────────────────────────

def _count_ready_nodes_in_pool(pool: str) -> int:
    """Count Ready nodes with a given node-pool label.

    Uses a label selector query so this scales correctly with dynamic ASGs —
    there is no fixed expected count. Returns 0 on any kubectl failure.

    Args:
        pool: The ``node-pool`` label value to filter by (e.g. ``general``).

    Returns:
        Number of nodes in the pool that are Ready and not NotReady.
    """
    result = run_cmd(
        ["kubectl", "get", "nodes",
         "-l", f"node-pool={pool}",
         "--no-headers"],
        check=False, env=KUBECONFIG_ENV,
    )
    if result.returncode != 0 or not result.stdout.strip():
        return 0
    return sum(
        1 for line in result.stdout.strip().splitlines()
        if "Ready" in line and "NotReady" not in line
    )


def step_verify_cluster(cfg: BootConfig) -> None:
    """Step 8: Comprehensive post-boot health checks.

    Validates node readiness, core namespace pods, ArgoCD health,
    ArgoCD Application sync status, and outside-in API connectivity.

    Node readiness uses pool-label selectors (``node-pool=<pool>``) rather
    than a fixed count, so the check scales correctly with dynamic ASGs.
    Worker pools (general, monitoring) are **non-blocking** — this step runs
    at the end of ``kubeadm init``, before workers have joined, so a missing
    worker pool is expected and only warrants a log warning, not a failure.

    Args:
        cfg: Bootstrap configuration.
    """
    with StepRunner("verify-cluster") as step:
        if step.skipped:
            return

        results: dict[str, bool] = {}

        # ── 1. Pool-aware node readiness ───────────────────────────────
        log_info("Checking pool-aware node readiness...")
        pool_counts: dict[str, int] = {}
        for pool in ("control-plane", "general", "monitoring"):
            count = _count_ready_nodes_in_pool(pool)
            pool_counts[pool] = count
            if count > 0:
                log_info(f"  ✓ node-pool={pool}: {count} Ready node(s)")
            else:
                log_warn(f"  ⚠ node-pool={pool}: 0 Ready nodes")

        # Control plane must have at least 1 ready node — this is a hard gate.
        # Worker pools are non-blocking: they are absent at kubeadm init time.
        cp_ready = pool_counts.get("control-plane", 0) > 0
        if not cp_ready:
            log_error("Control plane node is not in Ready state")
        results["node_ready"] = cp_ready
        step.details["pool_node_counts"] = pool_counts

        # ── 2. Core namespaces ─────────────────────────────────────────
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

        # ── 3. ArgoCD pods ─────────────────────────────────────────────
        log_info("Checking ArgoCD...")
        result = run_cmd(
            ["kubectl", "get", "pods", "-n", "argocd", "--no-headers"],
            check=False, env=KUBECONFIG_ENV,
        )
        if result.returncode != 0 or not result.stdout.strip():
            log_warn(
                "  ⚠ ArgoCD namespace not found or empty "
                "(may not be bootstrapped yet)"
            )
            results["argocd"] = True
        else:
            lines = result.stdout.strip().splitlines()
            total = len(lines)
            running = sum(1 for line in lines if "Running" in line)
            log_info(f"  ✓ argocd: {running}/{total} pods running")
            results["argocd"] = running > 0

        # ── 4. ArgoCD Application sync status ──────────────────────────
        _check_argocd_app_health(results)

        # ── 5. Outside-in API Server connectivity ──────────────────────
        _check_api_connectivity(results)

        step.details = results
        failures = [k for k, v in results.items() if not v]
        if failures:
            log_warn(f"Verification completed with warnings: {failures}")
        else:
            log_info("✓ All post-boot checks passed")


# ── Check: ArgoCD Application health ──────────────────────────────────────

def _check_argocd_app_health(results: dict[str, bool]) -> None:
    """Check ArgoCD Application sync status using the argocd CLI.

    Identifies applications in Degraded, Progressing, or OutOfSync state.
    Gracefully skips if the ArgoCD CLI is not installed.

    Args:
        results: Mutable results dict to update.
    """
    log_info("Checking ArgoCD Application sync status...")

    # Verify CLI is available
    which_result = run_cmd(
        ["which", "argocd"], check=False, env=KUBECONFIG_ENV,
    )
    if which_result.returncode != 0:
        log_warn(
            "  ⚠ ArgoCD CLI not installed — "
            "skipping Application sync check"
        )
        results["argocd_apps"] = True  # Non-blocking
        return

    # List all applications in a parseable format
    result = run_cmd(
        [
            "argocd", "app", "list",
            "--core",  # Direct K8s API access, no argocd-server needed
            "-o", "name",
        ],
        check=False,
        env=KUBECONFIG_ENV,
    )
    if result.returncode != 0 or not result.stdout.strip():
        log_warn("  ⚠ Could not list ArgoCD Applications")
        results["argocd_apps"] = True  # Non-blocking
        return

    app_names = result.stdout.strip().splitlines()
    unhealthy_apps: list[str] = []

    for app_name in app_names:
        app_name = app_name.strip()
        if not app_name:
            continue

        # Get the health and sync status of each app
        status_result = run_cmd(
            [
                "argocd", "app", "get", app_name,
                "--core",
                "-o", "json",
            ],
            check=False,
            env=KUBECONFIG_ENV,
        )
        if status_result.returncode != 0:
            log_warn(f"  ⚠ Could not get status for {app_name}")
            continue

        import json
        try:
            app_data = json.loads(status_result.stdout)
            health = (
                app_data.get("status", {})
                .get("health", {})
                .get("status", "Unknown")
            )
            sync = (
                app_data.get("status", {})
                .get("sync", {})
                .get("status", "Unknown")
            )

            if health in ("Degraded", "Missing"):
                log_warn(
                    f"  ⚠ {app_name}: health={health}, sync={sync}"
                )
                unhealthy_apps.append(app_name)
            elif sync == "OutOfSync":
                log_warn(f"  ⚠ {app_name}: sync={sync}")
            else:
                log_info(
                    f"  ✓ {app_name}: health={health}, sync={sync}"
                )
        except (json.JSONDecodeError, KeyError):
            log_warn(f"  ⚠ Could not parse status for {app_name}")

    results["argocd_apps"] = len(unhealthy_apps) == 0


# ── Check: Outside-in API Server connectivity ─────────────────────────────

def _check_api_connectivity(results: dict[str, bool]) -> None:
    """Verify API Server reachability through the Load Balancer DNS.

    Makes an HTTPS request to the NLB endpoint to confirm that Security
    Group rules, Load Balancer health checks, and DNS resolution are
    all functioning end-to-end. This catches issues invisible from
    within the cluster (e.g., SG misconfigurations, NLB target health).

    The API Server DNS name is resolved from SSM Parameter Store.

    Args:
        results: Mutable results dict to update.
    """
    log_info("Checking outside-in API Server connectivity...")

    # Resolve the API Server DNS from SSM (set during kubeadm init)
    api_dns = ssm_get(f"{SSM_PREFIX}/api-server-dns")
    if not api_dns:
        log_warn(
            "  ⚠ SSM parameter api-server-dns not found — "
            "skipping outside-in check"
        )
        results["api_connectivity"] = True  # Non-blocking
        return

    # curl the /healthz endpoint through the NLB
    # --insecure because the API server cert is self-signed for the
    # internal cluster DNS, not the NLB DNS
    url = f"https://{api_dns}:{API_SERVER_PORT}/healthz"
    log_info(f"  Checking {url}")

    result = run_cmd(
        [
            "curl", "-sSk",
            "--connect-timeout", "10",
            "--max-time", "15",
            "-o", "/dev/null",
            "-w", "%{http_code}",
            url,
        ],
        check=False,
    )

    if result.returncode == 0 and result.stdout.strip() in ("200", "401"):
        # 200 = /healthz public, 401 = auth required (both confirm
        # the API server is reachable through the NLB)
        log_info(
            f"  ✓ API Server reachable via NLB "
            f"(HTTP {result.stdout.strip()})"
        )
        results["api_connectivity"] = True
    else:
        http_code = result.stdout.strip() if result.stdout else "N/A"
        log_warn(
            f"  ⚠ API Server not reachable via NLB — "
            f"HTTP {http_code}, exit={result.returncode}"
        )
        results["api_connectivity"] = False
