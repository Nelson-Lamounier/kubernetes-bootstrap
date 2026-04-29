---
title: Calico Stuck Pending on DR Restore or Second-Run Bootstrap
type: troubleshooting
tags: [kubernetes, calico, dr-restore, bootstrap, kubeadm, tigera-operator]
sources:
  - sm-a/boot/steps/control_plane.ts
created: 2026-04-29
updated: 2026-04-29
---

# Calico Stuck Pending on DR Restore or Second-Run Bootstrap

## Symptom

After a DR restore or instance replacement the `calico-system` namespace shows pods stuck in `Pending`, `Terminating`, or `ContainerCreating` phase for the full 6-minute wait window, causing the `install-calico` bootstrap step to time out.

```
calico-node-xxxxx                          0/1     Pending             0          4m
calico-kube-controllers-xxxxx              0/1     Terminating         0          4m
calico-typha-xxxxx                         0/1     ContainerCreating   0          4m
```

The `install-calico` step terminates with a timeout error and the bootstrap fails at step 4. The cluster node never reaches `Ready` state because CNI is not providing a network interface.

## Root cause

There are three distinct root causes that produce the same symptom. They can occur independently or in combination on the same DR restore run. Identify which layer applies before applying a fix.

### Root cause A — stale etcd pods stuck Terminating

The etcd snapshot restored from S3 contains the previous instance's Calico state — `calico-node` pods bound to the old node name and IPs. These pods get stuck `Terminating` after restoration, blocking the Tigera operator from scheduling new pods on the replacement node.

**Distinguishing indicator:** `kubectl get pods -n calico-system` shows pods with `NOMINATED NODE` pointing to a hostname that no longer matches `kubectl get nodes`.

Source: `sm-a/boot/steps/control_plane.ts` — commit `6565000` (`fix(cp): force-clean stale calico-system on second-run before reinstall`).

### Root cause B — tigera-operator not reconciling after Installation CR deletion

After force-deleting the `Installation` CR and killing stale `calico-system` pods, the `tigera-operator` pod itself was still `Available` from its previous incarnation. Deleting the Installation CR does not reset the operator's internal reconciliation state, so a freshly-applied CR is acknowledged but no pods are scheduled — `calico-system` stays empty indefinitely.

**Distinguishing indicator:** `kubectl get installation default` returns no output (CR deleted), but `kubectl get pods -n calico-system` is empty, and `kubectl logs -n tigera-operator deployment/tigera-operator` shows no reconciliation activity on the new CR.

Source: `sm-a/boot/steps/control_plane.ts` — commit `e795f20` (`fix(cp): restart tigera-operator after cleanup so it reconciles new Installation CR`).

### Root cause C — kubeadm-config ConfigMap missing podSubnet

The etcd snapshot restores a `kubeadm-config` ConfigMap in `kube-system` with an incomplete `ClusterConfiguration` — the `podSubnet` field is absent. Tigera's IPPool controller cross-validates `Installation.spec.calicoNetwork.ipPools[].cidr` against `kubeadm-config`. When `podSubnet` is missing it enters a degraded state and never schedules `calico-system` pods.

**Distinguishing indicator:** `kubectl logs -n calico-system -l app.kubernetes.io/name=calico-kube-controllers` contains:

```
error filling IP pool defaults
Could not resolve CalicoNetwork IPPool and kubeadm configuration:
kubeadm configuration is missing required podSubnet field
```

Source: `sm-a/boot/steps/control_plane.ts` — commit `726f653` (`fix(cp): re-upload kubeadm-config with podSubnet on second-run`).

### Root cause D — wrong readiness gate (wait condition too broad)

Waiting for "all pods in `calico-system` Running" creates a circular dependency: `calico-kube-controllers` is `Pending` until the node is `Ready`, but the node is only `Ready` once `calico-node` is `Ready`. The correct gate is the `calico-node` DaemonSet alone.

**Distinguishing indicator:** `calico-node` DaemonSet shows `numberReady == desiredNumberScheduled` but the step is still waiting because `calico-kube-controllers` is `Pending`.

Source: `sm-a/boot/steps/control_plane.ts` — commit `6a485f7` (`fix(cp): gate Calico install on calico-node DaemonSet Ready, not all pods Running`).

## How to diagnose

Run these commands in order on the control plane. Each result points to a specific root cause above.

```bash
# 1. Check calico-system pod states
kubectl get pods -n calico-system -o wide
# Stale Terminating pods → Root cause A
# No pods at all despite CR applied → Root cause B or C

# 2. Check Installation CR exists
kubectl get installation default
# No output → CR was deleted; check operator is reconciling

# 3. Check tigera-operator logs for IPPool error
kubectl logs -n tigera-operator deployment/tigera-operator --tail=50 | grep -i "error\|ippool\|podSubnet"
# "missing required podSubnet field" → Root cause C

# 4. Check kubeadm-config for podSubnet
kubectl get configmap kubeadm-config -n kube-system -o jsonpath='{.data.ClusterConfiguration}' | grep podSubnet
# Empty result → Root cause C confirmed

# 5. Check DaemonSet-only readiness (skip kube-controllers)
kubectl get daemonset calico-node -n calico-system
# numberReady matches desiredNumberScheduled → Calico is actually ready
# (issue was the wait condition, not Calico itself)
```

## How to fix

The `installCalico` function in `sm-a/boot/steps/control_plane.ts` applies all fixes on the second-run path automatically. Use the manual steps below when re-running bootstrap is not an option.

### Fix for Root cause A — force-clean stale pods

```bash
# Delete the Installation CR to stop the operator scheduling old pods
kubectl delete installation default --ignore-not-found --timeout=30s

# Force-kill all stale calico-system pods
kubectl delete pods -n calico-system --all --grace-period=0 --force \
  --ignore-not-found

# Wait 10 seconds for the operator to register the deletions
sleep 10

# Re-apply the operator manifest and Installation CR
kubectl apply -f /opt/calico/tigera-operator.yaml
# Then re-apply Installation CR (bootstrap applies this inline)
```

### Fix for Root cause B — restart tigera-operator

Apply after the Installation CR and calico-system cleanup from Root cause A:

```bash
kubectl rollout restart deployment/tigera-operator -n tigera-operator
kubectl rollout status deployment/tigera-operator -n tigera-operator --timeout=120s
```

After the operator pod restarts it processes the new Installation CR cleanly.

### Fix for Root cause C — restore podSubnet in kubeadm-config

```bash
# Check what's missing
kubectl get configmap kubeadm-config -n kube-system \
  -o jsonpath='{.data.ClusterConfiguration}'

# Re-upload via kubeadm with a corrected config file
cat > /tmp/kubeadm-config.yaml <<EOF
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
kubernetesVersion: "1.35.1"
networking:
  podSubnet: "192.168.0.0/16"
  serviceSubnet: "10.96.0.0/12"
  dnsDomain: "cluster.local"
controlPlaneEndpoint: "k8s-api.k8s.internal:6443"
EOF

kubeadm init phase upload-config kubeadm --config /tmp/kubeadm-config.yaml

# Verify
kubectl get configmap kubeadm-config -n kube-system \
  -o jsonpath='{.data.ClusterConfiguration}' | grep podSubnet
```

## How to prevent

The `installCalico` function in `sm-a/boot/steps/control_plane.ts` now performs all three fixes automatically at the start of the second-run path (when the `CALICO_MARKER` file already exists):

1. Deletes the Installation CR and force-kills calico-system pods if the CR existed
2. Restarts `tigera-operator` after cleanup
3. Calls `ensureKubeadmConfigComplete()` to re-upload kubeadm-config with `podSubnet` before applying the Installation CR

The Calico readiness gate checks only the `calico-node` DaemonSet (`numberReady == desiredNumberScheduled`) rather than all pods in the namespace, eliminating the circular dependency with `calico-kube-controllers`.

To verify these protections are active after any change to `installCalico`, check that the DaemonSet readiness condition in `control_plane.ts` reads `desiredNumberScheduled` not `currentNumberScheduled` or a pod count.

## Related

- [Apiserver cert SANs stale after DR restore](apiserver-cert-stale-dr-restore.md) — fires on the same DR restore run, before Calico installs
- [kubeadm Control Plane Init — OS-Level Runbook](../runbooks/kubeadm-control-plane-init.md) — full step sequence and marker files
- [Kubernetes Bootstrap Orchestrator](../projects/kubernetes-bootstrap-orchestrator.md) — Step Functions state machine, 10-step sequence

<!--
Evidence trail (auto-generated):
- Source: sm-a/boot/steps/control_plane.ts (read 2026-04-28, 1573 lines — installCalico, ensureKubeadmConfigComplete, CALICO_MARKER constant)
- Commit: 6565000 fix(cp): force-clean stale calico-system on second-run before reinstall (root cause A)
- Commit: e795f20 fix(cp): restart tigera-operator after cleanup so it reconciles new Installation CR (root cause B)
- Commit: 6a485f7 fix(cp): gate Calico install on calico-node DaemonSet Ready, not all pods Running (root cause D)
- Commit: 726f653 fix(cp): re-upload kubeadm-config with podSubnet on second-run (root cause C)
- Generated: 2026-04-29
-->
