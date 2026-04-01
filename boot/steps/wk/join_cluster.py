"""Step 2 — Join kubeadm cluster via SSM discovery.

Handles:
- CA certificate mismatch detection (control plane replaced)
- Patient retry loop for kubeadm join with token refresh
- Kubelet health check after join
- AWS CCM providerID patching
"""
from __future__ import annotations

import socket
import subprocess
import time
from pathlib import Path

from common import (
    ECR_PROVIDER_CONFIG,
    StepRunner,
    ensure_ecr_credential_provider,
    get_imds_value,
    log_info,
    log_warn,
    patch_provider_id,
    run_cmd,
    ssm_get,
    validate_kubeadm_token,
)
from boot_helpers.config import BootConfig

# ── Constants ──────────────────────────────────────────────────────────────

KUBELET_CONF = "/etc/kubernetes/kubelet.conf"
CA_CERT_PATH = "/etc/kubernetes/pki/ca.crt"
CP_MAX_WAIT_SECONDS = 300
API_REACHABLE_TIMEOUT = 300  # seconds to wait for TCP connectivity
API_REACHABLE_POLL_INTERVAL = 10  # seconds between TCP probes


# ── Helpers ────────────────────────────────────────────────────────────────

def compute_local_ca_hash() -> str:
    """Compute the SHA-256 hash of the local Kubernetes CA certificate.

    Returns:
        The CA hash in ``sha256:<hex>`` format, or empty string on failure.
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


def check_ca_mismatch(cfg: BootConfig) -> bool:
    """Detect CA certificate mismatch between this worker and the control plane.

    When the control plane is replaced with a new CA, existing workers hold
    a stale CA. This function compares the local CA hash against the
    SSM-published value and, on mismatch, runs ``kubeadm reset`` so the
    join step can proceed with the new credentials.

    Returns:
        ``True`` if a mismatch was detected and reset was performed.
    """
    ca_cert = Path(CA_CERT_PATH)
    kubelet_conf = Path(KUBELET_CONF)

    if not ca_cert.exists():
        log_info("No local CA cert found — fresh worker, proceeding normally")
        return False

    if not kubelet_conf.exists():
        log_info("No kubelet.conf — worker not previously joined, proceeding normally")
        return False

    local_hash = compute_local_ca_hash()
    if not local_hash:
        log_warn("Could not compute local CA hash — skipping mismatch check")
        return False

    ssm_hash = ssm_get(f"{cfg.ssm_prefix}/ca-hash")
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

    if kubelet_conf.exists():
        kubelet_conf.unlink()
        log_info("Removed stale kubelet.conf")

    if ca_cert.exists():
        ca_cert.unlink()
        log_info("Removed stale CA certificate")

    log_info("Worker reset complete — ready to re-join with new CA")
    return True


def resolve_control_plane_endpoint(cfg: BootConfig) -> str:
    """Wait for control plane endpoint to appear in SSM.

    Returns:
        The endpoint string (e.g. ``k8s-api.k8s.internal:6443``).

    Raises:
        RuntimeError: If the endpoint does not appear within the timeout.
    """
    log_info("Resolving control plane endpoint from SSM...")
    param_name = f"{cfg.ssm_prefix}/control-plane-endpoint"

    waited = 0
    while waited < CP_MAX_WAIT_SECONDS:
        endpoint = ssm_get(param_name)
        if endpoint and endpoint != "None":
            log_info(f"Control plane endpoint: {endpoint}")
            return endpoint

        log_info(f"Waiting for control plane endpoint... ({waited}s / {CP_MAX_WAIT_SECONDS}s)")
        time.sleep(10)
        waited += 10

    raise RuntimeError(
        f"Control plane endpoint not found in SSM after {CP_MAX_WAIT_SECONDS}s. "
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


def tcp_probe(host: str, port: str) -> bool:
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


def wait_for_api_server_reachable(endpoint: str) -> None:
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
        if tcp_probe(host, port):
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


def join_cluster(endpoint: str, cfg: BootConfig) -> None:
    """Join the cluster with retry logic."""
    log_info(f"Joining kubeadm cluster as worker node (label={cfg.node_label})")
    log_info(
        f"Join config: max_retries={cfg.join_max_retries}, "
        f"retry_interval={cfg.join_retry_interval}s"
    )

    run_cmd(["systemctl", "start", "containerd"])
    log_info("containerd started")

    ensure_ecr_credential_provider()

    private_ip = get_imds_value("local-ipv4")
    if not private_ip:
        raise RuntimeError(
            "Failed to retrieve private IP from IMDS — "
            "cannot configure kubelet --node-ip"
        )

    log_info(f"Configuring kubelet with node label: {cfg.node_label}, node-ip: {private_ip}")
    Path("/etc/sysconfig").mkdir(parents=True, exist_ok=True)
    Path("/etc/sysconfig/kubelet").write_text(
        f"KUBELET_EXTRA_ARGS=--cloud-provider=external"
        f" --node-ip={private_ip}"
        f" --node-labels={cfg.node_label}"
        f" --image-credential-provider-config={ECR_PROVIDER_CONFIG}"
        " --image-credential-provider-bin-dir=/usr/local/bin\n"
    )

    token_ssm = f"{cfg.ssm_prefix}/join-token"
    ca_hash_ssm = f"{cfg.ssm_prefix}/ca-hash"

    for attempt in range(1, cfg.join_max_retries + 1):
        log_info(f"=== kubeadm join attempt {attempt}/{cfg.join_max_retries} ===")

        raw_token = ssm_get(token_ssm, decrypt=True)
        if not raw_token:
            log_warn(f"Join token not available (attempt {attempt}/{cfg.join_max_retries})")
            if attempt < cfg.join_max_retries:
                time.sleep(cfg.join_retry_interval)
                continue
            raise RuntimeError(
                f"Join token never became available after {cfg.join_max_retries} attempts"
            )

        # Validate and sanitise the token — guards against backslash
        # injection from SSM SecureString shell encoding
        join_token = validate_kubeadm_token(raw_token, source="SSM")
        log_info(f"Join token validated (length={len(join_token)})")

        ca_hash = ssm_get(ca_hash_ssm)
        if not ca_hash:
            log_warn(f"CA hash not available (attempt {attempt}/{cfg.join_max_retries})")
            if attempt < cfg.join_max_retries:
                time.sleep(cfg.join_retry_interval)
                continue
            raise RuntimeError(
                f"CA hash never became available after {cfg.join_max_retries} attempts"
            )

        # Pre-retry TCP diagnostic — log whether the API server is
        # reachable before each attempt so CloudWatch captures the cause
        host, port = _parse_host_port(endpoint)
        reachable = tcp_probe(host, port)
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
                f"kubeadm join timed out on attempt {attempt}/{cfg.join_max_retries} "
                f"— API server may still be initialising"
            )
            if attempt < cfg.join_max_retries:
                log_info("Running kubeadm reset before retry...")
                run_cmd(["kubeadm", "reset", "-f"], check=False)
                time.sleep(cfg.join_retry_interval)
                continue
            raise RuntimeError(
                f"kubeadm join timed out on all {cfg.join_max_retries} attempts. "
                f"Check that the API server at {endpoint} is reachable."
            ) from None

        if result.returncode == 0:
            log_info(f"kubeadm join succeeded on attempt {attempt}")
            return

        log_warn(f"kubeadm join failed on attempt {attempt}/{cfg.join_max_retries}")

        if attempt < cfg.join_max_retries:
            log_info("Running kubeadm reset before retry...")
            run_cmd(["kubeadm", "reset", "-f"], check=False)
            time.sleep(cfg.join_retry_interval)

    raise RuntimeError(f"kubeadm join failed after {cfg.join_max_retries} attempts")


def wait_for_kubelet() -> None:
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
            run_cmd(
                ["journalctl", "-u", "kubelet", "--no-pager", "-n", "20"],
                check=False,
            )
        time.sleep(1)


# ── Step ───────────────────────────────────────────────────────────────────

def step_join_cluster(cfg: BootConfig) -> None:
    """Step 2: Join kubeadm cluster via SSM discovery.

    Before the idempotency guard, checks for CA certificate mismatch.
    On mismatch, resets kubeadm and removes kubelet.conf so the join
    can proceed with new credentials.

    Args:
        cfg: Bootstrap configuration.
    """
    ca_reset = check_ca_mismatch(cfg)
    if ca_reset:
        log_info("CA mismatch handled — proceeding to re-join cluster")

    with StepRunner("join-cluster", skip_if=KUBELET_CONF) as step:
        if step.skipped:
            return

        endpoint = resolve_control_plane_endpoint(cfg)
        wait_for_api_server_reachable(endpoint)
        join_cluster(endpoint, cfg)
        wait_for_kubelet()

        patch_provider_id()

        kubelet_version = run_cmd(
            ["kubelet", "--version"], check=False
        ).stdout.strip()
        step.details["node_label"] = cfg.node_label
        step.details["kubelet_version"] = kubelet_version
        step.details["control_plane_endpoint"] = endpoint
        log_info(f"Worker node joined cluster successfully: {kubelet_version}")
