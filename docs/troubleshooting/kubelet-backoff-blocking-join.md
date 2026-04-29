---
title: Kubelet Crash-Loop Backoff Blocking kubeadm Join on Worker Node
type: troubleshooting
tags: [kubernetes, kubeadm, kubelet, worker-node, bootstrap, systemd]
sources:
  - sm-a/boot/steps/worker.ts
created: 2026-04-29
updated: 2026-04-29
---

# Kubelet Crash-Loop Backoff Blocking kubeadm Join on Worker Node

## Symptom

`kubeadm join` fails or hangs intermittently on the first attempt on a freshly launched worker node. The join succeeds on the second or third retry. The kubelet journal shows rapid restart cycles:

```
kubelet.service: Start request repeated too quickly.
kubelet.service: Failed with result 'exit-code'.
Failed to start kubelet.service: Too many jobs.
```

Or the join completes but kubelet never starts afterwards:

```
[ERROR] kubelet did not become active in 60s
```

## Root cause

The kubelet systemd unit is enabled in the Golden AMI (`systemctl enable kubelet` is run during AMI bake). When a worker EC2 instance boots, `kubelet.service` activates immediately — but there is no `/var/lib/kubelet/config.yaml` yet, because `kubeadm join` has not run. Kubelet exits with a config error, systemd restarts it after the configured backoff interval (~10s), and the cycle repeats.

After several crash loops, systemd enters restart back-off. When `kubeadm join` then tries to start kubelet as part of TLS bootstrap, the unit may already be in back-off, causing kubeadm's lifecycle management to race with systemd's restart throttle.

Source: `sm-a/boot/steps/worker.ts` lines 778–786 — commit `45ebf5c` (`fix(worker): stop kubelet before each kubeadm join attempt`):

```
// kubelet is a systemd-enabled unit baked into the AMI. Before kubeadm
// join writes /var/lib/kubelet/config.yaml the unit crash-loops every
// ~10s and racks up a high restart counter. The crash loop interferes
// with kubeadm join's TLS bootstrap (kubeadm starts kubelet but the
// unit may already be in restart back-off). Stop it cleanly so kubeadm
// owns the lifecycle for the duration of the join.
```

## How to diagnose

```bash
# 1. Check current kubelet state
systemctl is-active kubelet
# Expected before join: inactive or failed (not active)
# If active without /var/lib/kubelet/config.yaml → crash-looping

# 2. Check restart counter
systemctl show kubelet --property=NRestarts,ActiveState,SubState

# 3. Confirm config file is absent (expected before join)
ls /var/lib/kubelet/config.yaml 2>/dev/null || echo "config absent — pre-join state"

# 4. Check recent kubelet logs
journalctl -u kubelet --no-pager -n 20

# 5. Check for systemd back-off in the journal
journalctl -u kubelet --no-pager | grep -i "too many\|back-off\|repeated"
```

## How to fix

### Automated fix (runs before each join attempt)

The `doJoin()` function in `sm-a/boot/steps/worker.ts` (lines 784–785) stops and resets kubelet before every join attempt:

```typescript
run(['systemctl', 'stop', 'kubelet'], { check: false });
run(['systemctl', 'reset-failed', 'kubelet'], { check: false });
```

`reset-failed` clears the restart counter so kubeadm starts kubelet in a clean state. This runs before each of the 5 retry attempts, so the fix applies even on retries after an expired token.

### Manual fix before a manual kubeadm join

```bash
# Stop kubelet and clear restart backoff
systemctl stop kubelet
systemctl reset-failed kubelet

# Verify state is clean
systemctl show kubelet --property=NRestarts,ActiveState
# Expected: NRestarts=0, ActiveState=inactive

# Now run kubeadm join
kubeadm join k8s-api.k8s.internal:6443 \
  --token <token> \
  --discovery-token-ca-cert-hash <hash>

# After join, kubelet starts automatically via kubeadm
systemctl is-active kubelet
# Expected: active
```

### Verify join completed successfully

```bash
# On the worker node, kubelet.conf is written by kubeadm join on success
ls /etc/kubernetes/kubelet.conf

# kubelet config is written after a successful join
ls /var/lib/kubelet/config.yaml

# On the control plane, the worker should appear
kubectl get nodes | grep <worker-hostname>
```

## How to prevent

The `doJoin()` retry loop in `worker.ts` applies `systemctl stop` + `systemctl reset-failed` before every join attempt. No additional configuration is required.

If manually running `kubeadm join` outside the bootstrap script, always prepend the two `systemctl` commands above. Running `kubeadm join` without stopping kubelet first is safe on a first boot (kubelet will have accumulated fewer restarts) but unreliable after a failed first attempt where restart back-off has built up.

## Related

- [kubeadm Control Plane Init — OS-Level Runbook](../runbooks/kubeadm-control-plane-init.md) — worker step 2 join sequence, CA mismatch detection
- [Kubernetes Bootstrap Orchestrator](../projects/kubernetes-bootstrap-orchestrator.md) — worker bootstrap 6-step sequence, retry loop design

<!--
Evidence trail (auto-generated):
- Source: sm-a/boot/steps/worker.ts (read 2026-04-28, 1221 lines — doJoin() lines 778-786, comment text verbatim)
- Commit: 45ebf5c fix(worker): stop kubelet before each kubeadm join attempt — root cause description in commit body
- Generated: 2026-04-29
-->
