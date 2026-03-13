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
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import (
    StepRunner, run_cmd, ssm_get, log_info, log_warn, log_error,
    ensure_ecr_credential_provider, ECR_PROVIDER_CONFIG,
    SSM_PREFIX as DEFAULT_SSM_PREFIX, AWS_REGION as DEFAULT_AWS_REGION,
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

KUBELET_CONF = "/etc/kubernetes/kubelet.conf"


# =============================================================================
# Step 1 — Validate Golden AMI
# =============================================================================

REQUIRED_BINARIES = ["containerd", "kubeadm", "kubelet", "kubectl", "helm"]
REQUIRED_KERNEL_MODULES = ["overlay", "br_netfilter"]
REQUIRED_SYSCTL = {
    "net.bridge.bridge-nf-call-iptables": "1",
    "net.bridge.bridge-nf-call-ip6tables": "1",
    "net.ipv4.ip_forward": "1",
}


def _validate_binaries() -> list[str]:
    """Check that all required binaries are on $PATH. Returns missing list."""
    missing = []
    found = []
    for binary in REQUIRED_BINARIES:
        path = shutil.which(binary)
        if path:
            found.append(f"{binary} -> {path}")
        else:
            missing.append(binary)
    for f in found:
        log_info(f"  ✓ {f}")
    return missing


def _validate_kernel_modules() -> list[str]:
    """Check kernel modules are loaded. Returns missing list."""
    missing = []
    try:
        loaded = Path("/proc/modules").read_text()
    except FileNotFoundError:
        log_error("/proc/modules not found — cannot validate kernel modules")
        return REQUIRED_KERNEL_MODULES

    for mod in REQUIRED_KERNEL_MODULES:
        if mod in loaded:
            log_info(f"  ✓ Kernel module: {mod}")
        else:
            missing.append(mod)
    return missing


def _validate_sysctl() -> list[str]:
    """Check sysctl settings. Returns misconfigured list."""
    errors = []
    for key, expected in REQUIRED_SYSCTL.items():
        sysctl_path = Path(f"/proc/sys/{key.replace('.', '/')}")
        try:
            actual = sysctl_path.read_text().strip()
            if actual == expected:
                log_info(f"  ✓ sysctl {key} = {actual}")
            else:
                errors.append(f"{key}: expected={expected}, actual={actual}")
        except FileNotFoundError:
            errors.append(f"{key}: not found at {sysctl_path}")
    return errors


def step_validate_ami() -> None:
    """Step 1: Validate Golden AMI binaries and kernel settings."""
    with StepRunner("validate-ami") as step:
        if step.skipped:
            return

        log_info("Checking required binaries...")
        missing_bins = _validate_binaries()
        step.details["binaries_checked"] = REQUIRED_BINARIES
        step.details["binaries_missing"] = missing_bins

        log_info("Checking kernel modules...")
        missing_mods = _validate_kernel_modules()
        step.details["modules_missing"] = missing_mods

        log_info("Checking sysctl settings...")
        sysctl_errors = _validate_sysctl()
        step.details["sysctl_errors"] = sysctl_errors

        errors = []
        if missing_bins:
            errors.append(f"Missing binaries: {', '.join(missing_bins)}")
        if missing_mods:
            errors.append(f"Missing kernel modules: {', '.join(missing_mods)}")
        if sysctl_errors:
            errors.append(f"Sysctl errors: {'; '.join(sysctl_errors)}")

        if errors:
            msg = (
                "Golden AMI validation FAILED.\n"
                "  The bootstrap script does NOT install packages at boot time.\n"
                "  All binaries must be pre-baked into the Golden AMI.\n\n"
                f"  Errors:\n" +
                "\n".join(f"    - {e}" for e in errors) +
                "\n\n  Resolution: Rebuild the Golden AMI with the missing components."
            )
            raise RuntimeError(msg)

        log_info("✓ Golden AMI validated — all required binaries and settings present")


# =============================================================================
# Step 2 — Join kubeadm Cluster
# =============================================================================

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


def _join_cluster(endpoint: str) -> None:
    """Join the cluster with retry logic."""
    log_info(f"Joining kubeadm cluster as worker node (label={NODE_LABEL})")
    log_info(f"Join config: max_retries={JOIN_MAX_RETRIES}, retry_interval={JOIN_RETRY_INTERVAL}s")

    run_cmd(["systemctl", "start", "containerd"])
    log_info("containerd started")

    ensure_ecr_credential_provider()

    log_info(f"Configuring kubelet with node label: {NODE_LABEL}")
    Path("/etc/sysconfig").mkdir(parents=True, exist_ok=True)
    Path("/etc/sysconfig/kubelet").write_text(
        f"KUBELET_EXTRA_ARGS=--node-labels={NODE_LABEL}"
        f" --image-credential-provider-config={ECR_PROVIDER_CONFIG}"
        " --image-credential-provider-bin-dir=/usr/local/bin\n"
    )

    token_ssm = f"{SSM_PREFIX}/join-token"
    ca_hash_ssm = f"{SSM_PREFIX}/ca-hash"

    for attempt in range(1, JOIN_MAX_RETRIES + 1):
        log_info(f"=== kubeadm join attempt {attempt}/{JOIN_MAX_RETRIES} ===")

        join_token = ssm_get(token_ssm, decrypt=True)
        if not join_token:
            log_warn(f"Join token not available (attempt {attempt}/{JOIN_MAX_RETRIES})")
            if attempt < JOIN_MAX_RETRIES:
                time.sleep(JOIN_RETRY_INTERVAL)
                continue
            raise RuntimeError(f"Join token never became available after {JOIN_MAX_RETRIES} attempts")

        ca_hash = ssm_get(ca_hash_ssm)
        if not ca_hash:
            log_warn(f"CA hash not available (attempt {attempt}/{JOIN_MAX_RETRIES})")
            if attempt < JOIN_MAX_RETRIES:
                time.sleep(JOIN_RETRY_INTERVAL)
                continue
            raise RuntimeError(f"CA hash never became available after {JOIN_MAX_RETRIES} attempts")

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
    """Step 2: Join kubeadm cluster via SSM discovery."""
    with StepRunner("join-cluster", skip_if=KUBELET_CONF) as step:
        if step.skipped:
            return

        endpoint = _resolve_control_plane_endpoint()
        _join_cluster(endpoint)
        _wait_for_kubelet()

        kubelet_version = run_cmd(
            ["kubelet", "--version"], check=False
        ).stdout.strip()
        step.details["node_label"] = NODE_LABEL
        step.details["kubelet_version"] = kubelet_version
        step.details["control_plane_endpoint"] = endpoint
        log_info(f"Worker node joined cluster successfully: {kubelet_version}")


# =============================================================================
# Step 3 — Install CloudWatch Agent
# =============================================================================

CW_MARKER_FILE = "/tmp/.cw-agent-installed"
CW_AGENT_CTL = "/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl"
CW_AGENT_CONFIG_PATH = "/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json"
K8S_ENV_FILE = "/etc/profile.d/k8s-env.sh"

CW_LOG_FILES = [
    {"file_path": "/var/log/messages", "log_stream_name": "{instance_id}/messages"},
    {"file_path": "/var/log/user-data.log", "log_stream_name": "{instance_id}/user-data"},
    {"file_path": "/var/log/cloud-init-output.log", "log_stream_name": "{instance_id}/cloud-init"},
]


def _resolve_log_group_name() -> str:
    """Resolve the CloudWatch log group name from environment or k8s-env.sh."""
    log_group = os.environ.get("LOG_GROUP_NAME", "")
    if log_group:
        return log_group

    env_file = Path(K8S_ENV_FILE)
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line.startswith("export LOG_GROUP_NAME="):
                value = line.split("=", 1)[1].strip().strip('"').strip("'")
                if value:
                    return value
    return ""


def step_install_cloudwatch_agent() -> None:
    """Step 3: Install and configure CloudWatch Agent for log streaming."""
    with StepRunner("install-cloudwatch-agent", skip_if=CW_MARKER_FILE) as step:
        if step.skipped:
            return

        log_group_name = _resolve_log_group_name()
        if not log_group_name:
            log_warn(
                "LOG_GROUP_NAME not found in environment or k8s-env.sh — "
                "skipping CloudWatch Agent installation"
            )
            step.details["skipped_reason"] = "LOG_GROUP_NAME not set"
            return

        log_info(f"Target log group: {log_group_name}")
        step.details["log_group_name"] = log_group_name

        log_info("Installing amazon-cloudwatch-agent...")
        result = run_cmd(
            "dnf install -y amazon-cloudwatch-agent 2>/dev/null || "
            "yum install -y amazon-cloudwatch-agent",
            shell=True, check=True, timeout=120,
        )
        step.details["install_exit_code"] = result.returncode

        collect_list = []
        for lf in CW_LOG_FILES:
            collect_list.append({
                "file_path": lf["file_path"],
                "log_group_name": log_group_name,
                "log_stream_name": lf["log_stream_name"],
                "retention_in_days": 30,
            })

        config = {
            "agent": {
                "metrics_collection_interval": 60,
                "logfile": "/opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log",
            },
            "logs": {
                "logs_collected": {
                    "files": {"collect_list": collect_list},
                },
            },
        }

        config_path = Path(CW_AGENT_CONFIG_PATH)
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(json.dumps(config, indent=2))
        log_info(f"Agent config written to {CW_AGENT_CONFIG_PATH}")
        step.details["log_files"] = [lf["file_path"] for lf in CW_LOG_FILES]

        log_info("Starting CloudWatch Agent...")
        run_cmd([
            CW_AGENT_CTL,
            "-a", "fetch-config",
            "-m", "ec2",
            "-c", f"file:{CW_AGENT_CONFIG_PATH}",
            "-s",
        ], timeout=60)

        result = run_cmd([CW_AGENT_CTL, "-a", "status"], check=False)
        if result.returncode == 0 and "running" in result.stdout.lower():
            log_info("CloudWatch Agent is running")
            step.details["agent_status"] = "running"
        else:
            log_warn("CloudWatch Agent may not be running — check agent logs")
            step.details["agent_status"] = "unknown"


# =============================================================================
# Main — Sequential Worker Bootstrap
# =============================================================================

def main() -> None:
    """Execute all worker node bootstrap steps in order."""
    steps = [
        step_validate_ami,
        step_join_cluster,
        step_install_cloudwatch_agent,
    ]

    log_info(f"Worker node bootstrap starting ({len(steps)} steps)")
    for i, step_fn in enumerate(steps, 1):
        log_info(f"\n{'='*60}")
        log_info(f"Step {i}/{len(steps)}: {step_fn.__name__}")
        log_info(f"{'='*60}")
        step_fn()

    log_info("Worker node bootstrap complete")


if __name__ == "__main__":
    main()
