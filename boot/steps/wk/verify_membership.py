"""Step 6 — Verify cluster membership and correct node labels.

Safety-net for workers that survived a control plane rebuild without
being relaunched by ASG. On each SSM Automation cycle, this step
verifies:

1. The node is registered in the API server (``kubectl get node``)
2. Node labels match the ``NODE_LABEL`` env var
3. If not registered, triggers CA mismatch check + re-join

This step runs WITHOUT a ``skip_if`` marker so it executes on every
SSM Automation cycle (~30 min), ensuring label drift is detected
quickly.

Idempotent: if the node is correctly registered and labelled, this
step is a no-op beyond a lightweight kubectl check.

KUBECONFIG resolution order (workers do not have admin.conf):
  1. Admin kubeconfig retrieved from SSM (``<ssm_prefix>/admin-kubeconfig-b64``)
     — full RBAC, required for label writes
  2. ``/etc/kubernetes/kubelet.conf`` — Node authorizer allows reading
     this node's own object; sufficient for membership checks when SSM
     is unavailable but label correction will be skipped
"""
from __future__ import annotations

import base64
import os
import socket
from pathlib import Path

from common import (
    StepRunner,
    get_imds_value,
    log_info,
    log_warn,
    run_cmd,
    ssm_get,
)
from boot_helpers.config import BootConfig

from wk.join_cluster import (
    KUBELET_CONF,
    check_ca_mismatch,
    join_cluster,
    resolve_control_plane_endpoint,
    wait_for_api_server_reachable,
    wait_for_kubelet,
)


# ── Constants ──────────────────────────────────────────────────────────────

# Timeout for kubectl probes.  10s was too tight when the API server is
# under load immediately after a fresh bootstrap — bumped to 30s.
KUBECTL_PROBE_TIMEOUT = 30

# Path where the admin kubeconfig is written when retrieved from SSM.
_ADMIN_KUBECONFIG_TMP = "/tmp/verify-membership-admin.conf"


# ── Helpers ────────────────────────────────────────────────────────────────

def _resolve_worker_kubeconfig(cfg: BootConfig) -> dict[str, str]:
    """Resolve the best available kubeconfig env for worker-side kubectl calls.

    Workers do not have ``/etc/kubernetes/admin.conf``.  Resolution order:

    1. Admin kubeconfig retrieved from SSM (full RBAC — preferred).
    2. ``kubelet.conf`` — Node authorizer allows reading this node's own
       object; label writes will fail but membership checks will succeed.
    3. Empty dict (no override) — kubectl will fail gracefully via timeout.

    Returns:
        Dict suitable for passing as ``env=`` to ``run_cmd``.  Always
        includes the current process environment so PATH / AWS_* etc. are
        preserved.
    """
    base_env = os.environ.copy()

    # ── Option 1: admin kubeconfig from SSM ───────────────────────────────
    admin_kc_param = f"{cfg.ssm_prefix}/admin-kubeconfig-b64"
    admin_kc_b64 = ssm_get(admin_kc_param)
    if admin_kc_b64:
        try:
            kc_path = Path(_ADMIN_KUBECONFIG_TMP)
            kc_path.write_text(base64.b64decode(admin_kc_b64).decode())
            kc_path.chmod(0o600)
            log_info(
                f"Using admin kubeconfig from SSM ({admin_kc_param}) "
                "for membership verification"
            )
            return {**base_env, "KUBECONFIG": str(kc_path)}
        except Exception as exc:  # noqa: BLE001
            log_warn(f"Failed to write admin kubeconfig from SSM: {exc}")

    # ── Option 2: kubelet.conf (read-only Node authorizer access) ─────────
    kubelet_conf = Path(KUBELET_CONF)
    if kubelet_conf.exists():
        log_warn(
            "Admin kubeconfig not available in SSM — falling back to "
            "kubelet.conf (read-only; label correction will be skipped)"
        )
        return {**base_env, "KUBECONFIG": str(kubelet_conf)}

    # ── Option 3: no kubeconfig — kubectl will fail gracefully ────────────
    log_warn(
        "No kubeconfig available for membership verification "
        "(admin kubeconfig not in SSM, kubelet.conf not present)"
    )
    return base_env


def _get_hostname() -> str:
    """Resolve this node's Kubernetes hostname.

    Kubernetes registers nodes using the EC2 private DNS name
    (e.g. ``ip-10-0-0-245.eu-west-1.compute.internal``).

    Returns:
        The hostname string, or empty string on failure.
    """
    try:
        fqdn = socket.getfqdn()
        if fqdn and fqdn != "localhost":
            return fqdn
    except OSError:
        pass

    # Fallback: read from IMDS
    private_dns = get_imds_value("local-hostname")
    return private_dns or ""


def _is_node_registered(hostname: str, kc_env: dict[str, str]) -> bool:
    """Check whether this node is registered in the API server.

    Args:
        hostname: The Kubernetes node name to look up.
        kc_env: Environment dict with KUBECONFIG set (from
            ``_resolve_worker_kubeconfig``).

    Returns:
        ``True`` if the node exists and is returned by ``kubectl get node``.
    """
    result = run_cmd(
        ["kubectl", "get", "node", hostname, "--no-headers"],
        check=False,
        timeout=KUBECTL_PROBE_TIMEOUT,
        env=kc_env,
    )
    return result.returncode == 0 and hostname in result.stdout


def _get_current_labels(hostname: str, kc_env: dict[str, str]) -> dict[str, str]:
    """Retrieve the current label set for a node.

    Args:
        hostname: The Kubernetes node name.
        kc_env: Environment dict with KUBECONFIG set.

    Returns:
        Dict of label key → value pairs. Empty dict on failure.
    """
    result = run_cmd(
        [
            "kubectl", "get", "node", hostname,
            "-o", "jsonpath={.metadata.labels}",
        ],
        check=False,
        timeout=KUBECTL_PROBE_TIMEOUT,
        env=kc_env,
    )
    if result.returncode != 0 or not result.stdout.strip():
        return {}

    import json
    try:
        return dict(json.loads(result.stdout.strip()))
    except json.JSONDecodeError:
        log_warn(f"Failed to parse node labels for {hostname}")
        return {}


def _parse_label_string(label_string: str) -> dict[str, str]:
    """Parse a comma-separated label string into a dict.

    Example::

        >>> _parse_label_string("workload=frontend,environment=development")
        {"workload": "frontend", "environment": "development"}

    Args:
        label_string: Comma-separated ``key=value`` pairs.

    Returns:
        Dict of label key → value.
    """
    labels: dict[str, str] = {}
    for pair in label_string.split(","):
        pair = pair.strip()
        if "=" in pair:
            key, value = pair.split("=", 1)
            labels[key.strip()] = value.strip()
    return labels


def _fix_labels(
    hostname: str,
    expected: dict[str, str],
    actual: dict[str, str],
    kc_env: dict[str, str],
) -> list[str]:
    """Apply missing or incorrect labels to the node.

    Only corrects labels that are defined in ``expected``. Does not
    remove extra labels that are present in ``actual`` but absent
    from ``expected`` — those may have been applied by other systems.

    Requires admin RBAC — the Node authorizer does not permit label writes.
    When running with ``kubelet.conf`` only, corrections will be attempted
    but are expected to fail with a 403; the step logs a warning and
    continues rather than raising.

    Args:
        hostname: The Kubernetes node name.
        expected: Labels that should be present (from NODE_LABEL env var).
        actual: Labels currently on the node.
        kc_env: Environment dict with KUBECONFIG set.

    Returns:
        List of labels that were corrected (e.g. ``["workload=frontend"]``).
    """
    corrected: list[str] = []

    for key, value in expected.items():
        if actual.get(key) != value:
            label_arg = f"{key}={value}"
            log_warn(
                f"Label mismatch: {key}={actual.get(key, '<missing>')} "
                f"→ {key}={value}"
            )
            result = run_cmd(
                ["kubectl", "label", "node", hostname, label_arg, "--overwrite"],
                check=False,
                timeout=KUBECTL_PROBE_TIMEOUT,
                env=kc_env,
            )
            if result.returncode == 0:
                log_info(f"✓ Corrected label: {label_arg}")
                corrected.append(label_arg)
            else:
                log_warn(
                    f"✗ Failed to correct label: {label_arg} "
                    f"(RBAC may require admin kubeconfig in SSM)"
                )

    return corrected


# ── Step ───────────────────────────────────────────────────────────────────

def step_verify_cluster_membership(cfg: BootConfig) -> None:
    """Step 6: Verify this worker is registered and correctly labelled.

    Safety-net for workers that survived a control plane rebuild without
    being relaunched by ASG. Runs on every SSM Automation cycle (no
    ``skip_if`` marker).

    Checks:
        1. Node is registered in the API server
        2. Node labels match ``NODE_LABEL`` env var
        3. If not registered, triggers CA mismatch check + re-join

    Args:
        cfg: Bootstrap configuration.
    """
    with StepRunner("verify-cluster-membership") as step:
        if step.skipped:
            return

        hostname = _get_hostname()
        if not hostname:
            log_warn("Could not resolve hostname — skipping membership verification")
            step.details["skipped_reason"] = "hostname unavailable"
            return

        log_info(f"Verifying cluster membership for node: {hostname}")
        step.details["hostname"] = hostname

        # Resolve the best available kubeconfig for this worker node.
        # Workers do not have admin.conf — preference order is SSM admin
        # kubeconfig → kubelet.conf → no override (kubectl will fail).
        kc_env = _resolve_worker_kubeconfig(cfg)

        # ── Check 1: Is this node registered? ──────────────────────────
        if _is_node_registered(hostname, kc_env):
            log_info(f"✓ Node {hostname} is registered in the cluster")
            step.details["registered"] = True

            # ── Check 2: Are labels correct? ───────────────────────────
            expected_labels = _parse_label_string(cfg.node_label)
            actual_labels = _get_current_labels(hostname, kc_env)

            mismatched = {
                k: (actual_labels.get(k, "<missing>"), v)
                for k, v in expected_labels.items()
                if actual_labels.get(k) != v
            }

            if not mismatched:
                log_info(
                    f"✓ All labels correct: {cfg.node_label}"
                )
                step.details["labels_correct"] = True
                return

            log_warn(
                f"Label drift detected on {hostname}: "
                f"{len(mismatched)} label(s) need correction"
            )
            step.details["labels_correct"] = False
            step.details["mismatched_labels"] = {
                k: {"actual": a, "expected": e}
                for k, (a, e) in mismatched.items()
            }

            corrected = _fix_labels(hostname, expected_labels, actual_labels, kc_env)
            step.details["corrected_labels"] = corrected

            if len(corrected) == len(mismatched):
                log_info("✓ All label drift corrected")
            else:
                log_warn(
                    f"Label correction incomplete: "
                    f"{len(corrected)}/{len(mismatched)} fixed"
                )
            return

        # ── Node NOT registered — attempt self-healing ─────────────────
        log_warn(
            f"Node {hostname} is NOT registered in the cluster — "
            f"triggering self-healing re-join"
        )
        step.details["registered"] = False

        # Run CA mismatch check (may do kubeadm reset)
        ca_reset = check_ca_mismatch(cfg)
        step.details["ca_reset"] = ca_reset

        # Attempt re-join
        kubelet_conf = Path(KUBELET_CONF)
        if kubelet_conf.exists():
            log_warn(
                "kubelet.conf exists but node not registered — "
                "removing to allow re-join"
            )
            run_cmd(["kubeadm", "reset", "-f"], check=False)
            kubelet_conf.unlink(missing_ok=True)

        try:
            endpoint = resolve_control_plane_endpoint(cfg)
            wait_for_api_server_reachable(endpoint)
            join_cluster(endpoint, cfg)
            wait_for_kubelet()
            log_info("✓ Self-healing re-join completed successfully")
            step.details["rejoined"] = True
        except RuntimeError as exc:
            log_warn(f"Self-healing re-join failed: {exc}")
            step.details["rejoined"] = False
            step.details["error"] = str(exc)
