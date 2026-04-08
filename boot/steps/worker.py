#!/usr/bin/env python3
"""
@format
Worker Node Bootstrap — Consolidated Steps

Orchestrates the Kubernetes worker node bootstrap as a single
entry point. Each step is wrapped in a StepRunner for structured
logging, timing, and idempotency guards.

Steps (in order):
    1. validate_ami         — Verify Golden AMI binaries and kernel settings
    2. join_cluster         — Join kubeadm cluster via SSM discovery
    3. install_cw_agent     — CloudWatch Agent for log streaming
    4. clean_stale_pvs      — Remove stale PVs/PVCs from dead nodes
                              (monitoring workers only: workload=monitoring | node-pool=monitoring)
    5. verify_membership    — Verify cluster registration and correct labels

Idempotent: each step uses marker files or existence checks to skip
if already completed. Safe to re-run on instance replacement.

Expected environment variables:
    SSM_PREFIX       — SSM parameter prefix (e.g. /k8s/development)
    AWS_REGION       — AWS region
    NODE_LABEL       — Kubernetes node label (e.g. role=application)
    LOG_GROUP_NAME   — CloudWatch log group name

Usage:
    python3 worker.py
"""

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import (
    AWS_REGION as DEFAULT_AWS_REGION,
)
from common import (
    ECR_PROVIDER_CONFIG,
    StepRunner,
    ensure_ecr_credential_provider,
    get_imds_value,
    log_error,
    log_info,
    log_warn,
    patch_provider_id,
    run_cmd,
    ssm_get,
    step_install_cloudwatch_agent,
    step_validate_ami,
    validate_kubeadm_token,
)
from common import (
    SSM_PREFIX as DEFAULT_SSM_PREFIX,
)

# =============================================================================
# Configuration
# =============================================================================

SSM_PREFIX = os.environ.get("SSM_PREFIX", DEFAULT_SSM_PREFIX)
AWS_REGION = os.environ.get("AWS_REGION", DEFAULT_AWS_REGION)
NODE_LABEL = os.environ.get("NODE_LABEL", "role=worker")
JOIN_MAX_RETRIES = int(os.environ.get("JOIN_MAX_RETRIES", "10"))
JOIN_RETRY_INTERVAL = int(os.environ.get("JOIN_RETRY_INTERVAL", "30"))
CP_MAX_WAIT = 300  # seconds to wait for control plane endpoint
API_REACHABLE_TIMEOUT = 300  # seconds to wait for TCP connectivity
API_REACHABLE_POLL_INTERVAL = 10  # seconds between TCP probes

KUBELET_CONF = "/etc/kubernetes/kubelet.conf"


# Step 1 — Validate Golden AMI
# Imported from common: step_validate_ami()


# =============================================================================
# Step 2 — Join kubeadm Cluster
# =============================================================================

CA_CERT_PATH = "/etc/kubernetes/pki/ca.crt"


def _compute_local_ca_hash() -> str:
    """Compute the SHA-256 hash of the local Kubernetes CA certificate.

    Uses the same openssl pipeline as the control plane's
    ``_publish_ssm_params()`` to ensure hashes are directly comparable.

    @returns The CA hash in ``sha256:<hex>`` format, or empty string on failure.
    """
    ca_hash_cmd = (
        f"openssl x509 -pubkey -in {CA_CERT_PATH} | "
        "openssl rsa -pubin -outform der 2>/dev/null | "
        "openssl dgst -sha256 -hex | awk '{print $2}'"
    )
    result = run_cmd(ca_hash_cmd, shell=True, check=False)
    if result.returncode != 0 or not result.stdout.strip():
        log_warn("Failed to compute local CA hash")
        return ""
    return f"sha256:{result.stdout.strip()}"


def _check_ca_mismatch() -> bool:
    """Detect CA certificate mismatch between this worker and the control plane.

    When the control plane is replaced with a new CA (e.g. EBS volume loss),
    existing workers hold a stale CA in ``/etc/kubernetes/pki/ca.crt``.
    This function compares the local CA hash against the SSM-published
    value and, on mismatch, runs ``kubeadm reset`` so the join step can
    proceed with the new credentials.

    @returns True if a mismatch was detected and reset was performed.
    """
    ca_cert = Path(CA_CERT_PATH)
    kubelet_conf = Path(KUBELET_CONF)

    if not ca_cert.exists():
        log_info("No local CA cert found — fresh worker, proceeding normally")
        return False

    if not kubelet_conf.exists():
        log_info("No kubelet.conf — worker not previously joined, proceeding normally")
        return False

    local_hash = _compute_local_ca_hash()
    if not local_hash:
        log_warn("Could not compute local CA hash — skipping mismatch check")
        return False

    ssm_hash = ssm_get(f"{SSM_PREFIX}/ca-hash")
    if not ssm_hash:
        log_warn("CA hash not available in SSM — skipping mismatch check")
        return False

    if local_hash == ssm_hash:
        log_info(f"CA certificate valid — local hash matches SSM ({local_hash[:20]}...)")
        return False

    # ─── CA MISMATCH DETECTED ───
    log_warn("=" * 60)
    log_warn("CA MISMATCH DETECTED")
    log_warn(f"  Local CA hash:  {local_hash}")
    log_warn(f"  SSM CA hash:    {ssm_hash}")
    log_warn("  The control plane was replaced with a new CA certificate.")
    log_warn("  Running kubeadm reset to prepare for re-join...")
    log_warn("=" * 60)

    run_cmd(["kubeadm", "reset", "-f"], check=False)

    # Remove kubelet.conf so the StepRunner skip_if guard allows re-join
    if kubelet_conf.exists():
        kubelet_conf.unlink()
        log_info("Removed stale kubelet.conf")

    # Remove stale CA cert so kubeadm join writes the new one
    if ca_cert.exists():
        ca_cert.unlink()
        log_info("Removed stale CA certificate")

    log_info("Worker reset complete — ready to re-join with new CA")
    return True


def _resolve_control_plane_endpoint() -> str:
    """Wait for control plane endpoint to appear in SSM."""
    log_info("Resolving control plane endpoint from SSM...")
    param_name = f"{SSM_PREFIX}/control-plane-endpoint"

    waited = 0
    while waited < CP_MAX_WAIT:
        endpoint = ssm_get(param_name)
        if endpoint and endpoint != "None":
            log_info(f"Control plane endpoint: {endpoint}")
            return endpoint

        log_info(f"Waiting for control plane endpoint... ({waited}s / {CP_MAX_WAIT}s)")
        time.sleep(10)
        waited += 10

    raise RuntimeError(
        f"Control plane endpoint not found in SSM after {CP_MAX_WAIT}s. "
        f"The control plane must be running and have published its "
        f"endpoint to {param_name}."
    )


def _parse_host_port(endpoint: str) -> tuple[str, str]:
    """Split an endpoint string into (host, port).

    Args:
        endpoint: Endpoint in ``host:port`` format.

    Returns:
        Tuple of (host, port). Defaults port to ``6443`` if omitted.
    """
    if ":" in endpoint:
        host, port = endpoint.rsplit(":", 1)
        return host, port
    return endpoint, "6443"


def _tcp_probe(host: str, port: str) -> bool:
    """Test TCP connectivity to a host:port using Python's socket module.

    Uses ``socket.create_connection()`` with a 5-second timeout to attempt
    a zero-I/O TCP connection. This is a lightweight probe that does not
    perform TLS and has zero external binary dependencies.

    Args:
        host: Target hostname or IP address.
        port: Target port number (string — converted internally).

    Returns:
        ``True`` if the TCP connection succeeded, ``False`` otherwise.
    """
    try:
        conn = socket.create_connection((host, int(port)), timeout=5)
        conn.close()
        return True
    except (OSError, ValueError):
        return False


def _wait_for_api_server_reachable(endpoint: str) -> None:
    """Block until the API server accepts TCP connections.

    Polls the API server endpoint with Python socket TCP probes every
    ``API_REACHABLE_POLL_INTERVAL`` seconds until a connection succeeds
    or ``API_REACHABLE_TIMEOUT`` is exceeded.

    This gate prevents burning expensive ``kubeadm join`` retry budget
    against an unreachable API server (e.g. during CP initialisation or
    Route 53 propagation).

    Args:
        endpoint: API server endpoint in ``host:port`` format.

    Raises:
        RuntimeError: If the API server is not reachable within the timeout.
    """
    host, port = _parse_host_port(endpoint)
    log_info(
        f"Waiting for API server TCP connectivity: {host}:{port} "
        f"(timeout={API_REACHABLE_TIMEOUT}s)"
    )

    waited = 0
    while waited < API_REACHABLE_TIMEOUT:
        if _tcp_probe(host, port):
            log_info(
                f"✓ API server is reachable at {host}:{port} (waited {waited}s)"
            )
            return

        log_info(
            f"API server not yet reachable ({waited}s / {API_REACHABLE_TIMEOUT}s) "
            f"— retrying in {API_REACHABLE_POLL_INTERVAL}s"
        )
        time.sleep(API_REACHABLE_POLL_INTERVAL)
        waited += API_REACHABLE_POLL_INTERVAL

    raise RuntimeError(
        f"API server at {host}:{port} not reachable after {API_REACHABLE_TIMEOUT}s. "
        f"Check that the control plane is running, the DNS record has propagated, "
        f"and security groups allow TCP {port} from this worker node."
    )


def _join_cluster(endpoint: str) -> None:
    """Join the cluster with retry logic."""
    log_info(f"Joining kubeadm cluster as worker node (label={NODE_LABEL})")
    log_info(f"Join config: max_retries={JOIN_MAX_RETRIES}, retry_interval={JOIN_RETRY_INTERVAL}s")

    run_cmd(["systemctl", "start", "containerd"])
    log_info("containerd started")

    ensure_ecr_credential_provider()

    private_ip = get_imds_value("local-ipv4")
    if not private_ip:
        raise RuntimeError(
            "Failed to retrieve private IP from IMDS — "
            "cannot configure kubelet --node-ip"
        )

    log_info(f"Configuring kubelet with node label: {NODE_LABEL}, node-ip: {private_ip}")
    Path("/etc/sysconfig").mkdir(parents=True, exist_ok=True)
    Path("/etc/sysconfig/kubelet").write_text(
        f"KUBELET_EXTRA_ARGS=--cloud-provider=external"
        f" --node-ip={private_ip}"
        f" --node-labels={NODE_LABEL}"
        f" --image-credential-provider-config={ECR_PROVIDER_CONFIG}"
        " --image-credential-provider-bin-dir=/usr/local/bin\n"
    )

    token_ssm = f"{SSM_PREFIX}/join-token"
    ca_hash_ssm = f"{SSM_PREFIX}/ca-hash"

    for attempt in range(1, JOIN_MAX_RETRIES + 1):
        log_info(f"=== kubeadm join attempt {attempt}/{JOIN_MAX_RETRIES} ===")

        raw_token = ssm_get(token_ssm, decrypt=True)
        if not raw_token:
            log_warn(f"Join token not available (attempt {attempt}/{JOIN_MAX_RETRIES})")
            if attempt < JOIN_MAX_RETRIES:
                time.sleep(JOIN_RETRY_INTERVAL)
                continue
            raise RuntimeError(f"Join token never became available after {JOIN_MAX_RETRIES} attempts")

        # Validate and sanitise the token — guards against backslash
        # injection from SSM SecureString shell encoding
        join_token = validate_kubeadm_token(raw_token, source="SSM")
        log_info(f"Join token validated (length={len(join_token)})")

        ca_hash = ssm_get(ca_hash_ssm)
        if not ca_hash:
            log_warn(f"CA hash not available (attempt {attempt}/{JOIN_MAX_RETRIES})")
            if attempt < JOIN_MAX_RETRIES:
                time.sleep(JOIN_RETRY_INTERVAL)
                continue
            raise RuntimeError(f"CA hash never became available after {JOIN_MAX_RETRIES} attempts")

        # Pre-retry TCP diagnostic — log whether the API server is
        # reachable before each attempt so CloudWatch captures the cause
        host, port = _parse_host_port(endpoint)
        reachable = _tcp_probe(host, port)
        log_info(
            f"Pre-join TCP probe: {host}:{port} → "
            f"{'reachable' if reachable else 'UNREACHABLE'}"
        )

        log_info("Running kubeadm join...")
        try:
            result = run_cmd(
                ["kubeadm", "join", endpoint,
                 "--token", join_token,
                 "--discovery-token-ca-cert-hash", ca_hash],
                check=False, capture=False, timeout=120,
            )
        except subprocess.TimeoutExpired:
            log_warn(
                f"kubeadm join timed out on attempt {attempt}/{JOIN_MAX_RETRIES} "
                f"— API server may still be initialising"
            )
            if attempt < JOIN_MAX_RETRIES:
                log_info("Running kubeadm reset before retry...")
                run_cmd(["kubeadm", "reset", "-f"], check=False)
                time.sleep(JOIN_RETRY_INTERVAL)
                continue
            raise RuntimeError(
                f"kubeadm join timed out on all {JOIN_MAX_RETRIES} attempts. "
                f"Check that the API server at {endpoint} is reachable."
            ) from None

        if result.returncode == 0:
            log_info(f"kubeadm join succeeded on attempt {attempt}")
            return

        log_warn(f"kubeadm join failed on attempt {attempt}/{JOIN_MAX_RETRIES}")

        if attempt < JOIN_MAX_RETRIES:
            log_info("Running kubeadm reset before retry...")
            run_cmd(["kubeadm", "reset", "-f"], check=False)
            time.sleep(JOIN_RETRY_INTERVAL)

    raise RuntimeError(f"kubeadm join failed after {JOIN_MAX_RETRIES} attempts")


def _wait_for_kubelet() -> None:
    """Wait for kubelet to become active."""
    log_info("Waiting for kubelet to become active...")
    for i in range(1, 61):
        result = run_cmd(
            ["systemctl", "is-active", "--quiet", "kubelet"],
            check=False,
        )
        if result.returncode == 0:
            log_info(f"kubelet is active (waited {i}s)")
            return
        if i == 60:
            log_warn("kubelet did not become active in 60s")
            run_cmd(["journalctl", "-u", "kubelet", "--no-pager", "-n", "20"],
                    check=False)
        time.sleep(1)


def step_join_cluster() -> None:
    """Step 2: Join kubeadm cluster via SSM discovery.

    Before the idempotency guard, checks for CA certificate mismatch
    (control plane replaced with a new CA). On mismatch, resets kubeadm
    and removes kubelet.conf so the join can proceed with new credentials.
    """
    # CA mismatch check MUST run before StepRunner's skip_if guard,
    # because it may need to remove kubelet.conf to allow re-join.
    ca_reset = _check_ca_mismatch()
    if ca_reset:
        log_info("CA mismatch handled — proceeding to re-join cluster")

    with StepRunner("join-cluster", skip_if=KUBELET_CONF) as step:
        if step.skipped:
            return

        endpoint = _resolve_control_plane_endpoint()
        _wait_for_api_server_reachable(endpoint)
        _join_cluster(endpoint)
        _wait_for_kubelet()

        # Set providerID immediately so the AWS CCM can map this node
        # to its EC2 instance — required for auto-deletion of dead nodes.
        patch_provider_id()

        kubelet_version = run_cmd(
            ["kubelet", "--version"], check=False
        ).stdout.strip()
        step.details["node_label"] = NODE_LABEL
        step.details["kubelet_version"] = kubelet_version
        step.details["control_plane_endpoint"] = endpoint
        log_info(f"Worker node joined cluster successfully: {kubelet_version}")


# Step 3 — Install CloudWatch Agent
# Imported from common: step_install_cloudwatch_agent()





# =============================================================================
# Step 5 — Clean Stale PVs/PVCs (monitoring worker only)
#
# When a monitoring worker node is replaced by ASG, the old node is
# terminated but its local-path PersistentVolumes remain in the cluster,
# pinned to the dead hostname via nodeAffinity. Pods cannot schedule
# because the PVs reference a node that no longer exists.
#
# This step:
#   1. Discovers PVs in the 'monitoring' namespace bound to dead nodes
#   2. Deletes the orphaned PVCs (which releases the PVs)
#   3. Deletes the Released/Failed PVs
#
# ArgoCD or Helm will recreate the PVCs on the next sync, and
# local-path-provisioner will provision fresh PVs on the new node.
#
# Gated to monitoring workers only via NODE_LABEL check.
# Idempotent: if no stale PVs exist, this step is a no-op.
# =============================================================================

# ─── Monitoring worker gate ──────────────────────────────────────────────────
# MIGRATION: During the K8s-native worker migration, monitoring pool nodes carry
# the new label `node-pool=monitoring` instead of the legacy `workload=monitoring`.
# Both are accepted here so PV cleanup runs for either generation of monitoring node.
# Once the legacy MonitoringWorker stack is decommissioned, simplify to:
#   MONITORING_NODE_LABEL = "node-pool=monitoring"

_MONITORING_LABELS: frozenset[str] = frozenset({
    "workload=monitoring",  # legacy — MonitoringWorker CDK stack
    "node-pool=monitoring",  # new    — Kubernetes-MonitoringPool ASG stack
})


def _is_monitoring_worker(label: str) -> bool:
    """Return True if this node is a monitoring worker (any generation).

    Accepts both the legacy ``workload=monitoring`` label (single-node
    MonitoringWorker CDK stack) and the new ``node-pool=monitoring`` label
    (generic ASG monitoring pool). Simplify to a direct equality check once
    the legacy stack is decommissioned.

    @param label: The value of the ``NODE_LABEL`` environment variable.
    @returns True if the label denotes a monitoring worker.
    """
    return label in _MONITORING_LABELS


MONITORING_NAMESPACE = "monitoring"
STALE_PV_CLEANUP_MARKER = "/tmp/.stale-pv-cleanup-done"


def _get_cluster_node_names() -> set[str]:
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


def _find_stale_pvs(live_nodes: set[str]) -> list[dict[str, str]]:
    """Find PVs with node affinity pointing to nodes not in the cluster.

    @returns List of dicts with 'pv_name', 'pvc_name', 'pvc_namespace', 'dead_node'.
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

    stale = []
    for pv in pv_list.get("items", []):
        pv_name = pv.get("metadata", {}).get("name", "")

        # Only check PVs bound to the monitoring namespace
        claim_ref = pv.get("spec", {}).get("claimRef", {})
        pvc_ns = claim_ref.get("namespace", "")
        pvc_name = claim_ref.get("name", "")
        if pvc_ns != MONITORING_NAMESPACE:
            continue

        # Extract node affinity hostname(s)
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


def step_clean_stale_pvs() -> None:
    """Step 5: Clean stale PVs/PVCs pinned to dead nodes (monitoring workers only).

    When a monitoring worker is replaced, local-path PVs retain
    nodeAffinity to the old (dead) hostname. This blocks pod scheduling
    until the PVCs are deleted and recreated on the new node.
    """
    with StepRunner("clean-stale-pvs", skip_if=STALE_PV_CLEANUP_MARKER) as step:
        if step.skipped:
            return

        # Gate: only monitoring workers need PV cleanup
        if not _is_monitoring_worker(NODE_LABEL):
            log_info(
                f"Skipping stale PV cleanup — NODE_LABEL={NODE_LABEL} "
                f"(only monitoring workers trigger PV cleanup: {sorted(_MONITORING_LABELS)})"
            )
            step.details["skipped_reason"] = f"not a monitoring worker (label={NODE_LABEL})"
            return

        # Wait briefly for the node to be registered in the API
        log_info("Waiting 10s for node registration before PV cleanup...")
        time.sleep(10)

        # Set KUBECONFIG so kubectl works from the worker
        os.environ.get("KUBECONFIG", "/etc/kubernetes/kubelet.conf")
        # Workers don't have admin.conf — use the CP endpoint via SSM
        # to get a kubeconfig. kubectl on workers uses the kubelet cert.
        # For PV cleanup, we need admin access. Retrieve admin kubeconfig
        # from the control plane via SSM.
        admin_kubeconfig_param = f"{SSM_PREFIX}/admin-kubeconfig-b64"
        admin_kc_b64 = ssm_get(admin_kubeconfig_param)
        if not admin_kc_b64:
            # Fallback: try to use kubectl directly (may work if RBAC allows)
            log_info(
                "Admin kubeconfig not in SSM — attempting PV cleanup with "
                "default credentials (may require RBAC for node service account)"
            )
        else:
            import base64
            admin_kc_path = Path("/tmp/admin-kubeconfig")
            admin_kc_path.write_text(base64.b64decode(admin_kc_b64).decode())
            admin_kc_path.chmod(0o600)
            os.environ["KUBECONFIG"] = str(admin_kc_path)
            str(admin_kc_path)
            log_info("Using admin kubeconfig from SSM for PV cleanup")

        live_nodes = _get_cluster_node_names()
        if not live_nodes:
            log_warn("No cluster nodes found — skipping PV cleanup")
            step.details["skipped_reason"] = "no cluster nodes found"
            return

        log_info(f"Live cluster nodes: {', '.join(sorted(live_nodes))}")
        step.details["live_node_count"] = len(live_nodes)

        stale_pvs = _find_stale_pvs(live_nodes)
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

            # Delete PVC first (this releases the PV)
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

            # Delete the PV
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


# =============================================================================
# Main — Sequential Worker Bootstrap
# =============================================================================

def main() -> None:
    """Execute all worker node bootstrap steps in order."""
    from wk import main as wk_main
    wk_main()


if __name__ == "__main__":
    main()

