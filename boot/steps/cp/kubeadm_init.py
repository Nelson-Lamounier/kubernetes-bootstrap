"""Step 3 — Initialise kubeadm control plane.

Handles first-boot ``kubeadm init``, DNS record creation, SSM parameter
publishing, and certificate backup. On subsequent runs (EBS already has
admin.conf), performs second-run maintenance instead.
"""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

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
    ssm_put,
)
from boot_helpers.config import BootConfig

# ── Constants ──────────────────────────────────────────────────────────────

ADMIN_CONF = "/etc/kubernetes/admin.conf"
KUBECONFIG_ENV = {"KUBECONFIG": ADMIN_CONF}
DR_BACKUP_PREFIX = "dr-backups"


# ── Helpers ────────────────────────────────────────────────────────────────

def label_control_plane_node(cfg: BootConfig) -> None:
    """Apply workload and environment labels to the control plane node."""
    hostname = run_cmd(
        ["kubectl", "get", "nodes",
         "-l", "node-role.kubernetes.io/control-plane=",
         "-o", "jsonpath={.items[0].metadata.name}"],
        check=False, env=KUBECONFIG_ENV,
    )
    node_name = hostname.stdout.strip()
    if not node_name:
        log_warn("Could not resolve control plane node name — skipping labelling")
        return

    labels = {
        "workload": "control-plane",
        "environment": cfg.environment,
    }
    label_args = [f"{k}={v}" for k, v in labels.items()]

    result = run_cmd(
        ["kubectl", "label", "node", node_name, "--overwrite", *label_args],
        check=False, env=KUBECONFIG_ENV,
    )
    if result.returncode == 0:
        log_info(f"Control plane node labelled: {', '.join(label_args)}")
    else:
        log_warn(f"Failed to label control plane node: {result.stderr.strip()}")


def update_dns_record(
    private_ip: str,
    cfg: BootConfig,
) -> None:
    """Update Route 53 A record to point to the current private IP."""
    if not cfg.hosted_zone_id:
        log_warn("HOSTED_ZONE_ID not set — skipping DNS update")
        return

    log_info(f"Updating DNS: {cfg.api_dns_name} → {private_ip}")
    change_batch = json.dumps({
        "Changes": [{
            "Action": "UPSERT",
            "ResourceRecordSet": {
                "Name": cfg.api_dns_name,
                "Type": "A",
                "TTL": 30,
                "ResourceRecords": [{"Value": private_ip}],
            },
        }],
    })
    result = run_cmd(
        ["aws", "route53", "change-resource-record-sets",
         "--hosted-zone-id", cfg.hosted_zone_id,
         "--change-batch", change_batch,
         "--region", cfg.aws_region],
        check=False,
    )
    if result.returncode != 0:
        log_error(f"DNS update failed: {result.stderr}")
        raise RuntimeError(
            f"Failed to update {cfg.api_dns_name} → {private_ip}. "
            "Check HOSTED_ZONE_ID and IAM permissions."
        )
    log_info(f"DNS updated: {cfg.api_dns_name} → {private_ip}")


def publish_ssm_params(
    private_ip: str,
    public_ip: str,
    instance_id: str,
    cfg: BootConfig,
) -> None:
    """Publish join token, CA hash, and endpoint to SSM."""
    log_info("Publishing cluster credentials to SSM...")

    token_result = run_cmd(
        ["kubeadm", "token", "create", "--ttl", "24h"],
        env=KUBECONFIG_ENV,
    )
    join_token = token_result.stdout.strip()

    ca_hash_cmd = (
        "openssl x509 -pubkey -in /etc/kubernetes/pki/ca.crt | "
        "openssl rsa -pubin -outform der 2>/dev/null | "
        "openssl dgst -sha256 -hex | awk '{print $2}'"
    )
    ca_result = run_cmd(ca_hash_cmd, shell=True)
    ca_hash = ca_result.stdout.strip()

    api_endpoint = f"{cfg.api_dns_name}:6443"
    ssm_put(f"{cfg.ssm_prefix}/join-token", join_token, param_type="SecureString")
    ssm_put(f"{cfg.ssm_prefix}/ca-hash", f"sha256:{ca_hash}")
    ssm_put(f"{cfg.ssm_prefix}/control-plane-endpoint", api_endpoint)
    ssm_put(f"{cfg.ssm_prefix}/instance-id", instance_id)

    log_info("Cluster credentials published to SSM successfully")
    run_cmd(["kubectl", "get", "nodes", "-o", "wide"], check=False, env=KUBECONFIG_ENV)


def publish_kubeconfig_to_ssm(cfg: BootConfig) -> None:
    """Store a tunnel-ready kubeconfig in SSM for developer access.

    Rewrites the server address to ``https://127.0.0.1:6443`` for SSM
    port-forwarding tunnel access.
    """
    admin_conf = Path(ADMIN_CONF)
    if not admin_conf.exists():
        log_warn(f"{ADMIN_CONF} not found — skipping kubeconfig publish")
        return

    kubeconfig_content = admin_conf.read_text()
    tunnel_kubeconfig = re.sub(
        r"server:\s*https?://[^:]+:6443",
        "server: https://127.0.0.1:6443",
        kubeconfig_content,
    )

    ssm_path = f"{cfg.ssm_prefix}/kubeconfig"
    log_info(f"Publishing tunnel-ready kubeconfig to SSM: {ssm_path}")
    ssm_put(ssm_path, tunnel_kubeconfig, param_type="SecureString", tier="Advanced")


def backup_certificates(cfg: BootConfig) -> None:
    """Archive /etc/kubernetes/pki/ to S3 for disaster recovery."""
    if not cfg.s3_bucket:
        log_warn("S3_BUCKET not set — skipping certificate backup")
        return

    pki_dir = Path("/etc/kubernetes/pki")
    if not pki_dir.exists():
        log_warn("PKI directory not found — skipping certificate backup")
        return

    timestamp = time.strftime("%Y%m%d-%H%M%S")
    archive_path = f"/tmp/k8s-pki-{timestamp}.tar.gz"

    try:
        log_info("Backing up PKI certificates to S3...")
        run_cmd(["tar", "czf", archive_path, "-C", "/etc/kubernetes", "pki"])

        s3_key = f"{DR_BACKUP_PREFIX}/pki/{timestamp}.tar.gz"
        run_cmd([
            "aws", "s3", "cp", archive_path,
            f"s3://{cfg.s3_bucket}/{s3_key}",
            "--sse", "AES256", "--region", cfg.aws_region,
        ])

        run_cmd([
            "aws", "s3", "cp", archive_path,
            f"s3://{cfg.s3_bucket}/{DR_BACKUP_PREFIX}/pki/latest.tar.gz",
            "--sse", "AES256", "--region", cfg.aws_region,
        ])

        log_info(f"✓ PKI certificates backed up to s3://{cfg.s3_bucket}/{s3_key}")
    except Exception as err:
        log_error(f"Certificate backup failed: {err}")
        log_warn("Continuing bootstrap — backup failure is non-fatal")
    finally:
        if Path(archive_path).exists():
            os.remove(archive_path)


def handle_second_run(cfg: BootConfig) -> None:
    """Handle second-run: update DNS and refresh kubeconfig."""
    log_info("Cluster already initialised — running second-run maintenance")

    private_ip = get_imds_value("local-ipv4")
    if private_ip:
        update_dns_record(private_ip, cfg)

    api_endpoint = f"{cfg.api_dns_name}:6443"
    log_info(f"Publishing DNS endpoint to SSM: {api_endpoint}")
    ssm_put(f"{cfg.ssm_prefix}/control-plane-endpoint", api_endpoint)

    result = run_cmd(["id", "ssm-user"], check=False)
    if result.returncode == 0:
        Path("/home/ssm-user/.kube").mkdir(parents=True, exist_ok=True)
        run_cmd(["cp", "-f", ADMIN_CONF, "/home/ssm-user/.kube/config"])
        run_cmd(["chown", "ssm-user:ssm-user", "/home/ssm-user/.kube/config"])
        run_cmd(["chmod", "600", "/home/ssm-user/.kube/config"])

    publish_kubeconfig_to_ssm(cfg)

    result = run_cmd(
        ["kubectl", "get", "nodes"],
        check=False, env=KUBECONFIG_ENV,
    )
    if result.returncode != 0:
        log_warn("API server not responding — certs may need renewal + restart")
    else:
        log_info("API server healthy — second-run maintenance complete")
        label_control_plane_node(cfg)


def init_cluster(cfg: BootConfig) -> None:
    """Initialise kubeadm cluster on first boot."""
    log_info(f"Initialising kubeadm cluster (v{cfg.k8s_version})")

    Path(cfg.data_dir).mkdir(parents=True, exist_ok=True)
    run_cmd(["systemctl", "start", "containerd"])
    log_info("containerd started")

    ensure_ecr_credential_provider()

    private_ip = get_imds_value("local-ipv4")
    if not private_ip:
        raise RuntimeError("Failed to retrieve private IP from IMDS")

    Path("/etc/sysconfig").mkdir(parents=True, exist_ok=True)
    Path("/etc/sysconfig/kubelet").write_text(
        "KUBELET_EXTRA_ARGS="
        "--cloud-provider=external"
        f" --node-ip={private_ip}"
        f" --image-credential-provider-config={ECR_PROVIDER_CONFIG}"
        " --image-credential-provider-bin-dir=/usr/local/bin\n"
    )
    log_info(f"Kubelet args configured: cloud-provider=external, node-ip={private_ip}")

    public_ip = get_imds_value("public-ipv4")
    instance_id = get_imds_value("instance-id")

    log_info("Running kubeadm init...")
    update_dns_record(private_ip, cfg)

    api_endpoint = f"{cfg.api_dns_name}:6443"
    init_cmd = [
        "kubeadm", "init",
        f"--kubernetes-version={cfg.k8s_version}",
        f"--pod-network-cidr={cfg.pod_cidr}",
        f"--service-cidr={cfg.service_cidr}",
        f"--control-plane-endpoint={api_endpoint}",
        f"--apiserver-cert-extra-sans=127.0.0.1,{private_ip},{cfg.api_dns_name}"
        + (f",{public_ip}" if public_ip else ""),
        "--upload-certs",
    ]
    run_cmd(init_cmd, capture=False, timeout=300)

    Path("/root/.kube").mkdir(parents=True, exist_ok=True)
    run_cmd(["cp", "-f", ADMIN_CONF, "/root/.kube/config"])
    run_cmd(["chmod", "600", "/root/.kube/config"])

    result = run_cmd(["id", "ssm-user"], check=False)
    if result.returncode == 0:
        Path("/home/ssm-user/.kube").mkdir(parents=True, exist_ok=True)
        run_cmd(["cp", "-f", ADMIN_CONF, "/home/ssm-user/.kube/config"])
        run_cmd(["chown", "ssm-user:ssm-user", "/home/ssm-user/.kube/config"])
        run_cmd(["chmod", "600", "/home/ssm-user/.kube/config"])
        log_info("Kubeconfig set up for ssm-user")

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
        time.sleep(1)

    log_info("Control plane taint preserved — only Traefik + system pods will run here")
    label_control_plane_node(cfg)

    patch_provider_id(kubeconfig="/root/.kube/config")

    publish_ssm_params(private_ip, public_ip, instance_id, cfg)
    publish_kubeconfig_to_ssm(cfg)
    backup_certificates(cfg)


# ── Step ───────────────────────────────────────────────────────────────────

def step_init_kubeadm(cfg: BootConfig) -> None:
    """Step 3: Initialise kubeadm control plane.

    Args:
        cfg: Bootstrap configuration.
    """
    with StepRunner("init-kubeadm", skip_if=ADMIN_CONF) as step:
        if step.skipped:
            handle_second_run(cfg)
            return

        init_cluster(cfg)
        step.details["k8s_version"] = cfg.k8s_version
        step.details["pod_cidr"] = cfg.pod_cidr
        step.details["service_cidr"] = cfg.service_cidr
