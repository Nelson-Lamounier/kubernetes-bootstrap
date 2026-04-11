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
    validate_kubeadm_token,
)
from boot_helpers.config import BootConfig

# ── Constants ──────────────────────────────────────────────────────────────

ADMIN_CONF = "/etc/kubernetes/admin.conf"
KUBECONFIG_ENV = {"KUBECONFIG": ADMIN_CONF}
DR_BACKUP_PREFIX = "dr-backups"


# ── Helpers ────────────────────────────────────────────────────────────────

def label_control_plane_node(cfg: BootConfig) -> None:
    """Apply pool, workload, and environment labels to the control plane node.

    Labels applied:
    - ``node-pool=control-plane``  — pool identity for the pool-aware verify
      check and to prevent the Cluster Autoscaler from ever targeting the CP.
    - ``workload=control-plane``   — kept for backward compatibility during
      the K8s-native worker migration; remove once legacy stacks are gone.
    - ``environment=<env>``        — deployment environment tag.
    """
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
        "node-pool": "control-plane",   # pool identity — CA exclusion gate
        "workload": "control-plane",    # legacy — remove post-migration
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

    # First-boot token is permanent (--ttl 0) so ASG worker nodes that launch
    # days or weeks later can still join. The on-control-plane token rotator
    # (kubeadm-token-rotator.timer) creates 24h rolling tokens every 12 hours,
    # replacing this permanently once the CP is running. If the rotator has not
    # fired yet and a worker joins hours after init, this token is still valid.
    token_result = run_cmd(
        ["kubeadm", "token", "create", "--ttl", "0"],
        env=KUBECONFIG_ENV,
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
        
        paths_to_tar = ["pki"]
        if Path("/etc/kubernetes/admin.conf").exists():
            paths_to_tar.append("admin.conf")
        if Path("/etc/kubernetes/super-admin.conf").exists():
            paths_to_tar.append("super-admin.conf")
            
        run_cmd(["tar", "czf", archive_path, "-C", "/etc/kubernetes"] + paths_to_tar)

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


# ── Bootstrap & Addon Guards ─────────────────────────────────────────────
# On DR restore, admin.conf is recovered from S3 but kubeadm init is
# skipped — critical resources are never created:
#   1. cluster-info ConfigMap (kube-public) — kubeadm join discovery
#   2. Bootstrap RBAC bindings — CSR creation & auto-approval
#   3. kube-proxy DaemonSet — ClusterIP routing
#   4. CoreDNS Deployment — DNS resolution
# These guards detect and repair all missing components.


def ensure_bootstrap_token() -> None:
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
        check=False, env=KUBECONFIG_ENV,
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
    run_cmd(["kubeadm", "init", "phase", "upload-config", "kubeadm"])
    log_info("✓ kubeadm-config ConfigMap restored")

    run_cmd(["kubeadm", "init", "phase", "upload-config", "kubelet"])
    log_info("✓ kubelet-config ConfigMap restored")

    # Phase 2: Create bootstrap tokens, cluster-info ConfigMap, and RBAC.
    run_cmd(["kubeadm", "init", "phase", "bootstrap-token"])
    log_info(
        "✓ Bootstrap restoration complete — cluster-info, kubeadm-config, "
        "kubelet-config ConfigMaps and RBAC bindings created"
    )


def ensure_kube_proxy(cfg: BootConfig) -> None:
    """Verify kube-proxy DaemonSet exists; re-deploy if missing.

    On a DR restore, admin.conf is recovered from the S3 backup but
    ``kubeadm init`` is skipped — kube-proxy never gets deployed.
    Without kube-proxy, ClusterIP routing (10.96.0.1) breaks and the
    entire cluster cascades into failure: CCM crash-loops, the
    ``uninitialized`` taint persists, and ``kubeadm join`` hangs.

    Uses ``kubeadm init phase addon kube-proxy`` which is idempotent —
    safe to call even if the DaemonSet already exists.

    Args:
        cfg: Bootstrap configuration.
    """
    result = run_cmd(
        ["kubectl", "get", "daemonset", "kube-proxy", "-n", "kube-system"],
        check=False, env=KUBECONFIG_ENV,
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
        f"--pod-network-cidr={cfg.pod_cidr}",
    ])
    log_info("✓ kube-proxy DaemonSet deployed")

    # Wait for at least one pod to reach Running
    for i in range(1, 61):
        result = run_cmd(
            ["kubectl", "get", "pods", "-n", "kube-system",
             "-l", "k8s-app=kube-proxy", "--no-headers"],
            check=False, env=KUBECONFIG_ENV,
        )
        if result.returncode == 0 and "Running" in result.stdout:
            log_info(f"kube-proxy pod running (waited {i}s)")
            return
        time.sleep(1)

    log_warn(
        "kube-proxy pod not Running after 60s — continuing "
        "(may self-heal once networking stabilises)"
    )


def ensure_coredns(cfg: BootConfig) -> None:
    """Verify CoreDNS Deployment exists; re-deploy if missing.

    CoreDNS is deployed by ``kubeadm init`` alongside kube-proxy.
    On the second-run path (DR restore), both are missing.

    Uses ``kubeadm init phase addon coredns`` which is idempotent.

    Args:
        cfg: Bootstrap configuration.
    """
    result = run_cmd(
        ["kubectl", "get", "deployment", "coredns", "-n", "kube-system"],
        check=False, env=KUBECONFIG_ENV,
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
        f"--service-cidr={cfg.service_cidr}",
    ])
    log_info("✓ CoreDNS deployment deployed")


# ── Constants ──────────────────────────────────────────────────────────────

HEALTHZ_PATH = "/healthz"
SUPER_ADMIN_CONF = "/etc/kubernetes/super-admin.conf"
ROOT_KUBECONFIG = "/root/.kube/config"
ROOT_SUPER_ADMIN_KUBECONFIG = "/root/.kube/super-admin.conf"
APISERVER_MANIFEST = "/etc/kubernetes/manifests/kube-apiserver.yaml"


def patch_apiserver_resources() -> None:
    """Inject a memory request into the kube-apiserver static pod manifest.

    ``kubeadm init`` generates the manifest without any resource requests,
    meaning the scheduler treats the API server as having zero cost and may
    allow other pods to co-locate until the node runs out of memory.

    Observed usage from ``kubectl top``: ~1193 Mi peak. We set a conservative
    request of 512 Mi (a safe floor, not the peak) so the scheduler reserves
    appropriate headroom. The kubelet will hot-reload the manifest within ~10s
    of the file being written — no pod restart is required.

    This is idempotent: if the ``resources`` block already exists the function
    skips patching to avoid churn on second-run maintenance paths.

    Raises:
        RuntimeError: If the manifest file does not exist.
    """
    manifest_path = Path(APISERVER_MANIFEST)
    if not manifest_path.exists():
        log_warn(
            f"kube-apiserver manifest not found at {APISERVER_MANIFEST} — "
            "skipping resource patch (will retry on next boot)"
        )
        return

    content = manifest_path.read_text()

    # Idempotency guard — skip if a resources block is already present.
    if "resources:" in content:
        log_info("kube-apiserver manifest already has resource requests — skipping patch")
        return

    # Locate the container spec and inject resources after the image line.
    # The kubeadm-generated manifest has a predictable structure:
    #   containers:
    #   - command: [...]
    #     image: registry.k8s.io/kube-apiserver:v1.x.y
    #     ...
    resources_block = (
        "        resources:\n"
        "          requests:\n"
        "            cpu: 250m\n"
        "            memory: 512Mi\n"
    )

    import re as _re
    # Insert the resources block immediately after the image: line inside
    # the kube-apiserver container. The image line is unique in the manifest.
    patched = _re.sub(
        r"(\s+image:\s+[^\n]+kube-apiserver[^\n]+\n)",
        r"\1" + resources_block,
        content,
        count=1,
    )

    if patched == content:
        log_warn(
            "kube-apiserver memory request patch: image line not found — "
            "manifest structure may have changed. Skipping."
        )
        return

    manifest_path.write_text(patched)
    log_info(
        "✓ kube-apiserver static pod manifest patched with "
        "resource requests (cpu=250m, memory=512Mi)"
    )


def _bootstrap_kubeconfig_env() -> dict[str, str]:
    """Return the KUBECONFIG env dict for bootstrap operations.

    Prefers super-admin.conf (full cluster access, bypasses RBAC) when
    available, falling back to admin.conf otherwise.
    """
    if Path(SUPER_ADMIN_CONF).exists():
        return {"KUBECONFIG": SUPER_ADMIN_CONF}
    return KUBECONFIG_ENV


def reconstruct_control_plane(cfg: BootConfig, private_ip: str, public_ip: str) -> None:
    """Reconstruct control plane infrastructure on a fresh root filesystem.

    After ASG replacement, the root filesystem is empty — only the EBS
    volume with etcd data survives, and the S3 DR restore has recovered
    ``/etc/kubernetes/pki/`` and ``admin.conf``.  This function uses
    ``kubeadm init phase`` subcommands to regenerate manifests and
    kubeconfigs **from existing PKI** — zero certificates are regenerated.
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
    update_dns_record(private_ip, cfg)

    # ── 5. Regenerate kubeconfigs from existing PKI ─────────────────
    api_endpoint = f"{cfg.api_dns_name}:6443"
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
    ], check=False)
    log_info("✓ Kubelet configuration generated")

    # ── 7. Generate static pod manifests ────────────────────────────
    log_info("Generating control plane static pod manifests...")
    run_cmd([
        "kubeadm", "init", "phase", "control-plane", "all",
        f"--control-plane-endpoint={api_endpoint}",
        f"--kubernetes-version={cfg.k8s_version}",
    ])
    log_info("✓ Control plane manifests generated (apiserver, controller-manager, scheduler)")

    # Patch kube-apiserver manifest with resource requests after regeneration.
    patch_apiserver_resources()

    # ── 8. Generate etcd static pod manifest ────────────────────────
    log_info("Generating etcd static pod manifest...")
    run_cmd(["kubeadm", "init", "phase", "etcd", "local"])
    log_info("✓ etcd manifest generated")

    # ── 9. Start kubelet → static pods start automatically ──────────
    log_info("Starting kubelet service...")
    run_cmd(["systemctl", "restart", "kubelet"])

    # ── 10. Wait for API server to become healthy ───────────────────
    log_info("Waiting for API server to become healthy...")
    for i in range(1, 91):
        probe = run_cmd(
            ["kubectl", "get", "--raw", HEALTHZ_PATH],
            check=False, env=_bootstrap_kubeconfig_env(),
        )
        if probe.returncode == 0 and "ok" in probe.stdout.lower():
            log_info(f"✓ API server healthy (waited {i}s)")
            break
        if i == 90:
            log_warn(
                "API server did not become healthy in 90s. "
                "Check 'crictl ps' and 'journalctl -u kubelet' for details."
            )
        time.sleep(1)

    # ── 11. Copy kubeconfig for user access ─────────────────────────
    Path("/root/.kube").mkdir(parents=True, exist_ok=True)
    run_cmd(["cp", "-f", ADMIN_CONF, ROOT_KUBECONFIG])
    run_cmd(["chmod", "600", ROOT_KUBECONFIG])
    if Path(SUPER_ADMIN_CONF).exists():
        run_cmd(["cp", "-f", SUPER_ADMIN_CONF, ROOT_SUPER_ADMIN_KUBECONFIG])
        run_cmd(["chmod", "600", ROOT_SUPER_ADMIN_KUBECONFIG])

    log_info("=== Control plane reconstruction complete ===")


def is_apiserver_running() -> bool:
    """Check if the kube-apiserver is currently responding to health probes."""
    probe = run_cmd(
        ["kubectl", "get", "--raw", HEALTHZ_PATH],
        check=False, env=_bootstrap_kubeconfig_env(),
    )
    return probe.returncode == 0 and "ok" in probe.stdout.lower()


def handle_second_run(cfg: BootConfig) -> None:
    """Handle second-run: reconstruct control plane if needed, then maintain.

    Called when ``admin.conf`` already exists (i.e. the cluster was
    previously initialised).  This is the normal path after ASG
    replacement when DR restore recovers the control plane state.

    Two sub-scenarios:
    1. **ASG replacement** (API server NOT running) — must reconstruct
       static pod manifests, kubeconfigs, and kubelet config using
       ``kubeadm init phase`` commands.
    2. **In-place restart** (API server already running) — only DNS
       update and addon verification are needed.
    """
    log_info("Cluster already initialised — running second-run maintenance")

    private_ip = get_imds_value("local-ipv4")
    public_ip = get_imds_value("public-ipv4")

    if not private_ip:
        raise RuntimeError("Failed to retrieve private IP from IMDS")

    # ── Determine if the control plane needs full reconstruction ────
    manifests_dir = Path("/etc/kubernetes/manifests")
    apiserver_manifest = manifests_dir / "kube-apiserver.yaml"

    if not apiserver_manifest.exists():
        log_info(
            "Static pod manifests missing — ASG replacement detected. "
            "Reconstructing control plane from restored PKI..."
        )
        reconstruct_control_plane(cfg, private_ip, public_ip or "")
    elif not is_apiserver_running():
        log_info(
            "API server manifest exists but not responding — "
            "attempting reconstruction..."
        )
        reconstruct_control_plane(cfg, private_ip, public_ip or "")
    else:
        log_info("API server already running — skipping reconstruction")
        update_dns_record(private_ip, cfg)

    # ── Post-reconstruction maintenance ─────────────────────────────
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

    # ── Ensure bootstrap infrastructure is present ──────────────────
    ensure_bootstrap_token()
    ensure_kube_proxy(cfg)
    ensure_coredns(cfg)

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

    # ── Set providerID for AWS CCM ──────────────────────────────────
    patch_provider_id(kubeconfig=ROOT_KUBECONFIG)

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

    # In case of DR restore from an old backup that didn't include admin.conf,
    # pki/ will exist but contain apiserver certs with the old instance IP.
    # We must remove them so kubeadm init regenerates them with the new IP.
    for path in ["/etc/kubernetes/pki/apiserver.crt", "/etc/kubernetes/pki/apiserver.key"]:
        if Path(path).exists():
            Path(path).unlink()
            log_info(f"Removed stale cert to ensure regeneration with new IP: {path}")

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

    # Patch kube-apiserver manifest with resource requests so the scheduler
    # can correctly account for the ~1 Gi memory footprint of the API server.
    # Must run after kubeadm init has written the manifest.
    patch_apiserver_resources()

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
