#!/usr/bin/env python3
"""
@format
Step 02 — Initialize kubeadm Control Plane

Initializes the Kubernetes control plane using kubeadm, then publishes
join credentials (token, CA hash, endpoint) to SSM Parameter Store
for worker nodes to discover.

Idempotent: skips if /etc/kubernetes/admin.conf already exists.
On second-run: renews certificates and refreshes ssm-user kubeconfig.

Expected environment variables:
    K8S_VERSION      — Kubernetes version (e.g. 1.35.1)
    DATA_DIR         — kubeadm data directory (default: /data/kubernetes)
    POD_CIDR         — Pod network CIDR (default: 192.168.0.0/16)
    SERVICE_CIDR     — Service subnet (default: 10.96.0.0/12)
    SSM_PREFIX       — SSM parameter prefix (e.g. /k8s/development)
    AWS_REGION       — AWS region
"""

import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import (
    StepRunner, run_cmd, ssm_put, log_info, log_error, log_warn,
    ensure_ecr_credential_provider, ECR_PROVIDER_CONFIG,
)


# =============================================================================
# Configuration
# =============================================================================

K8S_VERSION = os.environ.get("K8S_VERSION", "1.35.1")
DATA_DIR = os.environ.get("DATA_DIR", "/data/kubernetes")
POD_CIDR = os.environ.get("POD_CIDR", "192.168.0.0/16")
SERVICE_CIDR = os.environ.get("SERVICE_CIDR", "10.96.0.0/12")
SSM_PREFIX = os.environ.get("SSM_PREFIX", "/k8s/development")
AWS_REGION = os.environ.get("AWS_REGION", "eu-west-1")
ADMIN_CONF = "/etc/kubernetes/admin.conf"
KUBECONFIG_ENV = {"KUBECONFIG": ADMIN_CONF}


# =============================================================================
# IMDS v2 Helper
# =============================================================================

def get_imds_value(path: str) -> str:
    """Fetch a value from EC2 Instance Metadata Service v2."""
    token = run_cmd(
        ["curl", "-sX", "PUT", "http://169.254.169.254/latest/api/token",
         "-H", "X-aws-ec2-metadata-token-ttl-seconds: 21600"],
        check=True,
    ).stdout.strip()

    result = run_cmd(
        ["curl", "-s", "-H", f"X-aws-ec2-metadata-token: {token}",
         f"http://169.254.169.254/latest/meta-data/{path}"],
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


# =============================================================================
# Second-Run Handler
# =============================================================================

def handle_second_run() -> None:
    """Handle second-run: renew certs, refresh kubeconfig."""
    log_info("Cluster already initialized — running second-run maintenance")

    # Refresh ssm-user kubeconfig
    result = run_cmd(["id", "ssm-user"], check=False)
    if result.returncode == 0:
        Path("/home/ssm-user/.kube").mkdir(parents=True, exist_ok=True)
        run_cmd(["cp", "-f", ADMIN_CONF, "/home/ssm-user/.kube/config"])
        run_cmd(["chown", "ssm-user:ssm-user", "/home/ssm-user/.kube/config"])
        run_cmd(["chmod", "600", "/home/ssm-user/.kube/config"])

    # Certificate renewal
    log_info("Renewing kubeadm certificates...")
    run_cmd(["kubeadm", "certs", "renew", "all"], check=False, env=KUBECONFIG_ENV)
    run_cmd(["kubeadm", "certs", "check-expiration"], check=False, env=KUBECONFIG_ENV)


# =============================================================================
# First-Boot Init
# =============================================================================

def init_cluster() -> None:
    """Initialize kubeadm cluster on first boot."""
    log_info(f"Initializing kubeadm cluster (v{K8S_VERSION})")

    # Create data directory
    Path(DATA_DIR).mkdir(parents=True, exist_ok=True)

    # Start containerd
    run_cmd(["systemctl", "start", "containerd"])
    log_info("containerd started")

    # Install ECR credential provider (no-op if pre-baked in Golden AMI)
    ensure_ecr_credential_provider()

    # Configure kubelet with ECR credential provider BEFORE kubeadm init
    # kubeadm init reads KUBELET_EXTRA_ARGS from /etc/sysconfig/kubelet
    Path("/etc/sysconfig").mkdir(parents=True, exist_ok=True)
    Path("/etc/sysconfig/kubelet").write_text(
        "KUBELET_EXTRA_ARGS="
        f"--image-credential-provider-config={ECR_PROVIDER_CONFIG}"
        " --image-credential-provider-bin-dir=/usr/local/bin\n"
    )
    log_info("Kubelet ECR credential provider args configured")

    # Get instance metadata
    private_ip = get_imds_value("local-ipv4")
    public_ip = get_imds_value("public-ipv4")
    instance_id = get_imds_value("instance-id")

    if not private_ip:
        raise RuntimeError("Failed to retrieve private IP from IMDS")

    # Build cert SANs
    cert_sans = f"--apiserver-cert-extra-sans={private_ip}"
    if public_ip:
        cert_sans += f",{public_ip}"

    # Run kubeadm init
    log_info("Running kubeadm init...")
    init_cmd = [
        "kubeadm", "init",
        f"--kubernetes-version={K8S_VERSION}",
        f"--pod-network-cidr={POD_CIDR}",
        f"--service-cidr={SERVICE_CIDR}",
        f"--control-plane-endpoint={private_ip}:6443",
        cert_sans,
        "--upload-certs",
    ]
    run_cmd(init_cmd, capture=False, timeout=300)

    # Set up kubeconfig for root
    Path("/root/.kube").mkdir(parents=True, exist_ok=True)
    run_cmd(["cp", "-f", ADMIN_CONF, "/root/.kube/config"])
    run_cmd(["chmod", "600", "/root/.kube/config"])

    # Set up kubeconfig for ssm-user (so kubectl works without sudo via SSM sessions)
    result = run_cmd(["id", "ssm-user"], check=False)
    if result.returncode == 0:
        Path("/home/ssm-user/.kube").mkdir(parents=True, exist_ok=True)
        run_cmd(["cp", "-f", ADMIN_CONF, "/home/ssm-user/.kube/config"])
        run_cmd(["chown", "ssm-user:ssm-user", "/home/ssm-user/.kube/config"])
        run_cmd(["chmod", "600", "/home/ssm-user/.kube/config"])
        log_info("Kubeconfig set up for ssm-user")

    # Wait for control plane API
    log_info("Waiting for control plane to be ready...")
    for i in range(1, 91):
        result = run_cmd(
            ["kubectl", "get", "nodes"],
            check=False, env=KUBECONFIG_ENV,
        )
        if result.returncode == 0:
            log_info(f"Control plane is ready (waited {i} seconds)")
            break
        if i == 90:
            log_warn("Control plane did not become ready in 90s")
        import time
        time.sleep(1)

    log_info("Control plane taint preserved — only Traefik + system pods will run here")

    # Publish join credentials to SSM
    publish_ssm_params(private_ip, public_ip, instance_id)


def publish_ssm_params(private_ip: str, public_ip: str, instance_id: str) -> None:
    """Publish join token, CA hash, and endpoint to SSM."""
    log_info("Publishing cluster credentials to SSM...")

    # Create join token
    token_result = run_cmd(
        ["kubeadm", "token", "create", "--ttl", "24h"],
        env=KUBECONFIG_ENV,
    )
    join_token = token_result.stdout.strip()

    # Get CA hash
    ca_hash_cmd = (
        "openssl x509 -pubkey -in /etc/kubernetes/pki/ca.crt | "
        "openssl rsa -pubin -outform der 2>/dev/null | "
        "openssl dgst -sha256 -hex | awk '{print $2}'"
    )
    ca_result = run_cmd(ca_hash_cmd, shell=True)
    ca_hash = ca_result.stdout.strip()

    # Write to SSM
    ssm_put(f"{SSM_PREFIX}/join-token", join_token, param_type="SecureString")
    ssm_put(f"{SSM_PREFIX}/ca-hash", f"sha256:{ca_hash}")
    ssm_put(f"{SSM_PREFIX}/control-plane-endpoint", f"{private_ip}:6443")
    ssm_put(f"{SSM_PREFIX}/instance-id", instance_id)

    # Refresh public IP (may have changed after EIP association)
    refreshed_public_ip = get_imds_value("public-ipv4")
    if refreshed_public_ip:
        ssm_put(f"{SSM_PREFIX}/elastic-ip", refreshed_public_ip)

    log_info("Cluster credentials published to SSM successfully")

    # Summary
    run_cmd(["kubectl", "get", "nodes", "-o", "wide"], check=False, env=KUBECONFIG_ENV)


# =============================================================================
# Main
# =============================================================================

def main() -> None:
    with StepRunner("init-kubeadm", skip_if=ADMIN_CONF) as step:
        if step.skipped:
            handle_second_run()
            return

        init_cluster()
        step.details["k8s_version"] = K8S_VERSION
        step.details["pod_cidr"] = POD_CIDR
        step.details["service_cidr"] = SERVICE_CIDR


if __name__ == "__main__":
    main()
