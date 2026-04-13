#!/usr/bin/env python3
"""
@format
Control Plane Bootstrap — Consolidated Steps

Orchestrates the full Kubernetes control plane bootstrap as a single
entry point. Each step is wrapped in a StepRunner for structured
logging, timing, and idempotency guards.

Steps (in order):
    1.  validate_ami       — Verify Golden AMI binaries and kernel settings
    2.  restore_backup     — Restore etcd + certs from S3 if EBS is empty (DR)
    3.  init_kubeadm       — kubeadm init + publish join credentials to SSM
    4.  install_calico     — Calico CNI via Tigera operator
    4b. install_ccm        — AWS Cloud Controller Manager (removes uninitialized taint)
    5.  configure_kubectl  — kubeconfig for root, ec2-user, ssm-user
    6.  sync_manifests     — Download bootstrap manifests from S3
    7.  bootstrap_argocd   — Install ArgoCD and App-of-Apps
    8.  verify_cluster     — Lightweight post-boot health checks
    9.  install_cw_agent   — CloudWatch Agent for log streaming
    10. install_etcd_backup — Set up hourly etcd backup timer

Idempotent: each step uses marker files or existence checks to skip
if already completed. Safe to re-run on instance replacement.

Expected environment variables:
    SSM_PREFIX       — SSM parameter prefix (e.g. /k8s/development)
    AWS_REGION       — AWS region
    K8S_VERSION      — Kubernetes version (e.g. 1.35.1)
    DATA_DIR         — kubeadm data directory (default: /data/kubernetes)
    POD_CIDR         — Pod network CIDR (default: 192.168.0.0/16)
    SERVICE_CIDR     — Service subnet (default: 10.96.0.0/12)
    HOSTED_ZONE_ID   — Route 53 hosted zone for API DNS
    API_DNS_NAME     — DNS name for K8s API (default: k8s-api.k8s.internal)
    S3_BUCKET        — S3 bucket containing bootstrap content
    MOUNT_POINT      — Local mount point (default: /data)
    CALICO_VERSION   — Calico version (default: v3.29.3)
    LOG_GROUP_NAME   — CloudWatch log group name

Usage:
    python3 control_plane.py
"""

import json
import os
import re
import shutil
import sys
import time
import yaml
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
    ssm_put,
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
K8S_VERSION = os.environ.get("K8S_VERSION", "1.35.1")
DATA_DIR = os.environ.get("DATA_DIR", "/data/kubernetes")
POD_CIDR = os.environ.get("POD_CIDR", "192.168.0.0/16")
SERVICE_CIDR = os.environ.get("SERVICE_CIDR", "10.96.0.0/12")
HOSTED_ZONE_ID = os.environ.get("HOSTED_ZONE_ID", "")
API_DNS_NAME = os.environ.get("API_DNS_NAME", "k8s-api.k8s.internal")
S3_BUCKET = os.environ.get("S3_BUCKET", "")
MOUNT_POINT = os.environ.get("MOUNT_POINT", "/data")
CALICO_VERSION = os.environ.get("CALICO_VERSION", "v3.29.3")
ENVIRONMENT = os.environ.get("ENVIRONMENT", "development")

ADMIN_CONF = "/etc/kubernetes/admin.conf"
SUPER_ADMIN_CONF = "/etc/kubernetes/super-admin.conf"
HEALTHZ_PATH = "/healthz"
ROOT_KUBECONFIG = "/root/.kube/config"
ROOT_SUPER_ADMIN_KUBECONFIG = "/root/.kube/super-admin.conf"

_ENV_FILE = "/etc/kubernetes/bootstrap-env"
if Path(_ENV_FILE).exists():
    for line in Path(_ENV_FILE).read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())


def _bootstrap_kubeconfig_env() -> dict[str, str]:
    """Return the best kubeconfig env for bootstrap operations.

    Prefers super-admin.conf (kubeadm 1.30+) which bypasses RBAC,
    making bootstrap operations resilient to missing ClusterRoleBindings.
    Falls back to admin.conf for first-boot (before kubeadm init creates it).
    """
    if Path(SUPER_ADMIN_CONF).exists():
        return {"KUBECONFIG": SUPER_ADMIN_CONF}
    return {"KUBECONFIG": ADMIN_CONF}

CALICO_MARKER = "/etc/kubernetes/.calico-installed"
CCM_MARKER = "/etc/kubernetes/.ccm-installed"

# DR backup paths
DR_BACKUP_PREFIX = "dr-backups"
DR_RESTORE_MARKER = "/etc/kubernetes/.dr-restored"


# =============================================================================
# Step 1 — Validate Golden AMI
# Imported from common: step_validate_ami()


# =============================================================================
# Step 2 — Initialize kubeadm Control Plane
# =============================================================================


def _label_control_plane_node() -> None:
    """Apply role and workload labels to the control plane node.

    Uses the node hostname from IMDS to identify the node directly,
    avoiding the chicken-and-egg problem where the role label selector
    returns nothing on a fresh node that hasn't been labelled yet.
    """
    hostname = run_cmd(
        ["hostname", "-f"],
        check=False,
    )
    node_name = hostname.stdout.strip()
    if not node_name:
        log_warn("Could not resolve node hostname — skipping labelling")
        return

    labels = {
        "node-role.kubernetes.io/control-plane": "",
        "workload": "control-plane",
        "environment": ENVIRONMENT,
    }
    label_args = [f"{k}={v}" for k, v in labels.items()]

    result = run_cmd(
        ["kubectl", "label", "node", node_name, "--overwrite", *label_args],
        check=False, env=_bootstrap_kubeconfig_env(),
    )
    if result.returncode == 0:
        log_info(f"Control plane node labelled: {', '.join(label_args)}")
    else:
        log_warn(f"Failed to label control plane node: {result.stderr.strip()}")


def _update_dns_record(private_ip: str) -> None:
    """Update Route 53 A record to point to the current private IP."""
    if not HOSTED_ZONE_ID:
        log_warn("HOSTED_ZONE_ID not set — skipping DNS update")
        return

    log_info(f"Updating DNS: {API_DNS_NAME} → {private_ip}")
    change_batch = json.dumps({
        "Changes": [{
            "Action": "UPSERT",
            "ResourceRecordSet": {
                "Name": API_DNS_NAME,
                "Type": "A",
                "TTL": 30,
                "ResourceRecords": [{"Value": private_ip}],
            },
        }],
    })
    result = run_cmd(
        ["aws", "route53", "change-resource-record-sets",
         "--hosted-zone-id", HOSTED_ZONE_ID,
         "--change-batch", change_batch,
         "--region", AWS_REGION],
        check=False,
    )
    if result.returncode != 0:
        log_error(f"DNS update failed: {result.stderr}")
        raise RuntimeError(
            f"Failed to update {API_DNS_NAME} → {private_ip}. "
            "Check HOSTED_ZONE_ID and IAM permissions."
        )
    log_info(f"DNS updated: {API_DNS_NAME} → {private_ip}")


def _get_apiserver_cert_ips() -> list[str]:
    """Extract the IP SANs from the current API server certificate.

    Returns a list of IP addresses the cert is currently valid for,
    so we can detect when the instance IP has changed (e.g. after ASG replacement).
    """
    result = run_cmd(
        ["openssl", "x509", "-in", "/etc/kubernetes/pki/apiserver.crt",
         "-noout", "-text"],
        check=False,
    )
    if result.returncode != 0:
        return []

    ips: list[str] = []
    in_san = False
    for line in result.stdout.splitlines():
        if "Subject Alternative Name" in line:
            in_san = True
            continue
        if in_san:
            for part in line.split(","):
                part = part.strip()
                if part.startswith("IP Address:"):
                    ips.append(part.removeprefix("IP Address:").strip())
            break
    return ips


def _renew_apiserver_cert_files(private_ip: str, public_ip: str) -> None:
    """Regenerate API server cert/key files ONLY — no container restart.

    Called during DR reconstruction BEFORE static pod manifests exist.
    The container restart + health wait happens after kubelet starts.
    """
    log_info(f"Renewing API server certificate files for IP {private_ip}...")

    extra_sans = f"127.0.0.1,{private_ip},{API_DNS_NAME}"
    if public_ip:
        extra_sans += f",{public_ip}"

    # Remove stale cert/key so kubeadm regenerates them
    for path in ["/etc/kubernetes/pki/apiserver.crt", "/etc/kubernetes/pki/apiserver.key"]:
        if Path(path).exists():
            Path(path).unlink()
            log_info(f"Removed stale cert: {path}")

    # Regenerate with correct SANs
    result = run_cmd(
        [
            "kubeadm", "init", "phase", "certs", "apiserver",
            f"--apiserver-advertise-address={private_ip}",
            f"--apiserver-cert-extra-sans={extra_sans}",
        ],
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"kubeadm cert regeneration failed: {result.stderr.strip()}"
        )
    log_info("✓ API server certificate regenerated")


def _renew_apiserver_cert(private_ip: str, public_ip: str) -> None:
    """Regenerate API server cert AND restart the running container.

    Called on second-run when the API server is already running and
    the cert SANs don't include the current IP. Safe to call because
    static pod manifests already exist — kubelet will restart the pod.
    """
    _renew_apiserver_cert_files(private_ip, public_ip)

    # Force kube-apiserver static pod to reload the new cert
    log_info("Restarting kube-apiserver static pod to pick up new certificate...")
    run_cmd(
        ["bash", "-c",
         "crictl rm $(crictl ps --name kube-apiserver -q) 2>/dev/null || true"],
        check=False,
    )

    # Wait for the API server to come back up
    log_info("Waiting for API server to become healthy after cert renewal...")
    for i in range(1, 181):
        probe = run_cmd(
            ["kubectl", "get", "--raw", HEALTHZ_PATH],
            check=False, env=_bootstrap_kubeconfig_env(),
        )
        if probe.returncode == 0 and "ok" in probe.stdout.lower():
            log_info(f"✓ API server healthy after cert renewal (waited {i}s)")
            return
        time.sleep(1)

    raise RuntimeError(
        "API server did not become healthy within 180s after cert renewal. "
        "Check 'crictl ps' and 'journalctl -u kubelet' for details."
    )


# ── Bootstrap & Addon Guards ─────────────────────────────────────────────
# On DR restore, admin.conf is recovered from S3 but kubeadm init is
# skipped — critical resources are never created:
#   1. cluster-info ConfigMap (kube-public) — kubeadm join discovery
#   2. Bootstrap RBAC bindings — CSR creation & auto-approval
#   3. kube-proxy DaemonSet — ClusterIP routing
#   4. CoreDNS Deployment — DNS resolution
# These guards detect and repair all missing components.


def _patch_pod_subnet_in_kubeadm_config() -> None:
    """Patch podSubnet into the kubeadm-config ClusterConfiguration ConfigMap.

    kubeadm v1.35 removed --pod-network-cidr from ``kubeadm init``, so the
    pod CIDR is no longer stored in the ConfigMap automatically.  The Tigera
    operator reads ``networking.podSubnet`` from this ConfigMap to configure
    Calico IP pools — if it is absent the operator fails with:
        "kubeadm configuration is missing required podSubnet field"
    and calico-node never deploys.

    This function is idempotent: if podSubnet is already set to the correct
    value it is a no-op.  A missing or incorrect value is treated as fatal
    because Calico cannot recover without it.
    """
    result = run_cmd(
        ["kubectl", "get", "cm", "kubeadm-config", "-n", "kube-system",
         "-o", "jsonpath={.data.ClusterConfiguration}"],
        check=False, env=_bootstrap_kubeconfig_env(),
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Could not read kubeadm-config ConfigMap: {result.stderr.strip()}"
        )

    cfg = yaml.safe_load(result.stdout)
    current_subnet = cfg.get("networking", {}).get("podSubnet")
    if current_subnet == POD_CIDR:
        log_info(f"podSubnet already set to {POD_CIDR} — no patch needed")
        return

    cfg.setdefault("networking", {})["podSubnet"] = POD_CIDR
    patch_json = json.dumps({"data": {"ClusterConfiguration": yaml.dump(cfg, default_flow_style=False)}})

    patch_result = run_cmd(
        ["kubectl", "patch", "cm", "kubeadm-config", "-n", "kube-system",
         "--type", "merge", "-p", patch_json],
        check=False, env=_bootstrap_kubeconfig_env(),
    )
    if patch_result.returncode != 0:
        raise RuntimeError(
            f"Failed to patch podSubnet into kubeadm-config: "
            f"{patch_result.stderr.strip()}"
        )
    log_info(f"✓ podSubnet={POD_CIDR} patched into kubeadm-config ConfigMap")


def _ensure_bootstrap_token() -> None:
    """Verify bootstrap resources and restore any missing after DR.

    On a DR restore, ``kubeadm init`` is skipped because ``admin.conf`` was
    recovered from S3.  This means three categories of resources are missing:

    1. **cluster-info** ConfigMap (``kube-public``) — ``kubeadm join`` TLS
       discovery hangs without it.
    2. **kubeadm-config** ConfigMap (``kube-system``) — ``kubeadm join``
       preflight reads cluster configuration from it.
    3. **kubelet-config** ConfigMap (``kube-system``) — ``kubeadm join``
       downloads kubelet settings from it.
    4. **Bootstrap RBAC** bindings — CSR creation & auto-approval for new
       nodes (``kubeadm:kubelet-bootstrap``, ``kubeadm:node-autoapprove-*``).

    Uses idempotent ``kubeadm init phase`` subcommands — safe to call even
    when all resources already exist.
    """
    result = run_cmd(
        ["kubectl", "get", "configmap", "cluster-info", "-n", "kube-public"],
        check=False, env=_bootstrap_kubeconfig_env(),
    )
    if result.returncode == 0 and "cluster-info" in result.stdout:
        log_info("cluster-info ConfigMap already present — bootstrap-token phase OK")
        return

    log_warn(
        "cluster-info ConfigMap MISSING — restoring bootstrap resources"
    )

    # Phase 1: Upload kubeadm + kubelet config ConfigMaps to kube-system.
    # Without these, kubeadm join fails at preflight with RBAC errors
    # reading kubeadm-config and kubelet-config.
    # NOTE: --pod-network-cidr was removed in kubeadm v1.35.
    # The pod CIDR must now be injected into the kubeadm-config ConfigMap
    # *after* `upload-config` restores it, because Tigera operator reads
    # networking.podSubnet from the ConfigMap to resolve Calico IP pools.
    run_cmd([
        "kubeadm", "init", "phase", "upload-config", "kubeadm",
    ])
    log_info("✓ kubeadm-config ConfigMap restored")

    # Patch podSubnet into the ClusterConfiguration (kubeadm v1.35+).
    # Tigera operator fails with "kubeadm configuration is missing required
    # podSubnet field" if this is absent → calico-node never deploys.
    _patch_pod_subnet_in_kubeadm_config()

    run_cmd(["kubeadm", "init", "phase", "upload-config", "kubelet"])
    log_info("✓ kubelet-config ConfigMap restored")

    # Phase 2: Create bootstrap tokens, cluster-info ConfigMap, and RBAC.
    run_cmd(["kubeadm", "init", "phase", "bootstrap-token"])
    log_info(
        "✓ Bootstrap restoration complete — cluster-info, kubeadm-config, "
        "kubelet-config ConfigMaps and RBAC bindings created"
    )


def _ensure_kube_proxy() -> None:
    """Verify kube-proxy DaemonSet exists; re-deploy if missing.

    On a DR restore, admin.conf is recovered from the S3 backup but
    ``kubeadm init`` is skipped — kube-proxy never gets deployed.
    Without kube-proxy, ClusterIP routing (10.96.0.1) breaks and the
    entire cluster cascades into failure: CCM crash-loops, the
    ``uninitialized`` taint persists, and ``kubeadm join`` hangs.

    Uses ``kubeadm init phase addon kube-proxy`` which is idempotent —
    safe to call even if the DaemonSet already exists.
    """
    result = run_cmd(
        ["kubectl", "get", "daemonset", "kube-proxy", "-n", "kube-system"],
        check=False, env=_bootstrap_kubeconfig_env(),
    )
    if result.returncode == 0 and "kube-proxy" in result.stdout:
        log_info("kube-proxy DaemonSet already present — no action needed")
        return

    log_warn(
        "kube-proxy DaemonSet MISSING — deploying via "
        "kubeadm init phase addon kube-proxy"
    )

    private_ip = get_imds_value("local-ipv4")
    if not private_ip:
        raise RuntimeError(
            "Cannot deploy kube-proxy: failed to retrieve private IP from IMDS"
        )

    run_cmd([
        "kubeadm", "init", "phase", "addon", "kube-proxy",
        f"--apiserver-advertise-address={private_ip}",
        f"--pod-network-cidr={POD_CIDR}",
    ])
    log_info("✓ kube-proxy DaemonSet deployed")

    # Wait for at least one pod to reach Running
    for i in range(1, 61):
        result = run_cmd(
            ["kubectl", "get", "pods", "-n", "kube-system",
             "-l", "k8s-app=kube-proxy", "--no-headers"],
            check=False, env=_bootstrap_kubeconfig_env(),
        )
        if result.returncode == 0 and "Running" in result.stdout:
            log_info(f"kube-proxy pod running (waited {i}s)")
            return
        time.sleep(1)

    log_warn(
        "kube-proxy pod not Running after 60s — continuing "
        "(may self-heal once networking stabilises)"
    )


def _ensure_coredns() -> None:
    """Verify CoreDNS Deployment exists; re-deploy if missing.

    CoreDNS is deployed by ``kubeadm init`` alongside kube-proxy.
    On the second-run path (DR restore), both are missing.

    Uses ``kubeadm init phase addon coredns`` which is idempotent.
    """
    result = run_cmd(
        ["kubectl", "get", "deployment", "coredns", "-n", "kube-system"],
        check=False, env=_bootstrap_kubeconfig_env(),
    )
    if result.returncode == 0 and "coredns" in result.stdout:
        log_info("CoreDNS deployment already present — no action needed")
        return

    log_warn(
        "CoreDNS deployment MISSING — deploying via "
        "kubeadm init phase addon coredns"
    )
    run_cmd([
        "kubeadm", "init", "phase", "addon", "coredns",
        f"--service-cidr={SERVICE_CIDR}",
    ])
    log_info("✓ CoreDNS deployment deployed")


def _reconstruct_control_plane(private_ip: str, public_ip: str) -> None:
    """Reconstruct control plane infrastructure on a fresh root filesystem.

    After ASG replacement, the root filesystem is empty — only the EBS
    volume with etcd data survives, and the S3 DR restore has recovered
    ``/etc/kubernetes/pki/`` and ``admin.conf``.  However, the following
    are missing and must be recreated:

    - containerd is not running
    - kubelet has no configuration (``/etc/sysconfig/kubelet``)
    - ECR credential provider is not configured for kubelet
    - static pod manifests (``/etc/kubernetes/manifests/``) are empty
    - kubeconfigs for controller-manager/scheduler are absent
    - DNS A record still points to the old instance
    - **API server certificate** has old instance IPs in its SANs

    This function uses ``kubeadm init phase`` subcommands to regenerate
    manifests and kubeconfigs from existing PKI.  The apiserver certificate
    is **always regenerated** because its SANs contain instance-specific
    IPs that change on every ASG replacement.  Without this step the
    kubelet cannot verify the API server certificate and node registration
    fails.
    """
    log_info("=== Reconstructing control plane from restored PKI ===")

    # ── 1. Start containerd ─────────────────────────────────────────
    run_cmd(["systemctl", "start", "containerd"])
    log_info("containerd started")

    # ── 2. Configure ECR credential provider for kubelet ────────────
    ensure_ecr_credential_provider()

    # ── 3. Write kubelet args with new instance IP ──────────────────
    Path("/etc/sysconfig").mkdir(parents=True, exist_ok=True)
    Path("/etc/sysconfig/kubelet").write_text(
        "KUBELET_EXTRA_ARGS="
        "--cloud-provider=external"
        f" --node-ip={private_ip}"
        f" --image-credential-provider-config={ECR_PROVIDER_CONFIG}"
        " --image-credential-provider-bin-dir=/usr/local/bin\n"
    )
    log_info(f"Kubelet args configured: cloud-provider=external, node-ip={private_ip}")

    # ── 4. Update DNS → new private IP ──────────────────────────────
    _update_dns_record(private_ip)

    # ── 5. Regenerate kubeconfigs from existing PKI ─────────────────
    # These use the existing CA cert/key in /etc/kubernetes/pki/ and
    # do NOT regenerate any certificates.
    api_endpoint = f"{API_DNS_NAME}:6443"
    log_info("Regenerating kubeconfigs from existing PKI...")
    run_cmd([
        "kubeadm", "init", "phase", "kubeconfig", "all",
        f"--control-plane-endpoint={api_endpoint}",
    ])
    log_info("✓ Kubeconfigs regenerated (admin, kubelet, controller-manager, scheduler)")

    # ── 6. Generate kubelet configuration ───────────────────────────
    log_info("Generating kubelet configuration...")
    run_cmd([
        "kubeadm", "init", "phase", "kubelet-start",
        f"--node-name={run_cmd(['hostname', '-f'], check=False).stdout.strip()}",
    ], check=False)  # Non-fatal: kubelet may already be partially configured
    log_info("✓ Kubelet configuration generated")

    # ── 7. Renew API server certificate with current instance IPs ───
    # The restored cert contains the OLD instance's private/public IPs
    # as SANs.  The kubelet connects via the raw IP address (not DNS),
    # so TLS verification fails if the cert doesn't include the new IP.
    # This MUST happen before generating static pod manifests.
    cert_ips = _get_apiserver_cert_ips()
    if private_ip not in cert_ips:
        log_warn(
            f"API server cert SANs {cert_ips} do not include "
            f"current IP {private_ip} — regenerating certificate"
        )
        _renew_apiserver_cert_files(private_ip, public_ip)
    else:
        log_info(f"API server cert already includes {private_ip} — no renewal needed")

    # ── 8. Generate static pod manifests ────────────────────────────
    # These use existing certs and create the YAML manifests that
    # kubelet watches to start kube-apiserver, controller-manager,
    # and kube-scheduler as static pods.
    log_info("Generating control plane static pod manifests...")
    run_cmd([
        "kubeadm", "init", "phase", "control-plane", "all",
        f"--control-plane-endpoint={api_endpoint}",
        f"--kubernetes-version={K8S_VERSION}",
    ])
    log_info("✓ Control plane manifests generated (apiserver, controller-manager, scheduler)")

    # ── 9. Generate etcd static pod manifest ────────────────────────
    log_info("Generating etcd static pod manifest...")
    run_cmd([
        "kubeadm", "init", "phase", "etcd", "local",
    ])
    log_info("✓ etcd manifest generated")

    # ── 10. Start kubelet → static pods start automatically ─────────
    # Kubelet is enabled in the Golden AMI (systemctl enable kubelet)
    # but needs an explicit start since there was no kubeadm init to
    # trigger it.
    log_info("Starting kubelet service...")
    run_cmd(["systemctl", "restart", "kubelet"])

    # ── 11. Wait for API server to become healthy ───────────────────
    log_info("Waiting for API server to become healthy after kubelet start...")
    for i in range(1, 181):
        probe = run_cmd(
            ["kubectl", "get", "--raw", HEALTHZ_PATH],
            check=False, env=_bootstrap_kubeconfig_env(),
        )
        if probe.returncode == 0 and "ok" in probe.stdout.lower():
            log_info(f"✓ API server healthy (waited {i}s)")
            break
        time.sleep(1)
    else:
        raise RuntimeError(
            "API server did not become healthy within 180s after kubelet start. "
            "Check 'crictl ps' and 'journalctl -u kubelet' for details."
        )

    # ── 12. Copy kubeconfig for user access ─────────────────────────
    Path("/root/.kube").mkdir(parents=True, exist_ok=True)
    run_cmd(["cp", "-f", ADMIN_CONF, ROOT_KUBECONFIG])
    run_cmd(["chmod", "600", ROOT_KUBECONFIG])
    if Path(SUPER_ADMIN_CONF).exists():
        run_cmd(["cp", "-f", SUPER_ADMIN_CONF, ROOT_SUPER_ADMIN_KUBECONFIG])
        run_cmd(["chmod", "600", ROOT_SUPER_ADMIN_KUBECONFIG])

    log_info("=== Control plane reconstruction complete ===")


def _is_apiserver_running() -> bool:
    """Check if the kube-apiserver is currently responding to health probes.

    Returns ``True`` if the API server responds with 'ok' to ``/healthz``,
    ``False`` otherwise.  Used to determine whether the control plane
    needs full reconstruction (ASG replacement) or just maintenance
    (in-place restart).
    """
    probe = run_cmd(
        ["kubectl", "get", "--raw", HEALTHZ_PATH],
        check=False, env=_bootstrap_kubeconfig_env(),
    )
    return probe.returncode == 0 and "ok" in probe.stdout.lower()


def _handle_second_run() -> None:
    """Handle second-run: reconstruct control plane if needed, then maintain.

    Called when ``admin.conf`` already exists (i.e. the cluster was
    previously initialised).  This is the normal path after ASG
    replacement when DR restore recovers the control plane state.

    Two sub-scenarios:
    1. **ASG replacement** (API server NOT running) — the root filesystem
       is fresh, only PKI + admin.conf were restored from S3.  Must
       reconstruct static pod manifests, kubeconfigs, and kubelet config
       using ``kubeadm init phase`` commands before any kubectl will work.
    2. **In-place restart** (API server already running) — kubelet and
       control plane pods survived the restart.  Only DNS update and
       addon verification are needed.
    """
    log_info("Cluster already initialised — running second-run maintenance")

    private_ip = get_imds_value("local-ipv4")
    public_ip = get_imds_value("public-ipv4")
    instance_id = get_imds_value("instance-id")

    if not private_ip:
        raise RuntimeError("Failed to retrieve private IP from IMDS")

    # ── Determine if the control plane needs full reconstruction ────
    # On ASG replacement, the root filesystem is fresh — kubelet is
    # not running and there are no static pod manifests.  We detect
    # this by checking if the kube-apiserver manifests exist.
    manifests_dir = Path("/etc/kubernetes/manifests")
    apiserver_manifest = manifests_dir / "kube-apiserver.yaml"

    if not apiserver_manifest.exists():
        log_info(
            "Static pod manifests missing — ASG replacement detected. "
            "Reconstructing control plane from restored PKI..."
        )
        _reconstruct_control_plane(private_ip, public_ip or "")
    elif not _is_apiserver_running():
        log_info(
            "API server manifest exists but not responding — "
            "attempting reconstruction..."
        )
        _reconstruct_control_plane(private_ip, public_ip or "")
    else:
        log_info("API server already running — skipping reconstruction")
        # Still update DNS to point to current instance
        _update_dns_record(private_ip)

    # ── Safety net: verify apiserver cert SANs match current IP ─────
    # Even when reconstruction is skipped (API server was already running
    # from a partial kubeadm init), the cert may have stale IPs.  This
    # catches the edge case where kubeadm init failed AFTER generating
    # manifests but BEFORE the cert was regenerated with new SANs.
    cert_ips = _get_apiserver_cert_ips()
    if cert_ips and private_ip not in cert_ips:
        log_warn(
            f"API server cert SANs {cert_ips} do not include "
            f"current IP {private_ip} — renewing certificate"
        )
        _renew_apiserver_cert(private_ip, public_ip or "")

    # ── Post-reconstruction maintenance ─────────────────────────────
    api_endpoint = f"{API_DNS_NAME}:6443"
    log_info(f"Publishing DNS endpoint to SSM: {api_endpoint}")
    ssm_put(f"{SSM_PREFIX}/control-plane-endpoint", api_endpoint)

    # Set up kubeconfig for ssm-user
    result = run_cmd(["id", "ssm-user"], check=False)
    if result.returncode == 0:
        Path("/home/ssm-user/.kube").mkdir(parents=True, exist_ok=True)
        run_cmd(["cp", "-f", ADMIN_CONF, "/home/ssm-user/.kube/config"])
        run_cmd(["chown", "ssm-user:ssm-user", "/home/ssm-user/.kube/config"])
        run_cmd(["chmod", "600", "/home/ssm-user/.kube/config"])

    _publish_kubeconfig_to_ssm()

    # ── Ensure bootstrap infrastructure is present ──────────────────
    # On DR restore, kubeadm init is skipped because admin.conf was
    # recovered from S3.  This means the cluster-info ConfigMap,
    # bootstrap RBAC bindings, kube-proxy, and CoreDNS are never
    # created.  Without cluster-info, kubeadm join hangs during TLS
    # discovery.  Without kube-proxy, ClusterIP routing breaks and
    # the entire cluster cascades into failure.
    _ensure_bootstrap_token()
    _ensure_kube_proxy()
    _ensure_coredns()

    # ── Ensure RBAC bindings are intact ─────────────────────────────
    admin_result = run_cmd(
        ["kubectl", "get", "nodes"],
        check=False, env={"KUBECONFIG": ADMIN_CONF},
    )

    if admin_result.returncode != 0:
        output = (admin_result.stderr + admin_result.stdout).strip()
        if "Forbidden" in output:
            log_warn(
                "admin.conf got 403 Forbidden. RBAC binding "
                "'kubeadm:cluster-admins' is missing. Attempting repair..."
            )

            rbac_manifest = """
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubeadm:cluster-admins
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
- apiGroup: rbac.authorization.k8s.io
  kind: User
  name: kubernetes-admin
"""
            repair_result = run_cmd(
                ["kubectl", "apply", "-f", "-"],
                input=rbac_manifest.encode(),
                check=False, env=_bootstrap_kubeconfig_env(),
            )
            if repair_result.returncode != 0:
                raise RuntimeError(
                    f"Failed to repair RBAC binding: {repair_result.stderr}"
                )

            log_info("✓ RBAC binding kubeadm:cluster-admins repaired successfully")
        else:
            log_warn(f"admin.conf failed for a non-RBAC reason: {output}")

    # ── Publish SSM params and back up certs ────────────────────────
    _publish_ssm_params(private_ip, public_ip or "", instance_id or "")
    _backup_certificates()

    # ── Set providerID for AWS CCM ──────────────────────────────────
    patch_provider_id(kubeconfig=ROOT_KUBECONFIG)

    log_info("API server healthy — second-run maintenance complete")
    _label_control_plane_node()


def _init_cluster() -> None:
    """Initialize kubeadm cluster on first boot."""
    log_info(f"Initializing kubeadm cluster (v{K8S_VERSION})")

    Path(DATA_DIR).mkdir(parents=True, exist_ok=True)
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
    _update_dns_record(private_ip)

    # In case of DR restore from an old backup that didn't include admin.conf,
    # pki/ will exist but contain apiserver certs with the old instance IP.
    # We must remove them so kubeadm init regenerates them with the new IP.
    for path in ["/etc/kubernetes/pki/apiserver.crt", "/etc/kubernetes/pki/apiserver.key"]:
        if Path(path).exists():
            Path(path).unlink()
            log_info(f"Removed stale cert to ensure regeneration with new IP: {path}")

    api_endpoint = f"{API_DNS_NAME}:6443"
    init_cmd = [
        "kubeadm", "init",
        f"--kubernetes-version={K8S_VERSION}",
        f"--pod-network-cidr={POD_CIDR}",
        f"--service-cidr={SERVICE_CIDR}",
        f"--control-plane-endpoint={api_endpoint}",
        f"--apiserver-cert-extra-sans=127.0.0.1,{private_ip},{API_DNS_NAME}"
        + (f",{public_ip}" if public_ip else ""),
        "--upload-certs",
    ]
    run_cmd(init_cmd, capture=False, timeout=300)

    Path("/root/.kube").mkdir(parents=True, exist_ok=True)
    run_cmd(["cp", "-f", ADMIN_CONF, ROOT_KUBECONFIG])
    run_cmd(["chmod", "600", ROOT_KUBECONFIG])
    if Path(SUPER_ADMIN_CONF).exists():
        run_cmd(["cp", "-f", SUPER_ADMIN_CONF, ROOT_SUPER_ADMIN_KUBECONFIG])
        run_cmd(["chmod", "600", ROOT_SUPER_ADMIN_KUBECONFIG])

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
            check=False, env=_bootstrap_kubeconfig_env(),
        )
        if result.returncode == 0:
            log_info(f"Control plane is ready (waited {i} seconds)")
            break
        if i == 90:
            log_warn("Control plane did not become ready in 90s")
        time.sleep(1)

    log_info("Control plane taint preserved — only Traefik + system pods will run here")
    _label_control_plane_node()

    # Set providerID immediately so the AWS CCM can map this node
    # to its EC2 instance — required for auto-deletion of dead nodes.
    # Control plane uses admin kubeconfig (kubelet.conf not yet trusted).
    patch_provider_id(kubeconfig=ROOT_KUBECONFIG)

    _publish_ssm_params(private_ip, public_ip, instance_id)
    _publish_kubeconfig_to_ssm()
    _backup_certificates()


def _publish_ssm_params(private_ip: str, public_ip: str, instance_id: str) -> None:
    """Publish join token, CA hash, and endpoint to SSM."""
    log_info("Publishing cluster credentials to SSM...")

    token_result = run_cmd(
        ["kubeadm", "token", "create", "--ttl", "24h"],
        env=_bootstrap_kubeconfig_env(),
    )
    # Validate token format before writing to SSM — catches corruption at source
    join_token = validate_kubeadm_token(
        token_result.stdout.strip(), source="kubeadm token create"
    )
    log_info(f"Join token created and validated (length={len(join_token)})")

    ca_hash_cmd = (
        "openssl x509 -pubkey -in /etc/kubernetes/pki/ca.crt | "
        "openssl rsa -pubin -outform der 2>/dev/null | "
        "openssl dgst -sha256 -hex | awk '{print $2}'"
    )
    ca_result = run_cmd(ca_hash_cmd, shell=True)
    ca_hash = ca_result.stdout.strip()

    api_endpoint = f"{API_DNS_NAME}:6443"
    ssm_put(f"{SSM_PREFIX}/join-token", join_token, param_type="SecureString")
    ssm_put(f"{SSM_PREFIX}/ca-hash", f"sha256:{ca_hash}")
    ssm_put(f"{SSM_PREFIX}/control-plane-endpoint", api_endpoint)
    ssm_put(f"{SSM_PREFIX}/instance-id", instance_id)
    ssm_put(f"{SSM_PREFIX}/private-ip", private_ip)
    
    if public_ip:
        ssm_put(f"{SSM_PREFIX}/public-ip", public_ip)
    ssm_put(f"{SSM_PREFIX}/kubernetes-version", K8S_VERSION)
    # ami-id requires an IMDS call:
    ami_id = get_imds_value("ami-id")
    if ami_id:
        ssm_put(f"{SSM_PREFIX}/ami-id", ami_id)

    log_info("Cluster credentials published to SSM successfully")
    run_cmd(["kubectl", "get", "nodes", "-o", "wide"], check=False, env=_bootstrap_kubeconfig_env())


def _publish_kubeconfig_to_ssm() -> None:
    """Store a tunnel-ready kubeconfig in SSM for developer access.

    Reads /etc/kubernetes/admin.conf, rewrites the server address to
    https://127.0.0.1:6443 (for SSM port-forwarding tunnel), and stores
    the result as an SSM SecureString parameter. This enables developers
    to run `just k8s-fetch-kubeconfig` to restore cluster access after
    any control plane rebuild.
    """
    admin_conf = Path(ADMIN_CONF)
    if not admin_conf.exists():
        log_warn(f"{ADMIN_CONF} not found — skipping kubeconfig publish")
        return

    kubeconfig_content = admin_conf.read_text()

    # Rewrite the server address so the kubeconfig works through the SSM tunnel
    # Original: server: https://k8s-api.k8s.internal:6443 (or private IP)
    # Rewritten: server: https://127.0.0.1:6443
    tunnel_kubeconfig = re.sub(
        r"server:\s*https?://[^:]+:6443",
        "server: https://127.0.0.1:6443",
        kubeconfig_content,
    )

    ssm_path = f"{SSM_PREFIX}/kubeconfig"
    log_info(f"Publishing tunnel-ready kubeconfig to SSM: {ssm_path}")
    ssm_put(ssm_path, tunnel_kubeconfig, param_type="SecureString", tier="Advanced")

    # Publish the raw admin.conf as base64 for worker nodes.
    #
    # verify_membership.py on each worker fetches this parameter to obtain
    # a full-RBAC kubeconfig for label self-healing. The path is a
    # SecureString so the admin credentials are encrypted at rest.
    # Workers fall back to kubelet.conf (read-only) if this is absent, so
    # label correction silently fails — publishing here ensures the happy path.
    import base64  # noqa: PLC0415 — local import keeps module-level imports clean
    admin_kc_b64 = base64.b64encode(kubeconfig_content.encode()).decode()
    kc_b64_path = f"{SSM_PREFIX}/admin-kubeconfig-b64"
    log_info(f"Publishing admin kubeconfig (base64) to SSM: {kc_b64_path}")
    ssm_put(kc_b64_path, admin_kc_b64, param_type="SecureString", tier="Advanced")


def _backup_certificates() -> None:
    """Archive /etc/kubernetes/pki/ to S3 for disaster recovery.

    Called after kubeadm init and on certificate renewal. The archive
    preserves the cluster's CA identity — without it, recovering from
    a lost EBS volume requires all workers to rejoin with new certs.

    S3 path: s3://<bucket>/dr-backups/pki/<timestamp>.tar.gz
    """
    if not S3_BUCKET:
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
        
        paths_to_tar = ["pki"]
        if Path("/etc/kubernetes/admin.conf").exists():
            paths_to_tar.append("admin.conf")
        if Path("/etc/kubernetes/super-admin.conf").exists():
            paths_to_tar.append("super-admin.conf")
            
        run_cmd(["tar", "czf", archive_path, "-C", "/etc/kubernetes"] + paths_to_tar)

        s3_key = f"{DR_BACKUP_PREFIX}/pki/{timestamp}.tar.gz"
        run_cmd([
            "aws", "s3", "cp", archive_path,
            f"s3://{S3_BUCKET}/{s3_key}",
            "--sse", "AES256", "--region", AWS_REGION,
        ])

        # Maintain a 'latest' pointer for easy restore
        run_cmd([
            "aws", "s3", "cp", archive_path,
            f"s3://{S3_BUCKET}/{DR_BACKUP_PREFIX}/pki/latest.tar.gz",
            "--sse", "AES256", "--region", AWS_REGION,
        ])

        log_info(f"✓ PKI certificates backed up to s3://{S3_BUCKET}/{s3_key}")
    except Exception as err:
        log_error(f"Certificate backup failed: {err}")
        log_warn("Continuing bootstrap — backup failure is non-fatal")
    finally:
        if Path(archive_path).exists():
            os.remove(archive_path)


# =============================================================================
# Step 2 — Restore from S3 Backup (Disaster Recovery)
# =============================================================================

def _s3_object_exists(s3_path: str) -> bool:
    """Check if an S3 object exists without downloading it."""
    result = run_cmd(
        ["aws", "s3", "ls", s3_path, "--region", AWS_REGION],
        check=False,
    )
    return result.returncode == 0 and bool(result.stdout.strip())


def _restore_certificates() -> bool:
    """Download and extract PKI certificates from S3.

    Returns True if certificates were restored successfully.
    """
    s3_path = f"s3://{S3_BUCKET}/{DR_BACKUP_PREFIX}/pki/latest.tar.gz"
    if not _s3_object_exists(s3_path):
        log_warn("No PKI backup found in S3 — fresh init will generate new certs")
        return False

    archive_path = "/tmp/k8s-pki-restore.tar.gz"
    try:
        log_info(f"Downloading PKI backup from {s3_path}...")
        run_cmd([
            "aws", "s3", "cp", s3_path, archive_path,
            "--region", AWS_REGION,
        ])

        pki_dir = Path("/etc/kubernetes/pki")
        pki_dir.mkdir(parents=True, exist_ok=True)
        run_cmd(["tar", "xzf", archive_path, "-C", "/etc/kubernetes"])

        log_info("✓ PKI certificates restored from S3 backup")
        return True
    except Exception as err:
        log_error(f"Certificate restore failed: {err}")
        return False
    finally:
        if Path(archive_path).exists():
            os.remove(archive_path)


def _restore_etcd_snapshot() -> bool:
    """Download and prepare etcd snapshot for kubeadm init.

    Restores the etcd data directory so kubeadm init finds existing
    etcd data and preserves all Kubernetes objects.

    Returns True if etcd was restored successfully.
    """
    s3_path = f"s3://{S3_BUCKET}/{DR_BACKUP_PREFIX}/etcd/latest.db"
    if not _s3_object_exists(s3_path):
        log_warn("No etcd backup found in S3 — fresh init will start empty")
        return False

    snapshot_path = "/tmp/etcd-restore.db"
    etcd_data_dir = f"{DATA_DIR}/etcd"

    try:
        log_info(f"Downloading etcd snapshot from {s3_path}...")
        run_cmd([
            "aws", "s3", "cp", s3_path, snapshot_path,
            "--region", AWS_REGION,
        ])

        # Resolve etcdctl — prefer binary, fall back to container
        etcdctl = shutil.which("etcdctl")
        if not etcdctl:
            log_warn("etcdctl not found on PATH — attempting restore via container")
            # etcdctl may be available after kubeadm images are pulled
            etcdctl = "etcdctl"

        log_info(f"Restoring etcd snapshot to {etcd_data_dir}...")
        env = {"ETCDCTL_API": "3"}
        run_cmd([
            etcdctl, "snapshot", "restore", snapshot_path,
            "--data-dir", etcd_data_dir,
            "--skip-hash-check",
        ], env=env)

        log_info(f"✓ etcd snapshot restored to {etcd_data_dir}")
        return True
    except Exception as err:
        log_error(f"etcd restore failed: {err}")
        # Clean up partial restore so kubeadm init starts fresh
        if Path(etcd_data_dir).exists():
            shutil.rmtree(etcd_data_dir, ignore_errors=True)
        return False
    finally:
        if Path(snapshot_path).exists():
            os.remove(snapshot_path)


def step_restore_from_backup() -> None:
    """Step 2: Restore etcd + certificates from S3 if EBS is empty.

    This step enables Scenario B disaster recovery:
    - If admin.conf exists (EBS has data) → skip (normal self-healing)
    - If admin.conf missing AND S3 backups exist → restore before init
    - If admin.conf missing AND no S3 backups → skip (fresh init)

    Must run BEFORE step_init_kubeadm so that kubeadm init finds
    the restored certificates and etcd data.
    """
    with StepRunner("restore-backup", skip_if=DR_RESTORE_MARKER) as step:
        if step.skipped:
            return

        # If admin.conf exists, the EBS volume has data — no restore needed
        if Path(ADMIN_CONF).exists():
            log_info("admin.conf exists — EBS volume has data, skipping DR restore")
            step.details["action"] = "skipped_ebs_has_data"
            return

        if not S3_BUCKET:
            log_warn("S3_BUCKET not set — cannot check for backups")
            step.details["action"] = "skipped_no_bucket"
            return

        log_info("EBS volume appears empty — checking S3 for DR backups...")

        # Restore certificates first (required for etcd restore)
        certs_restored = _restore_certificates()
        step.details["certs_restored"] = certs_restored

        # Restore etcd snapshot
        etcd_restored = _restore_etcd_snapshot()
        step.details["etcd_restored"] = etcd_restored

        if certs_restored or etcd_restored:
            log_info(
                "DR restore complete — kubeadm init will use restored data\n"
                f"  Certificates: {'✓ restored' if certs_restored else '✗ not found'}\n"
                f"  etcd data:    {'✓ restored' if etcd_restored else '✗ not found'}"
            )
            step.details["action"] = "restored"
        else:
            log_info("No S3 backups found — kubeadm init will start fresh")
            step.details["action"] = "fresh_init"


def step_init_kubeadm() -> None:
    """Step 3: Initialize kubeadm control plane."""
    with StepRunner("init-kubeadm", skip_if=ADMIN_CONF) as step:
        if step.skipped:
            _handle_second_run()
            return

        _init_cluster()
        step.details["k8s_version"] = K8S_VERSION
        step.details["pod_cidr"] = POD_CIDR
        step.details["service_cidr"] = SERVICE_CIDR


# =============================================================================
# Step 4 — Install Calico CNI
# =============================================================================

CACHED_OPERATOR = "/opt/calico/tigera-operator.yaml"

CALICO_INSTALLATION = f"""apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  calicoNetwork:
    bgp: Disabled
    ipPools:
      - cidr: {POD_CIDR}
        encapsulation: VXLAN
        natOutgoing: Enabled
        nodeSelector: all()
    linuxDataplane: Iptables
"""


def step_install_calico() -> None:
    """Step 4: Install Calico CNI via Tigera operator."""
    with StepRunner("install-calico", skip_if=CALICO_MARKER) as step:
        if step.skipped:
            return

        # Install operator
        if Path(CACHED_OPERATOR).exists():
            log_info("Using pre-cached operator from Golden AMI")
            source = CACHED_OPERATOR
        else:
            log_warn("Pre-cached operator not found, downloading from GitHub")
            source = (
                f"https://raw.githubusercontent.com/projectcalico/calico/"
                f"{CALICO_VERSION}/manifests/tigera-operator.yaml"
            )

        run_cmd(
            ["kubectl", "apply", "--server-side", "--force-conflicts", "-f", source],
            env=_bootstrap_kubeconfig_env(),
        )

        # The tigera-operator uses the kubernetes ClusterIP (10.96.0.1) by default
        # to reach the API server. On a fresh node the pod network doesn't exist yet,
        # so that address is unreachable — the operator loops on i/o timeout and never
        # reconciles the Installation CR. Providing this ConfigMap tells the operator
        # to use the node IP directly, bypassing the ClusterIP entirely.
        private_ip = get_imds_value("local-ipv4")
        if private_ip:
            log_info(
                f"Creating kubernetes-services-endpoint ConfigMap "
                f"(operator → {private_ip}:6443)"
            )
            endpoint_cm = f"""apiVersion: v1
kind: ConfigMap
metadata:
  name: kubernetes-services-endpoint
  namespace: tigera-operator
data:
  KUBERNETES_SERVICE_HOST: "{private_ip}"
  KUBERNETES_SERVICE_PORT: "6443"
"""
            run_cmd(
                ["kubectl", "apply", "-f", "-"],
                input=endpoint_cm.encode(),
                env=_bootstrap_kubeconfig_env(),
            )
        else:
            log_warn(
                "Could not retrieve private IP from IMDS — "
                "skipping kubernetes-services-endpoint ConfigMap. "
                "Calico operator may fail to reach the API server."
            )

        log_info("Waiting for Calico operator deployment...")
        run_cmd(
            ["kubectl", "wait", "--for=condition=Available",
             "deployment/tigera-operator", "-n", "tigera-operator",
             "--timeout=120s"],
            check=False, env=_bootstrap_kubeconfig_env(),
        )

        # Apply Installation CR
        log_info("Applying Calico Installation resource...")
        run_cmd(
            f"echo '{CALICO_INSTALLATION}' | kubectl apply -f -",
            shell=True, env=_bootstrap_kubeconfig_env(),
        )

        # Wait for pods
        log_info("Waiting for Calico pods to become ready...")
        for i in range(1, 121):
            result = run_cmd(
                ["kubectl", "get", "pods", "-n", "calico-system", "--no-headers"],
                check=False, env=_bootstrap_kubeconfig_env(),
            )
            if result.returncode == 0 and result.stdout.strip():
                lines = result.stdout.strip().splitlines()
                total = len(lines)
                running = sum(1 for line in lines if "Running" in line)
                if total > 0 and running == total:
                    log_info(f"Calico pods ready ({running}/{total}, waited {i}s)")
                    break
                if i == 120:
                    log_warn(f"Calico pods not fully ready after 120s ({running}/{total})")
                    run_cmd(
                        ["kubectl", "get", "pods", "-n", "calico-system"],
                        check=False, env=_bootstrap_kubeconfig_env(),
                    )
            time.sleep(1)

        step.details["calico_version"] = CALICO_VERSION
        step.details["pod_cidr"] = POD_CIDR
        log_info("Calico CNI installed successfully")


# =============================================================================
# Step 4b — Install AWS Cloud Controller Manager
# =============================================================================

CCM_HELM_REPO = "https://kubernetes.github.io/cloud-provider-aws"
CCM_HELM_RELEASE = "aws-cloud-controller-manager"
CCM_HELM_CHART = "aws-cloud-controller-manager"
CCM_HELM_NAMESPACE = "kube-system"
CCM_TAINT_TIMEOUT_SECONDS = 120

# Helm values mirroring the ArgoCD Application manifest
# (kubernetes-app/platform/argocd-apps/aws-cloud-controller-manager.yaml)
CCM_HELM_VALUES = """\
args:
  - --v=2
  - --cloud-provider=aws
  - --configure-cloud-routes=false
nodeSelector:
  node-role.kubernetes.io/control-plane: ""
tolerations:
  - key: node-role.kubernetes.io/control-plane
    effect: NoSchedule
  - key: node-role.kubernetes.io/master
    effect: NoSchedule
  - key: node.cloudprovider.kubernetes.io/uninitialized
    value: "true"
    effect: NoSchedule
  - key: node.kubernetes.io/not-ready
    effect: NoSchedule
  - key: node.kubernetes.io/not-ready
    effect: NoExecute
  - key: node.kubernetes.io/unreachable
    effect: NoExecute
hostNetworking: true
"""


def step_install_ccm() -> None:
    """Step 4b: Install AWS Cloud Controller Manager via Helm.

    The CCM removes the 'node.cloudprovider.kubernetes.io/uninitialized'
    taint from nodes, which is required before any pods (including ArgoCD
    and CoreDNS) can be scheduled.

    Installing the CCM here — after Calico networking is ready but before
    ArgoCD bootstrap — breaks the otherwise circular dependency:
      - Kubelet starts with --cloud-provider=external → nodes are tainted
      - CCM removes the taint → pods can schedule
      - ArgoCD can start → remaining platform apps deploy

    ArgoCD will adopt the Helm release on subsequent syncs via the
    aws-cloud-controller-manager Application (sync-wave 2, selfHeal: true).

    Idempotent: skips if the marker file already exists.
    """
    with StepRunner("install-ccm", skip_if=CCM_MARKER) as step:
        if step.skipped:
            return

        # Write Helm values to a temporary file
        values_path = Path("/tmp/ccm-values.yaml")
        values_path.write_text(CCM_HELM_VALUES)

        try:
            # Add the Helm repo
            log_info("Adding cloud-provider-aws Helm repo...")
            run_cmd(
                ["helm", "repo", "add", "aws-cloud-controller-manager",
                 CCM_HELM_REPO, "--force-update"],
                env=_bootstrap_kubeconfig_env(),
            )
            run_cmd(["helm", "repo", "update"], env=_bootstrap_kubeconfig_env())

            # Install (or upgrade if already present) the CCM
            log_info("Installing AWS Cloud Controller Manager...")
            run_cmd(
                ["helm", "upgrade", "--install",
                 CCM_HELM_RELEASE, f"aws-cloud-controller-manager/{CCM_HELM_CHART}",
                 "--namespace", CCM_HELM_NAMESPACE,
                 "--values", str(values_path),
                 "--wait", "--timeout", "120s"],
                env=_bootstrap_kubeconfig_env(),
            )
            log_info("✓ AWS CCM Helm release installed")

            # Wait for the 'uninitialized' taint to be removed
            log_info("Waiting for CCM to remove the 'uninitialized' taint...")
            taint_removed = False
            for i in range(1, CCM_TAINT_TIMEOUT_SECONDS + 1):
                result = run_cmd(
                    ["kubectl", "get", "nodes", "-o",
                     "jsonpath={.items[*].spec.taints}"],
                    check=False, env=_bootstrap_kubeconfig_env(),
                )
                if result.returncode == 0:
                    taints_json = result.stdout.strip()
                    if "node.cloudprovider.kubernetes.io/uninitialized" not in taints_json:
                        log_info(
                            f"✓ 'uninitialized' taint removed from all nodes "
                            f"(waited {i}s)"
                        )
                        taint_removed = True
                        break
                time.sleep(1)

            if not taint_removed:
                log_warn(
                    f"'uninitialized' taint still present after "
                    f"{CCM_TAINT_TIMEOUT_SECONDS}s — ArgoCD may fail to schedule. "
                    f"Check CCM pod logs: kubectl logs -n kube-system "
                    f"-l app.kubernetes.io/name=aws-cloud-controller-manager"
                )
                # Raise so StepRunner does NOT write the marker — forces retry
                raise RuntimeError(
                    "CCM installed but taint not removed — step will retry on next run"
                )

            step.details["helm_release"] = CCM_HELM_RELEASE
            step.details["taint_removed"] = taint_removed
            log_info("AWS Cloud Controller Manager installed successfully")

        finally:
            # Clean up temporary values file
            if values_path.exists():
                values_path.unlink()


# =============================================================================
# Step 5 — Configure kubectl Access
# =============================================================================

KUBECTL_USERS = [
    {"name": "root", "home": "/root"},
    {"name": "ec2-user", "home": "/home/ec2-user"},
]

SSM_KUBECONFIG_SCRIPT = """\
#!/bin/bash
# One-shot: copy kubeconfig for ssm-user on first SSM session
if [ "$(whoami)" = "ssm-user" ] && [ ! -f "$HOME/.kube/config" ]; then
    mkdir -p "$HOME/.kube"
    sudo cp -f /etc/kubernetes/admin.conf "$HOME/.kube/config"
    sudo chown "$(id -u):$(id -g)" "$HOME/.kube/config"
    chmod 600 "$HOME/.kube/config"
fi
"""

BASHRC_KUBECONFIG = """
# --- Kubernetes kubeconfig (added by bootstrap) ---
export KUBECONFIG=/etc/kubernetes/admin.conf
"""


def step_configure_kubectl() -> None:
    """Step 5: Set up kubectl access for root, ec2-user, and ssm-user."""
    with StepRunner("configure-kubectl") as step:
        if step.skipped:
            return

        log_info("Configuring kubectl access...")

        for user in KUBECTL_USERS:
            kube_dir = Path(user["home"]) / ".kube"
            kube_dir.mkdir(parents=True, exist_ok=True)
            config_path = kube_dir / "config"
            run_cmd(["cp", "-f", ADMIN_CONF, str(config_path)])
            if user["name"] != "root":
                run_cmd(["chown", f"{user['name']}:{user['name']}", str(config_path)])
            run_cmd(["chmod", "600", str(config_path)])
            log_info(f"  ✓ kubeconfig for {user['name']}")

        # ssm-user
        result = run_cmd(["id", "ssm-user"], check=False)
        if result.returncode != 0:
            log_info("  ssm-user does not exist — creating it now")
            run_cmd(["useradd", "--system", "--shell", "/bin/bash",
                     "--create-home", "--home-dir", "/home/ssm-user",
                     "ssm-user"], check=False)

        ssm_kube_dir = Path("/home/ssm-user/.kube")
        ssm_kube_dir.mkdir(parents=True, exist_ok=True)
        ssm_config = ssm_kube_dir / "config"
        run_cmd(["cp", "-f", ADMIN_CONF, str(ssm_config)])
        run_cmd(["chown", "ssm-user:ssm-user", str(ssm_config)])
        run_cmd(["chmod", "600", str(ssm_config)])
        log_info("  ✓ kubeconfig for ssm-user")

        script_path = Path("/usr/local/bin/setup-ssm-kubeconfig.sh")
        script_path.write_text(SSM_KUBECONFIG_SCRIPT)
        run_cmd(["chmod", "755", str(script_path)])

        bashrc = Path("/etc/bashrc")
        if bashrc.exists():
            content = bashrc.read_text()
            if "setup-ssm-kubeconfig" not in content:
                with bashrc.open("a") as f:
                    f.write(
                        '[ -x /usr/local/bin/setup-ssm-kubeconfig.sh ] '
                        '&& /usr/local/bin/setup-ssm-kubeconfig.sh\n'
                    )

        # Global kubeconfig
        profile_d = Path("/etc/profile.d/kubernetes.sh")
        profile_d.write_text(f"export KUBECONFIG={ADMIN_CONF}\n")
        run_cmd(["chmod", "644", str(profile_d)])

        if bashrc.exists():
            content = bashrc.read_text()
            if "KUBECONFIG=" not in content:
                with bashrc.open("a") as f:
                    f.write(BASHRC_KUBECONFIG)
        log_info("  ✓ Global KUBECONFIG configured (profile.d + bashrc)")

        os.environ["KUBECONFIG"] = ADMIN_CONF
        run_cmd(["kubectl", "cluster-info"], check=False)
        run_cmd(["kubectl", "get", "namespaces"], check=False)
        log_info("kubectl access configured successfully")


# =============================================================================
# Step 6 — Sync Bootstrap Manifests from S3
# =============================================================================

S3_MAX_RETRIES = 15
S3_RETRY_INTERVAL = 20


def step_sync_manifests() -> None:
    """Step 6: Download bootstrap manifests from S3 with patient retry."""
    with StepRunner("sync-manifests") as step:
        if step.skipped:
            return

        if not S3_BUCKET:
            raise RuntimeError("S3_BUCKET environment variable is required")

        bootstrap_dir = Path(MOUNT_POINT) / "k8s-bootstrap"
        bootstrap_dir.mkdir(parents=True, exist_ok=True)
        s3_prefix = f"s3://{S3_BUCKET}/k8s-bootstrap/"

        found = False
        for attempt in range(1, S3_MAX_RETRIES + 1):
            ls_result = run_cmd(
                ["aws", "s3", "ls", s3_prefix, "--recursive",
                 "--region", AWS_REGION],
                check=False,
            )

            if ls_result.returncode == 0 and ls_result.stdout.strip():
                obj_count = len(ls_result.stdout.strip().splitlines())
                log_info(
                    f"✓ Found {obj_count} objects in S3 bootstrap "
                    f"(attempt {attempt}/{S3_MAX_RETRIES})"
                )

                run_cmd(
                    ["aws", "s3", "sync", s3_prefix, str(bootstrap_dir) + "/",
                     "--region", AWS_REGION],
                )

                for sh_file in bootstrap_dir.rglob("*.sh"):
                    sh_file.chmod(0o755)
                for py_file in bootstrap_dir.rglob("*.py"):
                    py_file.chmod(0o755)

                log_info(f"Bootstrap bundle downloaded: {bootstrap_dir}")
                found = True
                break

            log_info(
                f"No manifests in S3 yet "
                f"(attempt {attempt}/{S3_MAX_RETRIES}). "
                f"Retrying in {S3_RETRY_INTERVAL}s..."
            )
            time.sleep(S3_RETRY_INTERVAL)

        if not found:
            log_warn(
                f"No manifests found in S3 after "
                f"{S3_MAX_RETRIES * S3_RETRY_INTERVAL}s. "
                f"ArgoCD bootstrap will be skipped — run manually when "
                f"S3 content is available."
            )

        step.details["manifests_found"] = found
        step.details["s3_bucket"] = S3_BUCKET
        step.details["bootstrap_dir"] = str(bootstrap_dir)


# =============================================================================
# Step 7 — Bootstrap ArgoCD
# =============================================================================

def _argocd_already_healthy(min_running: int = 5) -> bool:
    """Return True if at least ``min_running`` ArgoCD pods are already Running.

    Used as a fast idempotency guard in :func:`step_bootstrap_argocd` to
    skip the heavyweight bootstrap shell script when ArgoCD is already
    operational.  Five is the baseline pod count for a stock ArgoCD install
    (server, repo-server, application-controller, dex-server, redis).

    Args:
        min_running: Minimum number of Running pods required. Defaults to 5.

    Returns:
        ``True`` if the ArgoCD namespace has at least ``min_running`` Running
        pods, ``False`` otherwise.
    """
    result = run_cmd(
        [
            "kubectl", "get", "pods", "-n", "argocd",
            "--field-selector=status.phase=Running",
            "--no-headers",
        ],
        check=False,
        env=_bootstrap_kubeconfig_env(),
    )
    if result.returncode != 0 or not result.stdout.strip():
        return False
    running = len(result.stdout.strip().splitlines())
    log_info(f"ArgoCD health check: {running} Running pods (threshold: {min_running})")
    return running >= min_running


def step_bootstrap_argocd() -> None:
    """Step 7: Install ArgoCD and apply App-of-Apps root application.

    Skips the bootstrap script entirely when ArgoCD is already healthy
    (>= 5 Running pods).  This prevents unnecessary pod restarts on
    day-2 automation runs, which would otherwise cause a 3-5 minute
    traffic gap while images are pulled on rescheduled pods.
    """
    with StepRunner("bootstrap-argocd") as step:
        if step.skipped:
            return

        # ── Idempotency guard: skip re-install if already healthy ───────────
        if _argocd_already_healthy():
            log_info(
                "[SKIP] ArgoCD is already healthy — skipping re-install "
                "to prevent unnecessary pod restarts and traffic disruption."
            )
            step.details["argocd_skipped"] = True
            step.details["reason"] = "already_healthy"
            return

        bootstrap_dir = Path(MOUNT_POINT) / "k8s-bootstrap"
        argocd_dir = bootstrap_dir / "system" / "argocd"
        bootstrap_script = argocd_dir / "bootstrap-argocd.sh"

        if not bootstrap_script.exists():
            log_warn(
                f"ArgoCD bootstrap script not found at {bootstrap_script}. "
                f"Manifests may not have been synced from S3 yet."
            )
            raise FileNotFoundError(f"Missing: {bootstrap_script}")

        env = {
            "KUBECONFIG": ADMIN_CONF,
            "ARGOCD_DIR": str(argocd_dir),
        }

        log_info(f"Executing ArgoCD bootstrap: {bootstrap_script}")
        run_cmd(
            [str(bootstrap_script)],
            env=env,
            capture=False,
            timeout=1800,
        )

        log_info(
            "ArgoCD bootstrap complete. "
            "ArgoCD now manages: traefik, metrics-server, "
            "aws-ebs-csi-driver, monitoring, nextjs"
        )
        step.details["argocd_dir"] = str(argocd_dir)


# =============================================================================
# Step 8 — Verify Cluster
# =============================================================================

REQUIRED_NAMESPACES = [
    "kube-system",
    "calico-system",
    "tigera-operator",
]


def step_verify_cluster() -> None:
    """Step 8: Lightweight post-boot health checks."""
    with StepRunner("verify-cluster") as step:
        if step.skipped:
            return

        results = {}

        # Node readiness
        log_info("Checking node readiness...")
        result = run_cmd(
            ["kubectl", "get", "nodes", "--no-headers"],
            check=False, env=_bootstrap_kubeconfig_env(),
        )
        node_ready = False
        if result.returncode == 0:
            for line in result.stdout.strip().splitlines():
                if "Ready" in line and "NotReady" not in line:
                    log_info(f"  ✓ Node ready: {line.split()[0]}")
                    node_ready = True
                    break
        if not node_ready:
            log_error("Node is not in Ready state")
        results["node_ready"] = node_ready

        # Core namespaces
        log_info("Checking namespace pods...")
        for ns in REQUIRED_NAMESPACES:
            result = run_cmd(
                ["kubectl", "get", "pods", "-n", ns, "--no-headers"],
                check=False, env=_bootstrap_kubeconfig_env(),
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

        # ArgoCD
        log_info("Checking ArgoCD...")
        result = run_cmd(
            ["kubectl", "get", "pods", "-n", "argocd", "--no-headers"],
            check=False, env=_bootstrap_kubeconfig_env(),
        )
        if result.returncode != 0 or not result.stdout.strip():
            log_warn("  ⚠ ArgoCD namespace not found or empty (may not be bootstrapped yet)")
            results["argocd"] = True
        else:
            lines = result.stdout.strip().splitlines()
            total = len(lines)
            running = sum(1 for line in lines if "Running" in line)
            log_info(f"  ✓ argocd: {running}/{total} pods running")
            results["argocd"] = running > 0

        step.details = results
        failures = [k for k, v in results.items() if not v]
        if failures:
            log_warn(f"Verification completed with warnings: {failures}")
        else:
            log_info("✓ All post-boot checks passed")


# =============================================================================
# Step 9 — Install CloudWatch Agent
# =============================================================================

# Step 9 — Install CloudWatch Agent
# Imported from common: step_install_cloudwatch_agent()


# =============================================================================
# Step 10 — Install etcd Backup Timer
# =============================================================================

DR_TIMER_MARKER = "/etc/systemd/system/etcd-backup.timer"


def step_install_etcd_backup() -> None:
    """Step 10: Set up hourly etcd backup to S3 via systemd timer.

    Installs the etcd-backup.sh script and creates a systemd timer
    that runs hourly. The initial backup runs immediately after
    installation.

    Idempotent: skips if the timer unit file already exists.
    """
    with StepRunner("install-etcd-backup", skip_if=DR_TIMER_MARKER) as step:
        if step.skipped:
            return

        # The DR scripts are synced from S3 as part of the bootstrap bundle
        bootstrap_dir = Path(MOUNT_POINT) / "k8s-bootstrap"
        installer = bootstrap_dir / "system" / "dr" / "install-etcd-backup-timer.sh"

        if not installer.exists():
            log_warn(
                f"etcd backup installer not found at {installer}. "
                f"DR scripts may not have been synced from S3 yet."
            )
            step.details["installed"] = False
            return

        log_info(f"Installing etcd backup timer: {installer}")
        run_cmd([str(installer)], capture=False, timeout=120)

        step.details["installed"] = True
        step.details["timer_unit"] = DR_TIMER_MARKER
        log_info("✓ etcd backup timer installed")


# =============================================================================
# Step 11 — Install Token Rotator Timer
# =============================================================================

TOKEN_ROTATOR_MARKER = "/etc/systemd/system/kubeadm-token-rotator.timer"

TOKEN_ROTATOR_SCRIPT = """\
#!/bin/bash
set -euo pipefail

# Generate a new token valid for 24 hours
export KUBECONFIG=/etc/kubernetes/admin.conf
TOKEN=$(kubeadm token create --ttl 24h)

# Validate token format before writing to SSM
if ! echo "$TOKEN" | grep -qE '^[a-z0-9]{{6}}\.[a-z0-9]{{16}}$'; then
    echo "ERROR: kubeadm token create returned invalid token: $TOKEN" >&2
    exit 1
fi

# Push the token to SSM
aws ssm put-parameter \\
    --name "{SSM_PREFIX}/join-token" \\
    --value "$TOKEN" \\
    --type "SecureString" \\
    --overwrite \\
    --region "{AWS_REGION}"

echo "Successfully rotated join token and updated SSM."
"""


def step_install_token_rotator() -> None:
    """Step 11: Install a systemd timer to rotate the kubeadm join token.

    Generates a new token every 12 hours and pushes it to SSM,
    ensuring workers can always join the cluster.
    """
    with StepRunner("install-token-rotator", skip_if=TOKEN_ROTATOR_MARKER) as step:
        if step.skipped:
            return

        script_path = Path("/usr/local/bin/rotate-join-token.sh")
        script_content = TOKEN_ROTATOR_SCRIPT.format(
            SSM_PREFIX=SSM_PREFIX,
            AWS_REGION=AWS_REGION,
        )
        script_path.write_text(script_content)
        run_cmd(["chmod", "755", str(script_path)])

        service_path = Path("/etc/systemd/system/kubeadm-token-rotator.service")
        service_path.write_text(
            "[Unit]\n"
            "Description=Rotate kubeadm join token and update SSM\n"
            "After=network-online.target\n\n"
            "[Service]\n"
            "Type=oneshot\n"
            "ExecStart=/usr/local/bin/rotate-join-token.sh\n"
        )

        timer_path = Path(TOKEN_ROTATOR_MARKER)
        timer_path.write_text(
            "[Unit]\n"
            "Description=Run kubeadm token rotator every 12 hours\n\n"
            "[Timer]\n"
            "OnBootSec=1h\n"
            "OnUnitActiveSec=12h\n"
            "RandomizedDelaySec=5m\n\n"
            "[Install]\n"
            "WantedBy=timers.target\n"
        )

        run_cmd(["systemctl", "daemon-reload"])
        run_cmd(["systemctl", "enable", "--now", "kubeadm-token-rotator.timer"])

        step.details["installed"] = True
        log_info("✓ kubeadm token rotator timer installed")


# =============================================================================
# Main — Sequential Control Plane Bootstrap
# =============================================================================

def main() -> None:
    """Execute all control plane bootstrap steps in order."""
    steps = [
        step_validate_ami,
        step_restore_from_backup,
        step_init_kubeadm,
        step_install_calico,
        step_install_ccm,
        step_configure_kubectl,
        step_sync_manifests,
        step_bootstrap_argocd,
        step_verify_cluster,
        step_install_cloudwatch_agent,
        step_install_etcd_backup,
        step_install_token_rotator,
    ]

    log_info(f"Control plane bootstrap starting ({len(steps)} steps)")
    for i, step_fn in enumerate(steps, 1):
        log_info(f"\n{'='*60}")
        log_info(f"Step {i}/{len(steps)}: {step_fn.__name__}")
        log_info(f"{'='*60}")
        step_fn()

    log_info("Control plane bootstrap complete")


if __name__ == "__main__":
    main()
