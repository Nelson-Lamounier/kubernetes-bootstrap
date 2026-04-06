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
"""
from __future__ import annotations

import socket

from common import (
    StepRunner,
    get_imds_value,
    log_info,
    log_warn,
    run_cmd,
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

# Timeout for the kubectl probe that checks node registration.
KUBECTL_PROBE_TIMEOUT = 10


# ── Helpers ────────────────────────────────────────────────────────────────

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


def _is_node_registered(hostname: str) -> bool:
    """Check whether this node is registered in the API server.

    Args:
        hostname: The Kubernetes node name to look up.

    Returns:
        ``True`` if the node exists and is returned by ``kubectl get node``.
    """
    result = run_cmd(
        ["kubectl", "get", "node", hostname, "--no-headers"],
        check=False,
        timeout=KUBECTL_PROBE_TIMEOUT,
    )
    return result.returncode == 0 and hostname in result.stdout


def _get_current_labels(hostname: str) -> dict[str, str]:
    """Retrieve the current label set for a node.

    Args:
        hostname: The Kubernetes node name.

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


def _fix_labels(hostname: str, expected: dict[str, str], actual: dict[str, str]) -> list[str]:
    """Apply missing or incorrect labels to the node.

    Only corrects labels that are defined in ``expected``. Does not
    remove extra labels that are present in ``actual`` but absent
    from ``expected`` — those may have been applied by other systems.

    Args:
        hostname: The Kubernetes node name.
        expected: Labels that should be present (from NODE_LABEL env var).
        actual: Labels currently on the node.

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
            )
            if result.returncode == 0:
                log_info(f"✓ Corrected label: {label_arg}")
                corrected.append(label_arg)
            else:
                log_warn(f"✗ Failed to correct label: {label_arg}")

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

        # ── Check 1: Is this node registered? ──────────────────────────
        if _is_node_registered(hostname):
            log_info(f"✓ Node {hostname} is registered in the cluster")
            step.details["registered"] = True

            # ── Check 2: Are labels correct? ───────────────────────────
            expected_labels = _parse_label_string(cfg.node_label)
            actual_labels = _get_current_labels(hostname)

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

            corrected = _fix_labels(hostname, expected_labels, actual_labels)
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
        from pathlib import Path
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
