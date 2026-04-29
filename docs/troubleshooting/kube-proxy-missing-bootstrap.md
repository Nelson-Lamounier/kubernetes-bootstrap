---
title: Fix Missing kube-proxy on Bootstrap
type: troubleshooting
tags: [kube-proxy, kubeadm, bootstrap, kubernetes, ebs-csi]
sources:
  - sm-a/boot/steps/control_plane.ts
created: 2026-04-28
updated: 2026-04-28
---

# Fix Missing kube-proxy on Second-Run Bootstrap

## Problem

After the AWS EBS CSI Driver migration, the data volume is now **ephemeral** (`deleteOnTermination: true`). When ASG replaces the control plane instance:

1. A fresh EBS is attached and an etcd snapshot + PKI certs are restored from S3 (DR flow)
2. `kubeadm init` runs, deploying all addons including `kube-proxy` ✓
3. The `StepRunner` writes marker files (`.calico-installed`, `.ccm-installed`) to `/etc/kubernetes/`

However, there's a **critical gap**: if the S3 restore successfully recovers `/etc/kubernetes/admin.conf` *before* `kubeadm init` runs, then `step_init_kubeadm()` sees `admin.conf` already exists and enters the **second-run path** (`handle_second_run()`), which:

- ✅ Updates DNS
- ✅ Publishes kubeconfig to SSM
- ✅ Checks IP mismatch / cert renewal (in `control_plane.py` version)
- ❌ **Does NOT verify kube-proxy is running**
- ❌ **Does NOT verify CoreDNS is running**
- ❌ **Does NOT verify the CCM DaemonSet exists**

Without `kube-proxy`, ClusterIP routing (`10.96.0.1:443`) fails → CCM can't reach the API server → the `uninitialized` taint stays → no pods schedule → `kubeadm join` hangs.

### Secondary Gap: Marker File Race on DR Restore

The marker files for Calico (`.calico-installed`) and CCM (`.ccm-installed`) live under `/etc/kubernetes/`. When the DR restore extracts the PKI archive, it restores the `pki/` *subdirectory* only — marker files aren't in the backup. **But** the `skip_if` for Calico and CCM will evaluate to `false` (markers gone), so those steps will re-install correctly.

The **real problem** is `kube-proxy` — it has no marker file. It's deployed *inside* `kubeadm init` which gets **entirely skipped** on the second-run path.

## Solution

### Addon Guard Functions

Two idempotent guard functions were added to the second-run bootstrap path:

| Function | Addon | Detection | Recovery Command |
|----------|-------|-----------|------------------|
| `ensure_kube_proxy(cfg)` | kube-proxy DaemonSet | `kubectl get daemonset kube-proxy -n kube-system` | `kubeadm init phase addon kube-proxy` |
| `ensure_coredns(cfg)` | CoreDNS Deployment | `kubectl get deployment coredns -n kube-system` | `kubeadm init phase addon coredns` |

Both use `kubeadm init phase addon`, which is a **kubeadm official command** designed to be idempotent — it recreates the resource only if missing. There is no risk of disrupting an already-running addon.

### `ensure_kube_proxy` Implementation

```python
def ensure_kube_proxy(cfg: BootConfig) -> None:
    """Verify kube-proxy DaemonSet exists; re-deploy if missing.

    On a DR restore, admin.conf is recovered from the S3 backup but
    kubeadm init is skipped — kube-proxy never gets deployed. Without
    kube-proxy, ClusterIP routing breaks and the entire cluster fails.
    """
    result = run_cmd(
        ["kubectl", "get", "daemonset", "kube-proxy", "-n", "kube-system"],
        check=False, env=KUBECONFIG_ENV,
    )
    if result.returncode == 0 and "kube-proxy" in result.stdout:
        log_info("kube-proxy DaemonSet already present — no action needed")
        return

    log_warn("kube-proxy DaemonSet MISSING — deploying via kubeadm phase addon")

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
    log_info("✓ kube-proxy deployed")

    # Wait for at least one pod to be Running
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

    log_warn("kube-proxy pod not Running after 60s — continuing (may self-heal)")
```

### `ensure_coredns` Implementation

```python
def ensure_coredns(cfg: BootConfig) -> None:
    """Verify CoreDNS Deployment exists; re-deploy if missing."""
    result = run_cmd(
        ["kubectl", "get", "deployment", "coredns", "-n", "kube-system"],
        check=False, env=KUBECONFIG_ENV,
    )
    if result.returncode == 0 and "coredns" in result.stdout:
        log_info("CoreDNS deployment already present — no action needed")
        return

    log_warn("CoreDNS deployment MISSING — deploying via kubeadm phase addon")
    run_cmd([
        "kubeadm", "init", "phase", "addon", "coredns",
        f"--service-cidr={cfg.service_cidr}",
    ])
    log_info("✓ CoreDNS deployed")
```

### Integration into `handle_second_run()`

```diff
 def handle_second_run(cfg: BootConfig) -> None:
     """Handle second-run: update DNS and refresh kubeconfig."""
     log_info("Cluster already initialised — running second-run maintenance")
     ...
     publish_kubeconfig_to_ssm(cfg)
 
+    # ── Ensure critical addons are present ─────────────────────────
+    # On DR restore, kubeadm init is skipped because admin.conf was
+    # recovered from S3.  This means kube-proxy and CoreDNS are never
+    # deployed.  Without kube-proxy, ClusterIP routing breaks and the
+    # entire cluster cascades into failure.
+    ensure_kube_proxy(cfg)
+    ensure_coredns(cfg)
+
     result = run_cmd(
         ["kubectl", "get", "nodes"],
         check=False, env=KUBECONFIG_ENV,
```

## Files Modified

| File | Change |
|------|--------|
| `kubernetes-app/k8s-bootstrap/boot/steps/cp/kubeadm_init.py` | Added `ensure_kube_proxy()`, `ensure_coredns()`, integrated into `handle_second_run()` |
| `kubernetes-app/k8s-bootstrap/boot/steps/control_plane.py` | Matching `_ensure_kube_proxy()`, `_ensure_coredns()` in the monolithic file |
| `kubernetes-app/k8s-bootstrap/tests/boot/test_kubeadm_init.py` | **New** — 6 test cases covering both guards and the integration |

## Tests

| Test | Class | Verifies |
|------|-------|----------|
| `test_skips_when_daemonset_already_present` | `TestEnsureKubeProxy` | Short-circuits when kube-proxy exists |
| `test_deploys_when_daemonset_missing` | `TestEnsureKubeProxy` | Calls `kubeadm init phase addon kube-proxy` with correct args |
| `test_raises_when_imds_fails` | `TestEnsureKubeProxy` | RuntimeError when private IP unavailable |
| `test_skips_when_deployment_already_present` | `TestEnsureCoreDNS` | Short-circuits when CoreDNS exists |
| `test_deploys_when_deployment_missing` | `TestEnsureCoreDNS` | Calls `kubeadm init phase addon coredns` with correct args |
| `test_calls_ensure_guards_during_second_run` | `TestHandleSecondRunGuards` | Both guards invoked from `handle_second_run()` |

All tests use mocked `run_cmd` — no live AWS or system calls.

```bash
cd kubernetes-app/k8s-bootstrap
python -m pytest tests/boot/test_kubeadm_init.py -v
```

## Manual Recovery

For a cluster already affected by this issue, run on the control plane node:

```bash
# 1. Deploy kube-proxy
kubeadm init phase addon kube-proxy \
  --apiserver-advertise-address=$(curl -s http://169.254.169.254/latest/meta-data/local-ipv4) \
  --pod-network-cidr=192.168.0.0/16

# 2. Deploy CoreDNS
kubeadm init phase addon coredns --service-cidr=10.96.0.0/12

# 3. Wait for kube-proxy to start
kubectl -n kube-system get pods -l k8s-app=kube-proxy -w

# 4. Restart CCM to trigger taint removal
kubectl -n kube-system rollout restart daemonset aws-cloud-controller-manager

# 5. Verify taint removed
kubectl get nodes -o jsonpath='{.items[*].spec.taints}'
```

## Verification

1. After deploying the code fix, trigger an ASG replacement of the control plane
2. Monitor CloudWatch logs for the `ensure_kube_proxy` and `ensure_coredns` log lines
3. Verify worker nodes successfully join with `kubectl get nodes -o wide`
