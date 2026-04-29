---
title: Cross-Node Pod Networking Troubleshooting
type: troubleshooting
tags: [calico, networking, kubernetes, vxlan, ec2, cni, aws]
sources:
  - argocd-apps/aws-cloud-controller-manager.yaml
created: 2026-04-28
updated: 2026-04-28
---

# Cross-Node Pod Networking Troubleshooting Guide

A step-by-step guide for diagnosing and fixing cross-node pod networking issues in a kubeadm Kubernetes cluster running Calico CNI on AWS EC2. All commands are run from the **control-plane node** via an AWS SSM session unless otherwise noted.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Quick Health Check](#quick-health-check)
- [Step 1 — Verify Cluster Node Status](#step-1--verify-cluster-node-status)
- [Step 2 — Identify Pod Placement](#step-2--identify-pod-placement)
- [Step 3 — Test Same-Node vs Cross-Node Connectivity](#step-3--test-same-node-vs-cross-node-connectivity)
- [Step 4 — Check Source/Destination Check](#step-4--check-sourcedestination-check)
- [Step 5 — Verify Calico CNI Health](#step-5--verify-calico-cni-health)
- [Step 6 — Inspect Calico IP Pool and Encapsulation Mode](#step-6--inspect-calico-ip-pool-and-encapsulation-mode)
- [Step 7 — Verify Routing Tables](#step-7--verify-routing-tables)
- [Step 8 — Check NACLs and Security Groups](#step-8--check-nacls-and-security-groups)
- [Step 9 — Test VXLAN Tunnel with Packet Capture](#step-9--test-vxlan-tunnel-with-packet-capture)
- [Step 10 — Verify NetworkPolicy Impact](#step-10--verify-networkpolicy-impact)
- [Root Cause and Fix — VXLANCrossSubnet vs VXLANAlways](#root-cause-and-fix--vxlancrosssubnet-vs-vxlanalways)
- [NetworkPolicy Considerations](#networkpolicy-considerations)
- [Diagnostic Decision Tree](#diagnostic-decision-tree)
- [Common Fixes Reference](#common-fixes-reference)
- [Glossary](#glossary)

---

## Architecture Overview

### Cluster Topology

```text
┌─────────────────────────────┐
│    AWS VPC (10.0.0.0/16)    │
│    Single Subnet (AZ a)     │
│                             │
│  ┌───────────┐  ┌────────┐  │
│  │ Control   │  │ Worker │  │
│  │ Plane     │  │ Node   │  │
│  │ 10.0.0.169│  │10.0.0.160│ │
│  │           │  │        │  │
│  │ Pods:     │  │ Pods:  │  │
│  │ 192.168.  │  │ 192.168│  │
│  │ 128.128/26│  │ 101.0/ │  │
│  │           │  │ 26     │  │
│  └─────┬─────┘  └───┬────┘  │
│        │   VXLAN     │      │
│        │  UDP 4789   │      │
│        └─────────────┘      │
└─────────────────────────────┘
```

### Key Networking Components

| Component | Role |
|---|---|
| **Calico CNI** | Pod networking and NetworkPolicy enforcement via Tigera Operator |
| **VXLAN tunnel** | Encapsulates pod-to-pod traffic crossing nodes (UDP port 4789) |
| **IP Pool** | Assigns pod CIDRs per node (default: `192.168.0.0/16`, `/26` per node) |
| **Felix** | Calico's per-node agent — programs routes, iptables, and VXLAN |
| **SourceDestCheck** | AWS EC2 attribute — must be `false` for overlay networking |

---

## Quick Health Check

Run this one-liner from the control plane to quickly validate cross-node connectivity:

```bash
# Get a pod IP on a DIFFERENT node, then test from a pod in kube-system
REMOTE_POD_IP=$(kubectl get pods -n nextjs-app -l app=nextjs \
  -o jsonpath='{.items[0].status.podIP}')
echo "Testing connectivity to $REMOTE_POD_IP"
kubectl run test-curl --rm -it --restart=Never --image=curlimages/curl \
  -n kube-system -- curl -s -o /dev/null -w "%{http_code}" \
  --connect-timeout 5 http://$REMOTE_POD_IP:3000/api/health
```

- **200** = Cross-node networking is healthy
- **000** = Cross-node networking is broken — follow this guide

---

## Step 1 — Verify Cluster Node Status

Check that all nodes are `Ready` and have correct IPs:

```bash
kubectl get nodes -o wide
```

**Expected output:**

```text
NAME               STATUS   ROLES           INTERNAL-IP   OS-IMAGE
ip-10-0-0-169...   Ready    control-plane   10.0.0.169    Amazon Linux 2023
ip-10-0-0-160...   Ready    <none>          10.0.0.160    Amazon Linux 2023
ip-10-0-0-26...    Ready    <none>          10.0.0.26     Amazon Linux 2023
```

> [!WARNING]
> If any node shows `NotReady`, fix that first. Cross-node networking requires all nodes healthy.

---

## Step 2 — Identify Pod Placement

Determine which pods are on which nodes:

```bash
kubectl get pods -A -o wide | grep -E "NAME|nextjs|traefik|calico-node"
```

Note the node assignment for each pod. Cross-node issues only affect pods on **different** nodes.

### Verify pod IPs are in the expected CIDR ranges

```bash
kubectl get ippools -o jsonpath='{range .items[*]}{.metadata.name}: cidr={.spec.cidr}{"\n"}{end}'
```

Each node is assigned a `/26` block from the pool. Verify pod IPs match their node's assigned block:

```bash
kubectl get pods -A -o custom-columns=\
'NAME:.metadata.name,IP:.status.podIP,NODE:.spec.nodeName' | head -20
```

---

## Step 3 — Test Same-Node vs Cross-Node Connectivity

This is the critical test to isolate whether the issue is node-specific or cross-node:

```bash
# Identify a pod and its node
NEXTJS_POD=$(kubectl get pods -n nextjs-app -l app=nextjs -o jsonpath='{.items[0].metadata.name}')
NEXTJS_IP=$(kubectl get pod -n nextjs-app $NEXTJS_POD -o jsonpath='{.status.podIP}')
NEXTJS_NODE=$(kubectl get pod -n nextjs-app $NEXTJS_POD -o jsonpath='{.spec.nodeName}')

echo "Pod: $NEXTJS_POD  IP: $NEXTJS_IP  Node: $NEXTJS_NODE"

# Test from the SAME node (Traefik on that node)
TRAEFIK_POD=$(kubectl get pods -n kube-system -l app.kubernetes.io/name=traefik \
  --field-selector spec.nodeName=$NEXTJS_NODE \
  -o jsonpath='{.items[0].metadata.name}')
echo "Same-node test (via $TRAEFIK_POD):"
kubectl exec -n kube-system $TRAEFIK_POD -- wget -qO- --timeout=3 \
  http://$NEXTJS_IP:3000/api/health 2>&1 | head -3

# Test from a DIFFERENT node
echo "Cross-node test (via test pod):"
kubectl run test-curl --rm -it --restart=Never --image=curlimages/curl \
  -n kube-system -- curl -s -o /dev/null -w "%{http_code}" \
  --connect-timeout 5 http://$NEXTJS_IP:3000/api/health
```

| Result | Diagnosis |
|---|---|
| Same-node ✅, Cross-node ✅ | Networking is healthy |
| Same-node ✅, Cross-node ❌ | **Cross-node networking issue** — continue to Step 4 |
| Same-node ❌, Cross-node ❌ | Pod-level issue (check pod health, NetworkPolicy, CNI) |

---

## Step 4 — Check Source/Destination Check

AWS EC2 instance attribute `SourceDestCheck` must be `false` for pod networking. It prevents the instance from forwarding packets with source/destination IPs it doesn't own (i.e., pod IPs).

### From your local machine (AWS CLI)

```bash
# List all running K8s instances and their SourceDestCheck status
aws ec2 describe-instances \
  --filters \
    "Name=tag:Stack,Values=KubernetesCompute,KubernetesWorkerApp,KubernetesWorkerMonitoring" \
    "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].[InstanceId,Tags[?Key==`Name`].Value|[0],
    NetworkInterfaces[0].SourceDestCheck]' \
  --output table \
  --region eu-west-1 --profile dev-account
```

Or use the justfile shortcut:

```bash
just k8s-check-source-dest
```

**Expected:** All instances show `False`.

### Fix if needed

```bash
aws ec2 modify-instance-attribute \
  --instance-id <INSTANCE_ID> \
  --no-source-dest-check \
  --region eu-west-1 --profile dev-account
```

> [!NOTE]
> In this cluster, `SourceDestCheck` is disabled by CDK in `control-plane-stack.ts` via `disableSourceDestCheck: true` on the launch template. If you see it enabled, the launch template may not have applied correctly.

---

## Step 5 — Verify Calico CNI Health

### Check all calico-node pods are Running

```bash
kubectl get pods -n calico-system -l k8s-app=calico-node -o wide
```

**Expected:** One `calico-node` pod per node, all `1/1 Running`.

### Check Calico operator

```bash
kubectl get pods -n tigera-operator
```

### Check Felix logs for errors

```bash
CALICO_POD=$(kubectl get pods -n calico-system -l k8s-app=calico-node \
  --field-selector spec.nodeName=$(hostname) \
  -o jsonpath='{.items[0].metadata.name}')
kubectl logs -n calico-system $CALICO_POD -c calico-node --tail=50 \
  | grep -iE "error|warn|vxlan|fail"
```

If Felix shows VXLAN-related errors, the tunnel configuration may be wrong — continue to Step 6.

---

## Step 6 — Inspect Calico IP Pool and Encapsulation Mode

This is the most critical check. The encapsulation mode determines how cross-node traffic is handled.

```bash
kubectl get ippools -o jsonpath='{range .items[*]}{.metadata.name}: \
  vxlanMode={.spec.vxlanMode}, \
  encapsulation={.spec.encapsulation}, \
  cidr={.spec.cidr}{"\n"}{end}'
```

### Understanding Encapsulation Modes

| Mode | Behavior | AWS Compatibility |
|---|---|---|
| `VXLANCrossSubnet` | Direct routing for same-subnet, VXLAN for cross-subnet | ❌ Fails when all nodes are in the same subnet |
| `VXLANAlways` | All cross-node traffic uses VXLAN encapsulation | ✅ Works on AWS VPC |
| `None` | Direct routing only (no encapsulation) | ❌ Fails on AWS VPC |

> [!CAUTION]
> **`VXLANCrossSubnet` does NOT work when all nodes are in the same subnet** (which is the typical AWS setup). In this mode, Calico uses direct routing for same-subnet nodes, sending packets with pod IPs as L3 destinations. AWS VPC cannot deliver these packets because it only knows about instance IPs, not pod IPs — even with `SourceDestCheck` disabled. The packets are silently dropped.

### Why VXLANCrossSubnet Fails on AWS (Same Subnet)

```text
With VXLANCrossSubnet (broken):
  Pod A (192.168.128.x) → ens5 → AWS VPC → ??? → never arrives
  Source IP: 192.168.128.x (pod IP — VPC doesn't know this)
  Dest IP:   192.168.101.x (pod IP — VPC can't route this)

With VXLANAlways (working):
  Pod A (192.168.128.x) → vxlan.calico → ens5 → AWS VPC → ens5 → vxlan.calico → Pod B
  Outer Source IP: 10.0.0.169 (instance IP — VPC knows this ✅)
  Outer Dest IP:   10.0.0.160 (instance IP — VPC can route ✅)
  Inner (encapsulated): 192.168.128.x → 192.168.101.x (invisible to VPC)
```

---

## Step 7 — Verify Routing Tables

Check that routes for remote pod CIDRs use the correct interface:

```bash
ip route | grep 192.168
```

### VXLANAlways routes (correct)

```text
192.168.101.0/26 via 192.168.101.0 dev vxlan.calico onlink   ← VXLAN tunnel ✅
192.168.177.0/26 via 192.168.177.0 dev vxlan.calico onlink   ← VXLAN tunnel ✅
blackhole 192.168.128.128/26 proto 80                         ← Local CIDR (expected)
192.168.128.129 dev cali... scope link                        ← Local pod
```

### VXLANCrossSubnet routes (broken on same-subnet AWS)

```text
192.168.101.0/26 via 10.0.0.160 dev ens5                     ← Direct routing ❌
192.168.177.0/26 via 10.0.0.26 dev ens5                      ← Direct routing ❌
```

If you see routes going through `dev ens5` (direct) instead of `dev vxlan.calico`, the encapsulation mode is wrong.

---

## Step 8 — Check NACLs and Security Groups

### Security Groups

Verify the cluster security group allows all internal traffic:

```bash
# Get the security group attached to an instance
SG_ID=$(aws ec2 describe-instances \
  --instance-ids <INSTANCE_ID> \
  --query 'Reservations[0].Instances[0].SecurityGroups[0].GroupId' \
  --output text --region eu-west-1 --profile dev-account)

# Check inbound rules
aws ec2 describe-security-groups --group-ids $SG_ID \
  --query 'SecurityGroups[0].IpPermissions' \
  --region eu-west-1 --profile dev-account
```

**Required:** Self-referencing rule allowing all traffic from the same security group.

### NACLs

```bash
# Get VPC ID, then check NACLs
aws ec2 describe-network-acls \
  --filters "Name=vpc-id,Values=<VPC_ID>" \
  --query 'NetworkAcls[].Entries[?RuleAction==`deny`]' \
  --region eu-west-1 --profile dev-account
```

**Expected:** Default NACLs allow all traffic. Any custom deny rules could block VXLAN (UDP 4789).

---

## Step 9 — Test VXLAN Tunnel with Packet Capture

If routes look correct but traffic still fails, verify the VXLAN tunnel is actually carrying packets:

### Check VXLAN interface details

```bash
ip -d link show vxlan.calico
```

**Expected output includes:**

```text
vxlan id 4096 local 10.0.0.169 dev ens5 srcport 0 0 dstport 4789
```

### Check VXLAN forwarding database

```bash
bridge fdb show dev vxlan.calico
```

**Expected:** One entry per remote node mapping VTEP MAC to node IP:

```text
66:8d:22:d1:79:cb dst 10.0.0.160 self permanent
66:31:8c:fc:22:cd dst 10.0.0.26 self permanent
```

### Capture VXLAN packets during a test

```bash
# Start capture in background, then test connectivity
sudo timeout 5 tcpdump -i ens5 udp port 4789 -c 5 -nn 2>&1 &
curl -s --connect-timeout 3 http://<REMOTE_POD_IP>:3000/api/health
sleep 4
wait
```

| tcpdump Result | Diagnosis |
|---|---|
| VXLAN packets seen (both directions) | Tunnel works, issue is NetworkPolicy or pod-level |
| VXLAN packets sent but no response | Remote node issue (Calico, iptables, or pod) |
| No VXLAN packets at all | Routing or VXLAN interface misconfigured |

---

## Step 10 — Verify NetworkPolicy Impact

NetworkPolicies can silently block cross-node traffic. Check what policies exist:

```bash
kubectl get networkpolicy -A
```

### Test with and without NetworkPolicy

```bash
# Test from a namespace ALLOWED by the policy (e.g., kube-system)
kubectl run test-curl --rm -it --restart=Never --image=curlimages/curl \
  -n kube-system -- curl -s -o /dev/null -w "%{http_code}" \
  --connect-timeout 5 http://<POD_IP>:3000/api/health

# Test from a namespace NOT allowed (e.g., default)
kubectl run test-curl --rm -it --restart=Never --image=curlimages/curl \
  -n default -- curl -s -o /dev/null -w "%{http_code}" \
  --connect-timeout 5 http://<POD_IP>:3000/api/health
```

| Result | Meaning |
|---|---|
| kube-system ✅, default ❌ | NetworkPolicy is working correctly |
| Both ✅ | No restrictive NetworkPolicy in place |
| Both ❌ | Issue is NOT the NetworkPolicy — check CNI/routing |

### Host curl vs Pod curl

When Traefik runs with `hostNetwork: true`, its traffic uses the **node's IP** as source. This does NOT match a `namespaceSelector` rule in a NetworkPolicy because it's not coming from a pod. This explains why `curl localhost` from the control plane returns `504` — it's expected behavior, not a bug.

---

## Root Cause and Fix — VXLANCrossSubnet vs VXLANAlways

### Root Cause

In our cluster, all nodes are in a **single subnet**. Calico's `VXLANCrossSubnet` mode only uses VXLAN encapsulation for nodes in **different** subnets. For same-subnet nodes, it uses direct routing — sending packets with pod IPs directly onto the VPC network. AWS VPC silently drops these packets because it doesn't know how to route pod IPs.

### Live Fix (immediate, non-persistent)

```bash
# Patch the IP pool to use VXLANAlways
kubectl patch ippool default-ipv4-ippool --type=merge \
  -p '{"spec":{"vxlanMode":"Always"}}'

# Restart calico-node to apply new routing
kubectl rollout restart daemonset calico-node -n calico-system
kubectl rollout status daemonset calico-node -n calico-system --timeout=120s

# Verify routes changed to vxlan.calico
ip route | grep 192.168
```

### Persistent Fix (survives cluster re-creation)

The encapsulation mode is set in two files:

**`kubernetes-app/k8s-bootstrap/boot/steps/03_install_calico.py`** (SSM bootstrap):

```yaml
spec:
  calicoNetwork:
    ipPools:
      - cidr: 192.168.0.0/16
        encapsulation: VXLANAlways    # NOT VXLANCrossSubnet
        natOutgoing: Enabled
        nodeSelector: all()
```

**`infra/lib/common/compute/builders/user-data-builder.ts`** (CDK user-data fallback):

```yaml
spec:
  calicoNetwork:
    ipPools:
      - cidr: ${podNetworkCidr}
        encapsulation: VXLANAlways    # NOT VXLANCrossSubnet
        natOutgoing: Enabled
        nodeSelector: all()
```

### Verify After Fix

```bash
# 1. Check IP pool configuration
kubectl get ippools -o jsonpath='{range .items[*]}{.metadata.name}: \
  vxlanMode={.spec.vxlanMode}{"\n"}{end}'
# Expected: vxlanMode=Always

# 2. Check routes
ip route | grep 192.168
# Expected: dev vxlan.calico onlink  (NOT dev ens5)

# 3. Cross-node connectivity test
kubectl run test-curl --rm -it --restart=Never --image=curlimages/curl \
  -n kube-system -- curl -s -o /dev/null -w "%{http_code}" \
  --connect-timeout 5 http://<REMOTE_POD_IP>:3000/api/health
# Expected: 200
```

---

## NetworkPolicy Considerations

The `nextjs-allow-traefik` NetworkPolicy is correct for production:

```yaml
spec:
  podSelector:
    matchLabels:
      app: nextjs
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - port: 3000
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
      ports:
        - port: 3000
```

### What this means for different traffic sources

| Source | Allowed? | Explanation |
|---|---|---|
| Traefik pod (kube-system, same node) | ✅ | Matches `namespaceSelector: kube-system` |
| Traefik pod (kube-system, cross-node) | ✅ | VXLAN preserves source pod identity |
| Prometheus (monitoring) | ✅ | Matches `namespaceSelector: monitoring` |
| `curl localhost` from host (hostNetwork) | ❌ | Host traffic doesn't match any namespaceSelector |
| Pods in `default` namespace | ❌ | Not in allowed namespaces |

> [!IMPORTANT]
> **Keep the NetworkPolicy as-is.** The production path (`CloudFront → EIP → same-node Traefik → pod`) never requires cross-node host-to-pod connectivity. Traefik is a DaemonSet, so every node has a Traefik instance that can reach local pods directly.

---

## Diagnostic Decision Tree

```text
Cross-node pod-to-pod fails?
│
├── Check SourceDestCheck
│   └── Enabled? → Disable it
│
├── Check Calico pods
│   └── Not Running? → Fix Calico first
│
├── Check encapsulation mode
│   └── VXLANCrossSubnet + same subnet? → Change to VXLANAlways ★
│
├── Check routes (ip route | grep 192.168)
│   ├── Routes via ens5 (direct)? → Encapsulation mode wrong
│   └── Routes via vxlan.calico? → VXLAN is configured, check below
│
├── Check VXLAN tunnel (tcpdump udp port 4789)
│   ├── No packets? → VXLAN interface misconfigured
│   ├── Packets sent, no response? → Remote node or SG/NACL issue
│   └── Packets both directions? → Check NetworkPolicy
│
└── Check NetworkPolicy
    ├── Allowed namespace returns 200? → Policy working correctly
    └── All namespaces fail? → Issue is deeper (iptables, Calico Felix)
```

---

## Common Fixes Reference

### Fix 1: Change Calico Encapsulation Mode

```bash
kubectl patch ippool default-ipv4-ippool --type=merge \
  -p '{"spec":{"vxlanMode":"Always"}}'
kubectl rollout restart daemonset calico-node -n calico-system
```

### Fix 2: Disable SourceDestCheck

```bash
aws ec2 modify-instance-attribute \
  --instance-id <ID> --no-source-dest-check \
  --region eu-west-1 --profile dev-account
```

### Fix 3: Restart Calico to Re-Sync Routes

```bash
kubectl rollout restart daemonset calico-node -n calico-system
kubectl rollout status daemonset calico-node -n calico-system --timeout=120s
```

### Fix 4: Delete and Re-Apply IP Pool (nuclear option)

```bash
# Export current pool
kubectl get ippool default-ipv4-ippool -o yaml > /tmp/ippool-backup.yaml

# Edit and re-apply
kubectl apply -f /tmp/ippool-backup.yaml
```

---

## Glossary

| Term | Definition |
|---|---|
| **Calico** | CNI plugin providing pod networking and NetworkPolicy enforcement |
| **CIDR** | Classless Inter-Domain Routing — notation for IP address ranges (e.g., `192.168.0.0/16`) |
| **CNI** | Container Network Interface — plugin standard for Kubernetes networking |
| **DaemonSet** | Kubernetes workload that runs one pod per node |
| **Felix** | Calico's per-node agent that programs routes, iptables rules, and VXLAN tunnels |
| **FDB** | Forwarding Database — maps VXLAN VTEP addresses to physical node IPs |
| **hostNetwork** | Pod setting that uses the node's network namespace (bypasses pod networking) |
| **IP Pool** | Calico resource defining the pod CIDR range and encapsulation settings |
| **NACL** | Network Access Control List — stateless firewall at the VPC subnet level |
| **NetworkPolicy** | Kubernetes resource controlling pod-to-pod traffic (enforced by Calico) |
| **SourceDestCheck** | AWS EC2 attribute — when enabled, drops packets not addressed to the instance |
| **Tigera Operator** | Manages Calico installation and lifecycle on Kubernetes |
| **VTEP** | VXLAN Tunnel Endpoint — the virtual interface that encapsulates/decapsulates packets |
| **VXLAN** | Virtual Extensible LAN — overlay network protocol (UDP port 4789) |
| **VXLANAlways** | Calico mode — always encapsulates cross-node traffic in VXLAN |
| **VXLANCrossSubnet** | Calico mode — only uses VXLAN between different subnets (direct route within same subnet) |
