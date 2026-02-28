#!/usr/bin/env python3
"""
@format
Worker Step — Join kubeadm Cluster

Joins a worker node to an existing kubeadm cluster by:
1. Resolving the control plane endpoint from SSM (with wait loop)
2. Retrieving join token + CA hash from SSM
3. Running kubeadm join with retry
4. Waiting for kubelet to become active

This replaces the logic in boot-worker.sh (lines 96-255).

Idempotent: skips if /etc/kubernetes/kubelet.conf already exists.

Expected environment variables:
    SSM_PREFIX       — SSM parameter prefix (e.g. /k8s/development)
    NODE_LABEL       — Kubernetes node label (e.g. role=application)
    AWS_REGION       — AWS region
"""

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import (
    StepRunner, run_cmd, ssm_get, log_info, log_warn, log_error,
    AWS_REGION,
)

# =============================================================================
# Configuration
# =============================================================================

SSM_PREFIX = os.environ.get("SSM_PREFIX", "/k8s/development")
NODE_LABEL = os.environ.get("NODE_LABEL", "role=worker")
JOIN_MAX_RETRIES = int(os.environ.get("JOIN_MAX_RETRIES", "10"))
JOIN_RETRY_INTERVAL = int(os.environ.get("JOIN_RETRY_INTERVAL", "30"))
CP_MAX_WAIT = 300  # seconds to wait for control plane endpoint

KUBELET_CONF = "/etc/kubernetes/kubelet.conf"


# =============================================================================
# Logic
# =============================================================================

def resolve_control_plane_endpoint() -> str:
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


def join_cluster(endpoint: str) -> None:
    """Join the cluster with retry logic."""
    log_info(f"Joining kubeadm cluster as worker node (label={NODE_LABEL})")
    log_info(f"Join config: max_retries={JOIN_MAX_RETRIES}, retry_interval={JOIN_RETRY_INTERVAL}s")

    # Start containerd
    run_cmd(["systemctl", "start", "containerd"])
    log_info("containerd started")

    # Configure kubelet with node label BEFORE joining
    log_info(f"Configuring kubelet with node label: {NODE_LABEL}")
    Path("/etc/sysconfig").mkdir(parents=True, exist_ok=True)
    Path("/etc/sysconfig/kubelet").write_text(
        f"KUBELET_EXTRA_ARGS=--node-labels={NODE_LABEL}\n"
    )

    token_ssm = f"{SSM_PREFIX}/join-token"
    ca_hash_ssm = f"{SSM_PREFIX}/ca-hash"

    for attempt in range(1, JOIN_MAX_RETRIES + 1):
        log_info(f"=== kubeadm join attempt {attempt}/{JOIN_MAX_RETRIES} ===")

        # Retrieve join token (re-fetch each attempt — may be refreshed)
        join_token = ssm_get(token_ssm, decrypt=True)
        if not join_token:
            log_warn(f"Join token not available (attempt {attempt}/{JOIN_MAX_RETRIES})")
            if attempt < JOIN_MAX_RETRIES:
                time.sleep(JOIN_RETRY_INTERVAL)
                continue
            raise RuntimeError(f"Join token never became available after {JOIN_MAX_RETRIES} attempts")

        # Retrieve CA hash
        ca_hash = ssm_get(ca_hash_ssm)
        if not ca_hash:
            log_warn(f"CA hash not available (attempt {attempt}/{JOIN_MAX_RETRIES})")
            if attempt < JOIN_MAX_RETRIES:
                time.sleep(JOIN_RETRY_INTERVAL)
                continue
            raise RuntimeError(f"CA hash never became available after {JOIN_MAX_RETRIES} attempts")

        # Attempt join
        log_info("Running kubeadm join...")
        result = run_cmd(
            ["kubeadm", "join", endpoint,
             "--token", join_token,
             "--discovery-token-ca-cert-hash", ca_hash],
            check=False, capture=False, timeout=120,
        )

        if result.returncode == 0:
            log_info(f"kubeadm join succeeded on attempt {attempt}")
            return

        log_warn(f"kubeadm join failed on attempt {attempt}/{JOIN_MAX_RETRIES}")

        # Reset before retry
        if attempt < JOIN_MAX_RETRIES:
            log_info("Running kubeadm reset before retry...")
            run_cmd(["kubeadm", "reset", "-f"], check=False)
            time.sleep(JOIN_RETRY_INTERVAL)

    raise RuntimeError(f"kubeadm join failed after {JOIN_MAX_RETRIES} attempts")


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
            run_cmd(["journalctl", "-u", "kubelet", "--no-pager", "-n", "20"],
                    check=False)
        time.sleep(1)


# =============================================================================
# Main
# =============================================================================

def main() -> None:
    with StepRunner("join-cluster", skip_if=KUBELET_CONF) as step:
        if step.skipped:
            return

        endpoint = resolve_control_plane_endpoint()
        join_cluster(endpoint)
        wait_for_kubelet()

        # Report
        kubelet_version = run_cmd(
            ["kubelet", "--version"], check=False
        ).stdout.strip()
        step.details["node_label"] = NODE_LABEL
        step.details["kubelet_version"] = kubelet_version
        step.details["control_plane_endpoint"] = endpoint
        log_info(f"Worker node joined cluster successfully: {kubelet_version}")


if __name__ == "__main__":
    main()
