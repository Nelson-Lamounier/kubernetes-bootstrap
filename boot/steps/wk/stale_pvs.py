"""Step 5 — Clean stale PVs/PVCs pinned to dead nodes (monitoring worker only).

When a monitoring worker is replaced by ASG, the old node's EBS CSI
PersistentVolumes may remain in the cluster, pinned via ``nodeAffinity`` to
the dead hostname. Pods cannot schedule because the PVs reference a node
that no longer exists.

This step:
  1. Discovers PVs in the ``monitoring`` namespace bound to dead nodes
  2. Deletes the orphaned PVCs (which releases the PVs)
  3. Deletes the Released/Failed PVs

ArgoCD or Helm will recreate the PVCs on the next sync, and
the ``aws-ebs-csi-driver`` will provision fresh EBS volumes on the new node.

Gated to monitoring workers only via ``NODE_LABEL`` check.
Idempotent: if no stale PVs exist, this step is a no-op.
"""
from __future__ import annotations

import base64
import json
import os
import time
from pathlib import Path

from common import (
    StepRunner,
    log_info,
    log_warn,
    run_cmd,
    ssm_get,
)
from boot_helpers.config import BootConfig

# ── Constants ──────────────────────────────────────────────────────────────

MONITORING_WORKER_LABEL = "workload=monitoring"
MONITORING_NAMESPACE = "monitoring"
STALE_PV_CLEANUP_MARKER = "/tmp/.stale-pv-cleanup-done"


# ── Helpers ────────────────────────────────────────────────────────────────

def get_cluster_node_names() -> set[str]:
    """Get the set of node hostnames currently registered in the cluster."""
    result = run_cmd(
        ["kubectl", "get", "nodes", "-o",
         "jsonpath={.items[*].metadata.name}"],
        check=False,
    )
    if result.returncode != 0:
        log_warn("Failed to list cluster nodes — skipping stale PV cleanup")
        return set()
    return set(result.stdout.strip().split())


def find_stale_pvs(live_nodes: set[str]) -> list[dict[str, str]]:
    """Find PVs with node affinity pointing to nodes not in the cluster.

    Returns:
        List of dicts with ``pv_name``, ``pvc_name``, ``pvc_namespace``,
        ``dead_node``.
    """
    result = run_cmd(
        ["kubectl", "get", "pv", "-o", "json"],
        check=False,
    )
    if result.returncode != 0:
        log_warn("Failed to list PVs — skipping stale PV cleanup")
        return []

    try:
        pv_list = json.loads(result.stdout)
    except json.JSONDecodeError:
        log_warn("Failed to parse PV list JSON — skipping stale PV cleanup")
        return []

    stale: list[dict[str, str]] = []
    for pv in pv_list.get("items", []):
        pv_name = pv.get("metadata", {}).get("name", "")

        claim_ref = pv.get("spec", {}).get("claimRef", {})
        pvc_ns = claim_ref.get("namespace", "")
        pvc_name = claim_ref.get("name", "")
        if pvc_ns != MONITORING_NAMESPACE:
            continue

        node_affinity = (
            pv.get("spec", {})
            .get("nodeAffinity", {})
            .get("required", {})
            .get("nodeSelectorTerms", [])
        )

        for term in node_affinity:
            for expr in term.get("matchExpressions", []):
                if expr.get("key") == "kubernetes.io/hostname":
                    for hostname in expr.get("values", []):
                        if hostname not in live_nodes:
                            stale.append({
                                "pv_name": pv_name,
                                "pvc_name": pvc_name,
                                "pvc_namespace": pvc_ns,
                                "dead_node": hostname,
                            })

    return stale


def setup_admin_kubeconfig(cfg: BootConfig) -> None:
    """Retrieve admin kubeconfig from SSM for kubectl access on workers."""
    admin_kubeconfig_param = f"{cfg.ssm_prefix}/admin-kubeconfig-b64"
    admin_kc_b64 = ssm_get(admin_kubeconfig_param)
    if not admin_kc_b64:
        log_info(
            "Admin kubeconfig not in SSM — attempting PV cleanup with "
            "default credentials (may require RBAC for node service account)"
        )
        return

    admin_kc_path = Path("/tmp/admin-kubeconfig")
    admin_kc_path.write_text(base64.b64decode(admin_kc_b64).decode())
    admin_kc_path.chmod(0o600)
    os.environ["KUBECONFIG"] = str(admin_kc_path)
    log_info("Using admin kubeconfig from SSM for PV cleanup")


# ── Step ───────────────────────────────────────────────────────────────────

def step_clean_stale_pvs(cfg: BootConfig) -> None:
    """Step 5: Clean stale PVs/PVCs pinned to dead nodes (monitoring workers only).

    Args:
        cfg: Bootstrap configuration.
    """
    with StepRunner("clean-stale-pvs", skip_if=STALE_PV_CLEANUP_MARKER) as step:
        if step.skipped:
            return

        if cfg.node_label != MONITORING_WORKER_LABEL:
            log_info(
                f"Skipping stale PV cleanup — NODE_LABEL={cfg.node_label} "
                f"(only {MONITORING_WORKER_LABEL} triggers PV cleanup)"
            )
            step.details["skipped_reason"] = f"not a monitoring worker (label={cfg.node_label})"
            return

        log_info("Waiting 10s for node registration before PV cleanup...")
        time.sleep(10)

        setup_admin_kubeconfig(cfg)

        live_nodes = get_cluster_node_names()
        if not live_nodes:
            log_warn("No cluster nodes found — skipping PV cleanup")
            step.details["skipped_reason"] = "no cluster nodes found"
            return

        log_info(f"Live cluster nodes: {', '.join(sorted(live_nodes))}")
        step.details["live_node_count"] = len(live_nodes)

        stale_pvs = find_stale_pvs(live_nodes)
        if not stale_pvs:
            log_info("✓ No stale PVs found — monitoring storage is healthy")
            step.details["stale_pv_count"] = 0
            return

        log_warn(f"Found {len(stale_pvs)} stale PV(s) pinned to dead node(s)")
        step.details["stale_pv_count"] = len(stale_pvs)
        step.details["stale_pvs"] = stale_pvs

        deleted_pvcs: list[str] = []
        deleted_pvs: list[str] = []

        for entry in stale_pvs:
            pvc_name = entry["pvc_name"]
            pv_name = entry["pv_name"]
            dead_node = entry["dead_node"]
            ns = entry["pvc_namespace"]

            log_warn(
                f"  Stale PV: {pv_name} → PVC: {pvc_name} "
                f"(pinned to dead node: {dead_node})"
            )

            if pvc_name:
                result = run_cmd(
                    ["kubectl", "delete", "pvc", pvc_name, "-n", ns,
                     "--ignore-not-found=true", "--wait=false"],
                    check=False,
                )
                if result.returncode == 0:
                    log_info(f"  ✓ Deleted PVC: {pvc_name}")
                    deleted_pvcs.append(pvc_name)
                else:
                    log_warn(f"  ✗ Failed to delete PVC: {pvc_name}")

            result = run_cmd(
                ["kubectl", "delete", "pv", pv_name,
                 "--ignore-not-found=true", "--wait=false"],
                check=False,
            )
            if result.returncode == 0:
                log_info(f"  ✓ Deleted PV: {pv_name}")
                deleted_pvs.append(pv_name)
            else:
                log_warn(f"  ✗ Failed to delete PV: {pv_name}")

        step.details["deleted_pvcs"] = deleted_pvcs
        step.details["deleted_pvs"] = deleted_pvs

        log_info(
            f"Stale PV cleanup complete: "
            f"{len(deleted_pvcs)} PVC(s), {len(deleted_pvs)} PV(s) removed. "
            f"ArgoCD will recreate them on the next sync."
        )
