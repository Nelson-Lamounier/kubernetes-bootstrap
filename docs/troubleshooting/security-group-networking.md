---
title: Security Group Networking Troubleshooting
type: troubleshooting
tags: [security-groups, aws, networking, kubernetes, argocd, iptables]
sources:
  - infra/lib/config/kubernetes/configurations.ts
created: 2026-04-28
updated: 2026-04-28
---

# Security Group & Pod Networking Troubleshooting Guide

A beginner-friendly, step-by-step guide to diagnosing and resolving Kubernetes networking failures caused by AWS Security Group misconfigurations. Based on a real production incident where a SG rule change caused a full ArgoCD outage and cascading CloudFront 504 Gateway Timeout. All commands are run from the **control-plane node** via an AWS SSM session.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Key Concepts Before You Start](#key-concepts-before-you-start)
- [Step 1 — Identify the Symptoms](#step-1--identify-the-symptoms)
- [Step 2 — Check the Kubernetes Control Plane](#step-2--check-the-kubernetes-control-plane)
- [Step 3 — Test Pod-to-API-Server Connectivity](#step-3--test-pod-to-api-server-connectivity)
- [Step 4 — Verify iptables and Endpoints](#step-4--verify-iptables-and-endpoints)
- [Step 5 — Inspect AWS Security Groups](#step-5--inspect-aws-security-groups)
- [Step 6 — Apply the Fix](#step-6--apply-the-fix)
- [Step 7 — Verify Recovery](#step-7--verify-recovery)
- [Quick One-Liner Health Check](#quick-one-liner-health-check)
- [Troubleshooting — Common Issues](#troubleshooting--common-issues)
  - [Issue 1: Pod-to-API-Server Timeout — Missing Pod CIDR SG Rules](#issue-1-pod-to-api-server-timeout--missing-pod-cidr-sg-rules)
  - [Issue 2: ArgoCD Redis secret-init CrashLoopBackOff](#issue-2-argocd-redis-secret-init-crashloopbackoff)
  - [Issue 3: ArgoCD Pods CreateContainerConfigError — Missing Redis Secret](#issue-3-argocd-pods-createcontainerconfigerror--missing-redis-secret)
  - [Issue 4: CloudFront 504 Gateway Timeout — Origin Unreachable](#issue-4-cloudfront-504-gateway-timeout--origin-unreachable)
  - [Issue 5: kubectl Works with sudo But Fails Without](#issue-5-kubectl-works-with-sudo-but-fails-without)
  - [Issue 6: bridge-nf-call-iptables Disabled After Node Reboot](#issue-6-bridge-nf-call-iptables-disabled-after-node-reboot)
  - [Issue 7: Calico Nodes 0/1 — BGP vs VXLAN Mismatch](#issue-7-calico-nodes-01--bgp-vs-vxlan-mismatch)
  - [Issue 8: Calico Typha Connection Timeout — Missing SG Rule for Port 5473](#issue-8-calico-typha-connection-timeout--missing-sg-rule-for-port-5473)
  - [Issue 9: VXLAN Cross-Node Networking Broken — Tunnel Diagnostics](#issue-9-vxlan-cross-node-networking-broken--tunnel-diagnostics)
- [CDK Security Group Reference](#cdk-security-group-reference)
- [Glossary](#glossary)

---

## Prerequisites

Before following this guide, ensure you have:

- **AWS CLI** installed and configured with a named profile
- **SSM Plugin** for the AWS CLI installed ([installation guide](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html))
- **Network access** to AWS (internet connection)
- Your control plane EC2 instance must have the **SSM Agent** running and an **IAM instance profile** that allows SSM
- The cluster is deployed with **3 nodes** (1 control plane + 2 workers)
- You are **already connected to the control plane** via SSM (see the [ArgoCD Readiness Verification Guide](./argocd-readiness-verification-guide.md) for SSM connection instructions)

---

## Key Concepts Before You Start

### How Kubernetes Pod Networking Works on AWS (kubeadm)

In a kubeadm cluster running on EC2, there are **three distinct IP address ranges** that interact:

```text
┌──────────────────────────────────────────────────────────────────────┐
│                        EC2 Instance (Node)                          │
│  Node IP: 10.0.0.198 (VPC CIDR: 10.0.0.0/16)                      │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │                     Pod Network (Calico CNI)                  │   │
│  │  Pod CIDR: 192.168.0.0/16                                    │   │
│  │                                                               │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │   │
│  │  │ Pod A         │  │ Pod B         │  │ Pod C         │       │   │
│  │  │ 192.168.1.5   │  │ 192.168.1.12  │  │ 192.168.2.3   │       │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘       │   │
│  └───────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │                    Service Network (kube-proxy)                │   │
│  │  Service CIDR: 10.96.0.0/12                                   │   │
│  │                                                               │   │
│  │  kubernetes ClusterIP: 10.96.0.1:443  → DNAT → 10.0.0.198:6443 │
│  │  coredns ClusterIP:    10.96.0.10:53  → DNAT → 192.168.x.x:53  │
│  └───────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

### Why AWS Security Groups Matter for Pod Traffic

When a pod sends traffic to a **ClusterIP** (e.g., `10.96.0.1:443`), kube-proxy DNATs the destination to the actual endpoint (e.g., `10.0.0.198:6443`). However, **the source IP is NOT rewritten** — it stays as the pod IP (`192.168.x.x`).

```text
Pod (192.168.1.5) → ClusterIP 10.96.0.1:443
    ↓ kube-proxy DNAT
Pod (192.168.1.5) → Node IP 10.0.0.198:6443  ← SG evaluates THIS packet
```

AWS Security Groups evaluate the final packet. If the SG only allows traffic from the SG itself (self-referencing), it only matches **ENI IPs** (node IPs like `10.0.0.x`). **Pod IPs (`192.168.x.x`) are NOT associated with any ENI**, so the SG drops the packet silently.

### The Four Security Groups

The CDK stack creates 4 role-specific Security Groups:

| SG Name | Purpose | Attached To |
|---|---|---|
| `k8s-{env}-k8s-cluster` | Intra-cluster communication (all K8s ports) | All nodes |
| `k8s-{env}-k8s-control-plane` | API server access from VPC (SSM port-forwarding) | Control plane only |
| `k8s-{env}-k8s-ingress` | Traefik HTTP/HTTPS from CloudFront + admin IPs | Ingress worker |
| `k8s-{env}-k8s-monitoring` | Prometheus, Node Exporter, Loki, Tempo from VPC | Monitoring worker |

### The Cascading Failure Pattern

A single SG misconfiguration can cascade through the entire stack:

```text
SG drops pod CIDR traffic
  └→ Pods cannot reach API server (10.96.0.1:443)
       └→ ArgoCD Redis secret-init can't create Secret → CrashLoopBackOff
            └→ argocd-redis Secret never created
                 └→ argocd-server, repo-server, app-controller → CreateContainerConfigError
                      └→ ArgoCD down → apps not served
                           └→ Traefik has no backends → CloudFront gets no response
                                └→ CloudFront returns 504 Gateway Timeout
```

---

## Step 1 — Identify the Symptoms

### 1a — Check External Access (from your local machine)

```bash
curl -v https://nelsonlamounier.com
```

| Flag | Meaning |
|---|---|
| `-v` | Verbose output — shows TLS handshake, HTTP headers, and response body. |

#### What a Healthy Response Looks Like

```text
< HTTP/2 200
< content-type: text/html
< x-cache: Hit from cloudfront
```

#### What the Failure Looks Like

```text
< HTTP/2 504
< x-cache: Error from cloudfront
```

Key response headers to check:

| Header | Value | Meaning |
|---|---|---|
| `x-cache` | `Error from cloudfront` | CloudFront generated the error, not the origin |
| `x-amz-cf-pop` | e.g., `DUB56-P2` | Edge location that served the error (useful for support) |
| Status code | `504` | Gateway Timeout — CloudFront couldn't reach origin |

### 1b — Check ArgoCD Pod Status (via SSM on control plane)

```bash
sudo kubectl get pods -n argocd
```

#### What the Failure Pattern Looks Like

```text
NAME                                                STATUS                       RESTARTS
argocd-application-controller-0                     CreateContainerConfigError   0
argocd-applicationset-controller-6799596c7c-zslvq   Running                      0
argocd-dex-server-5cb8756cf7-th2z8                  Running                      0
argocd-notifications-controller-5cd8948d4b-8nh92    Running                      0
argocd-redis-59784bcdb7-c7rvd                       Init:0/1                     472
argocd-repo-server-6868bb7494-dsclg                 CreateContainerConfigError   0
argocd-server-7488fb8dbf-2tvg6                      CreateContainerConfigError   0
```

#### Understanding the Status Patterns

| Status | Affected Pods | Root Cause |
|---|---|---|
| `Init:0/1` with high restarts | `argocd-redis` | `secret-init` init container is CrashLooping |
| `CreateContainerConfigError` | server, repo-server, app-controller | A Secret they reference doesn't exist |
| `Running` | dex, applicationset, notifications | These don't depend on the Redis secret |

---

## Step 2 — Check the Kubernetes Control Plane

Before investigating networking, confirm the control plane itself is healthy.

### 2a — Check kubelet Status

```bash
sudo systemctl status kubelet
```

| Flag | Meaning |
|---|---|
| `systemctl status` | Show the service status, PID, and recent log entries from systemd. |

#### What Success Looks Like

```text
● kubelet.service - kubelet: The Kubernetes Node Agent
     Active: active (running) since Sat 2026-03-07 10:08:09 UTC; 1 day 19h ago
```

### 2b — Check kube-apiserver

```bash
sudo crictl ps | grep kube-apiserver
```

| Flag | Meaning |
|---|---|
| `crictl ps` | List running containers using the Container Runtime Interface (CRI). Works directly with containerd, bypassing kubelet. |

#### What Success Looks Like

```text
065981d3815e9   6f9eeb0cff981   44 hours ago   Running   kube-apiserver   0   ...
```

### 2c — Check All kube-system Pods

```bash
sudo kubectl get pods -n kube-system
```

#### What Success Looks Like

```text
NAME                                    READY   STATUS    RESTARTS   AGE
coredns-7d764666f9-2n7s6                1/1     Running   0          43h
coredns-7d764666f9-w4s44                1/1     Running   0          43h
etcd-ip-10-0-0-198...                   1/1     Running   0          43h
kube-apiserver-ip-10-0-0-198...         1/1     Running   0          43h
kube-controller-manager-ip-10-0-0-198...1/1     Running   0          43h
kube-proxy-ch9qp                        1/1     Running   0          43h
kube-proxy-drgmq                        1/1     Running   0          43h
kube-scheduler-ip-10-0-0-198...         1/1     Running   0          43h
```

All pods should be `1/1 Running`. If any are down, address that first.

---

## Step 3 — Test Pod-to-API-Server Connectivity

This is the **critical diagnostic step**. It determines whether the issue is networking or something else.

### 3a — Test from Inside a Pod

```bash
sudo kubectl run test-api --rm -it --image=busybox --restart=Never -- \
  wget --timeout=5 -qO- https://10.96.0.1:443 --no-check-certificate
```

| Flag | Meaning |
|---|---|
| `run test-api` | Create a temporary pod named `test-api`. |
| `--rm` | Automatically delete the pod when it exits. |
| `-it` | Interactive mode with a TTY — show output in the terminal. |
| `--image=busybox` | Use the lightweight BusyBox image (includes `wget`). |
| `--restart=Never` | Don't restart the pod if it exits — we want a one-shot test. |
| `wget --timeout=5` | Try to connect for 5 seconds before giving up. |
| `https://10.96.0.1:443` | The `kubernetes` ClusterIP — the in-cluster API server endpoint. |
| `--no-check-certificate` | Skip TLS verification (we just care about connectivity, not cert validation). |

#### What Success Looks Like

```text
{
  "kind": "Status",
  "apiVersion": "v1",
  "status": "Failure",
  "message": "forbidden: User \"system:anonymous\" ...",
  "code": 403
}
```

A `403 Forbidden` response is **success** — it means the API server received and processed the request. The anonymous user is rejected by RBAC, which is correct behavior.

#### What the Failure Looks Like

```text
wget: download timed out
pod "test-api" deleted
pod argocd/test-api terminated (Error)
```

A timeout means **the packet never reached the API server** — this is the SG dropping the traffic.

### 3b — Test from the Host (not from a pod)

```bash
curl -k https://10.0.0.198:6443/healthz
```

| Flag | Meaning |
|---|---|
| `-k` | Skip TLS certificate verification. |
| `10.0.0.198:6443` | The node IP and API server port. Replace with your actual node IP. |
| `/healthz` | The Kubernetes health check endpoint. |

#### What Success Looks Like

```text
ok
```

If host-level connectivity works but pod connectivity fails, the problem is **specifically the SG blocking pod CIDR traffic**.

---

## Step 4 — Verify iptables and Endpoints

### 4a — Check the Kubernetes Service Exists

```bash
sudo kubectl get svc kubernetes -n default
```

#### What Success Looks Like

```text
NAME         TYPE        CLUSTER-IP   EXTERNAL-IP   PORT(S)   AGE
kubernetes   ClusterIP   10.96.0.1    <none>        443/TCP   43h
```

### 4b — Check the Endpoint Is Correct

```bash
sudo kubectl get endpoints kubernetes -n default
```

| Flag | Meaning |
|---|---|
| `endpoints` | Shows which pod/node IPs the service routes traffic to. |

#### What Success Looks Like

```text
NAME         ENDPOINTS         AGE
kubernetes   10.0.0.198:6443   43h
```

The endpoint IP should match the control plane node's private IP.

### 4c — Verify iptables DNAT Chain

```bash
sudo iptables -t nat -L KUBE-SERVICES | grep 10.96.0.1
```

| Flag | Meaning |
|---|---|
| `-t nat` | Show the NAT table (where kube-proxy DNAT rules live). |
| `-L KUBE-SERVICES` | List the main kube-proxy service dispatch chain. |

#### What Success Looks Like

```text
KUBE-SVC-NPX46M4PTMTKRN6Y  tcp  --  anywhere  10.96.0.1  tcp dpt:https
```

### 4d — Verify the Endpoint Chain

```bash
sudo iptables -t nat -L KUBE-SVC-NPX46M4PTMTKRN6Y -n
```

#### What Success Looks Like

```text
Chain KUBE-SVC-NPX46M4PTMTKRN6Y (1 references)
target                     prot opt source          destination
KUBE-MARK-MASQ             tcp  -- !192.168.0.0/16  10.96.0.1     tcp dpt:443
KUBE-SEP-L2BRHYKOD2CTIM6R  all  --  0.0.0.0/0       0.0.0.0/0     /* -> 10.0.0.198:6443 */
```

This confirms kube-proxy is correctly DNATing `10.96.0.1:443` → `10.0.0.198:6443`.

### 4e — Check Kernel Networking Settings

```bash
sudo sysctl net.bridge.bridge-nf-call-iptables
sudo sysctl net.ipv4.ip_forward
```

Both **must** return `= 1`. If not, see [Issue 6](#issue-6-bridge-nf-call-iptables-disabled-after-node-reboot).

---

## Step 5 — Inspect AWS Security Groups

### 5a — Get SGs Attached to Your Instances

Run this from your **local machine** (not SSM):

```bash
aws ec2 describe-instances \
  --region eu-west-1 \
  --query 'Reservations[].Instances[].[Tags[?Key==`Name`].Value|[0], InstanceId, SecurityGroups[]]' \
  --profile dev-account \
  --output yaml
```

| Flag | Meaning |
|---|---|
| `describe-instances` | List EC2 instances and their metadata. |
| `--query` | JMESPath expression to extract only the fields we care about. |
| `--output yaml` | Human-readable YAML format. |

### 5b — Get Full SG Rules

```bash
SG_IDS=$(aws ec2 describe-instances \
  --region eu-west-1 \
  --profile dev-account \
  --query 'Reservations[].Instances[].SecurityGroups[].GroupId' \
  --output text | tr '\t' '\n' | sort -u | tr '\n' ' ')

for sg in $SG_IDS; do
    echo "=== $sg ==="
    aws ec2 describe-security-groups \
      --region eu-west-1 \
      --profile dev-account \
      --group-ids "$sg" \
      --query 'SecurityGroups[].{Name:GroupName, InboundRules:IpPermissions}' \
      --output yaml
done
```

### 5c — What to Look for

**For the `k8s-{env}-k8s-cluster` SG, verify these pod CIDR rules exist:**

| Port | Protocol | Source | Description |
|---|---|---|---|
| 6443 | TCP | `192.168.0.0/16` | K8s API server (from pods) |
| 10250 | TCP | `192.168.0.0/16` | kubelet API (from pods) |
| 53 | UDP | `192.168.0.0/16` | CoreDNS UDP (from pods) |
| 53 | TCP | `192.168.0.0/16` | CoreDNS TCP (from pods) |

If any of these are missing, pods cannot reach the corresponding services.

> [!IMPORTANT]
> Self-referencing SG rules (source = the SG's own ID) only match traffic from **ENI IPs** (node IPs like `10.0.0.x`). Pod IPs (`192.168.x.x`) are NOT attached to any ENI, so self-referencing rules alone are insufficient for pod-to-service traffic.

---

## Step 6 — Apply the Fix

### 6a — Hotfix via AWS CLI (Immediate Relief)

If pods are down and you need immediate recovery:

```bash
# Get the cluster SG ID
SG_ID=$(aws ec2 describe-instances \
  --region eu-west-1 \
  --profile dev-account \
  --filters "Name=private-ip-address,Values=10.0.0.198" \
  --query 'Reservations[0].Instances[0].SecurityGroups[0].GroupId' \
  --output text)

echo "Cluster SG: $SG_ID"

# Add pod CIDR rules
aws ec2 authorize-security-group-ingress --region eu-west-1 --profile dev-account \
  --group-id "$SG_ID" --protocol tcp --port 6443 \
  --cidr 192.168.0.0/16 --description "K8s API server (from pods)"

aws ec2 authorize-security-group-ingress --region eu-west-1 --profile dev-account \
  --group-id "$SG_ID" --protocol tcp --port 10250 \
  --cidr 192.168.0.0/16 --description "kubelet API (from pods)"

aws ec2 authorize-security-group-ingress --region eu-west-1 --profile dev-account \
  --group-id "$SG_ID" --protocol udp --port 53 \
  --cidr 192.168.0.0/16 --description "CoreDNS UDP (from pods)"

aws ec2 authorize-security-group-ingress --region eu-west-1 --profile dev-account \
  --group-id "$SG_ID" --protocol tcp --port 53 \
  --cidr 192.168.0.0/16 --description "CoreDNS TCP (from pods)"
```

### 6b — Permanent Fix via CDK (Required)

The CLI hotfix will be **overwritten** on the next CDK deploy. Update the CDK code to make the fix permanent.

**File:** `infra/lib/stacks/kubernetes/base-stack.ts`

Add these rules after the existing intra-cluster block (after the CoreDNS UDP self-ref rule):

```typescript
// Pod CIDR → critical services (kube-proxy DNATs ClusterIP to node IP;
// source IP stays in pod CIDR, which self-ref SG rules do NOT match)
this.securityGroup.addIngressRule(
    ec2.Peer.ipv4(configs.cluster.podNetworkCidr),
    ec2.Port.tcp(K8S_API_PORT),
    'K8s API server (from pods)',
);
this.securityGroup.addIngressRule(
    ec2.Peer.ipv4(configs.cluster.podNetworkCidr),
    ec2.Port.tcp(10250),
    'kubelet API (from pods)',
);
this.securityGroup.addIngressRule(
    ec2.Peer.ipv4(configs.cluster.podNetworkCidr),
    ec2.Port.udp(53),
    'CoreDNS UDP (from pods)',
);
this.securityGroup.addIngressRule(
    ec2.Peer.ipv4(configs.cluster.podNetworkCidr),
    ec2.Port.tcp(53),
    'CoreDNS TCP (from pods)',
);
```

The `podNetworkCidr` value is defined in `infra/lib/config/kubernetes/configurations.ts` for each environment (default: `192.168.0.0/16`).

---

## Step 7 — Verify Recovery

### 7a — Re-test Pod-to-API-Server Connectivity

```bash
sudo kubectl run test-api --rm -it --image=busybox --restart=Never -- \
  wget --timeout=5 -qO- https://10.96.0.1:443 --no-check-certificate
```

Should now return a `403 Forbidden` JSON response (success — API server is reachable).

### 7b — Force ArgoCD Redis to Restart

The Redis pod has been in CrashLoopBackOff with a long backoff interval. Force a fresh start:

```bash
sudo kubectl delete pod -n argocd -l app.kubernetes.io/component=redis
```

### 7c — Watch the Recovery Cascade

```bash
sudo kubectl get pods -n argocd -w
```

#### Expected Recovery Sequence

```text
argocd-redis-xxxx                  0/1     Init:0/1    0          5s    ← secret-init starting
argocd-redis-xxxx                  0/1     PodInitializing 0      15s   ← secret created!
argocd-redis-xxxx                  1/1     Running     0          20s   ← Redis is up
argocd-server-xxxx                 1/1     Running     0          30s   ← found secret → started
argocd-repo-server-xxxx            1/1     Running     0          30s   ← found secret → started
argocd-application-controller-0    1/1     Running     0          35s   ← found secret → started
```

### 7d — Verify All Secrets Exist

```bash
sudo kubectl get secrets -n argocd
```

You should now see `argocd-redis` in the list:

```text
NAME                          TYPE     DATA   AGE
argocd-notifications-secret   Opaque   0      44h
argocd-redis                  Opaque   1      30s    ← newly created!
argocd-secret                 Opaque   0      44h
repo-cdk-monitoring           Opaque   3      44h
```

### 7e — Verify External Access

```bash
curl -I https://nelsonlamounier.com
```

Should return `HTTP/2 200` instead of `504`.

---

## Quick One-Liner Health Check

Run this from the control plane to check all pod networking prerequisites:

```bash
echo "=== Pod Networking Health ===" && \
echo "--- Control Plane ---" && \
sudo systemctl is-active kubelet && \
echo "--- kube-system Pods ---" && \
sudo kubectl get pods -n kube-system -o custom-columns='NAME:.metadata.name,STATUS:.status.phase' && \
echo "--- API Server Endpoint ---" && \
sudo kubectl get endpoints kubernetes -n default && \
echo "--- Kernel Settings ---" && \
sudo sysctl net.bridge.bridge-nf-call-iptables net.ipv4.ip_forward && \
echo "--- Pod Connectivity Test ---" && \
sudo kubectl run net-test --rm -it --image=busybox --restart=Never -- \
  wget --timeout=5 -qO- https://10.96.0.1:443 --no-check-certificate 2>&1 | head -3
```

---

## Troubleshooting — Common Issues

### Issue 1: Pod-to-API-Server Timeout — Missing Pod CIDR SG Rules

**Symptoms:** Pods that need to call the Kubernetes API (init containers, controllers, operators) fail with `i/o timeout` when connecting to `10.96.0.1:443`. The host-level `curl -k https://<NODE_IP>:6443/healthz` works fine.

**Root Cause:** The cluster Security Group only has self-referencing rules. Self-ref rules match traffic from node ENI IPs (`10.0.0.x`) but NOT pod IPs (`192.168.x.x`). When kube-proxy DNATs ClusterIP traffic, the destination changes to the node IP but the source stays as the pod IP — the SG drops it.

**Diagnose:**

```bash
# 1. Test pod → API server (should timeout if broken)
sudo kubectl run test-api --rm -it --image=busybox --restart=Never -- \
  wget --timeout=5 -qO- https://10.96.0.1:443 --no-check-certificate

# 2. Test host → API server (should return "ok" even when broken)
curl -k https://10.0.0.198:6443/healthz

# 3. If #1 fails but #2 works → SG is the problem
```

**Fix:** Add pod CIDR source rules to the cluster SG. See [Step 6](#step-6--apply-the-fix).

**Prevention:** Always include pod CIDR rules in the CDK SG definition alongside self-referencing rules.

> [!CAUTION]
> When tightening Security Groups from a broad rule (e.g., `protocol: -1, source: self`) to per-port rules, you MUST add pod CIDR source rules for ports that pods access. The self-referencing rule only covers node-to-node traffic, not pod-to-node.

### Issue 2: ArgoCD Redis secret-init CrashLoopBackOff

**Symptoms:** `argocd-redis` pod shows `Init:0/1` with hundreds of restarts. The `secret-init` init container logs show:

```text
Checking for initial Redis password in secret argocd/argocd-redis at key auth.
{"level":"fatal","msg":"Post \"https://10.96.0.1:443/api/v1/namespaces/argocd/secrets\":
  dial tcp 10.96.0.1:443: i/o timeout"}
```

**Root Cause:** The `secret-init` container tries to call the Kubernetes API to create the `argocd-redis` Secret, but pod CIDR traffic is being dropped by the SG.

**Diagnose:**

```bash
# Check init container logs
sudo kubectl logs <REDIS_POD_NAME> -n argocd -c secret-init

# Check if the secret exists
sudo kubectl get secrets -n argocd | grep redis
```

**Fix:** Resolve the SG networking issue first ([Issue 1](#issue-1-pod-to-api-server-timeout--missing-pod-cidr-sg-rules)), then force-restart the Redis pod:

```bash
sudo kubectl delete pod -n argocd -l app.kubernetes.io/component=redis
```

### Issue 3: ArgoCD Pods CreateContainerConfigError — Missing Redis Secret

**Symptoms:** `argocd-server`, `argocd-repo-server`, and `argocd-application-controller` show `CreateContainerConfigError`.

```bash
sudo kubectl describe pod <POD_NAME> -n argocd | grep -A5 "Warning"
```

Output:

```text
Warning  Failed  kubelet  Error: secret "argocd-redis" not found
```

**Root Cause:** These pods mount the `argocd-redis` Secret as an environment variable for the Redis connection password. The Secret was never created because `secret-init` keeps crashing (see [Issue 2](#issue-2-argocd-redis-secret-init-crashloopbackoff)).

**Fix:** This is a cascading failure — fix the networking ([Issue 1](#issue-1-pod-to-api-server-timeout--missing-pod-cidr-sg-rules)), then Redis will create the secret, and these pods will automatically pick it up on their next retry cycle (every ~10 seconds).

> [!NOTE]
> You do NOT need to manually restart these pods. Kubernetes continuously retries `CreateContainerConfigError` and will start the containers as soon as the referenced Secret becomes available.

### Issue 4: CloudFront 504 Gateway Timeout — Origin Unreachable

**Symptoms:** `curl -v https://nelsonlamounier.com` returns:

```text
< HTTP/2 504
< x-cache: Error from cloudfront
```

The error page says: *"We can't connect to the server for this app or website at this time."*

**Root Cause:** CloudFront → EIP → Traefik → Next.js/ArgoCD. If ArgoCD is down due to networking issues, the app pods aren't being deployed or managed, and Traefik has no healthy backends to route to.

**Diagnose:**

```bash
# Check if Traefik is running
sudo kubectl get pods -n kube-system | grep traefik

# Check if the app pods are running
sudo kubectl get pods -n default

# Check ArgoCD health
sudo kubectl get pods -n argocd
```

**Fix:** This resolves automatically once the ArgoCD networking issue is fixed and ArgoCD re-syncs the applications.

### Issue 5: kubectl Works with sudo But Fails Without

**Symptoms:**

```bash
$ kubectl get pods    # Fails
The connection to the server localhost:8080 was refused

$ sudo kubectl get pods    # Works
NAME   READY   STATUS   ...
```

**Root Cause:** The current user's kubeconfig is missing or pointing to `localhost:8080` (the disabled insecure API port). Root's kubeconfig at `/etc/kubernetes/admin.conf` has the correct cluster endpoint.

**Fix:**

```bash
mkdir -p $HOME/.kube
sudo cp /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
```

### Issue 6: bridge-nf-call-iptables Disabled After Node Reboot

**Symptoms:** Pod networking was working, but after a node reboot, pods can't reach ClusterIPs.

**Root Cause:** The `net.bridge.bridge-nf-call-iptables` sysctl is not persisted and resets to `0` on reboot. This setting is required for bridge traffic (pods) to go through iptables (where kube-proxy DNAT rules live).

**Diagnose:**

```bash
sudo sysctl net.bridge.bridge-nf-call-iptables
# If output is: net.bridge.bridge-nf-call-iptables = 0 → THIS IS THE PROBLEM
```

**Fix:**

```bash
# Set immediately
sudo sysctl -w net.bridge.bridge-nf-call-iptables=1
sudo sysctl -w net.ipv4.ip_forward=1

# Persist across reboots
cat <<EOF | sudo tee /etc/sysctl.d/k8s.conf
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
EOF

# Also ensure br_netfilter module loads on boot
echo "br_netfilter" | sudo tee /etc/modules-load.d/k8s.conf
```

---

### Issue 7: Calico Nodes 0/1 — BGP vs VXLAN Mismatch

**Symptoms:** `calico-node` DaemonSet pods show `0/1 Running` indefinitely — they never become Ready. All cross-node pod networking is broken.

```bash
sudo kubectl get pods -n calico-system -l k8s-app=calico-node
```

```text
NAME                READY   STATUS    RESTARTS   AGE
calico-node-abc12   0/1     Running   0          45h
calico-node-def34   0/1     Running   0          45h
```

**Root Cause:** The Calico Installation resource uses `encapsulation: VXLAN` (VXLAN-only mode), but the Tigera operator **defaults `bgp: Enabled`** when `bgp` is not explicitly set. This starts the BIRD BGP daemon, which fails because BIRD config files (`/etc/calico/confd/config/bird.cfg`) don't exist in VXLAN mode. The readiness probe checks both `-bird-ready` and `-felix-ready`, so BIRD's failure blocks readiness.

**Diagnose:**

```bash
# 1. Check the readiness probe command
sudo kubectl describe pod -n calico-system -l k8s-app=calico-node | grep "Readiness:"
# Output: exec [/bin/calico-node -bird-ready -felix-ready]

# 2. Run the readiness check manually
sudo kubectl exec -n calico-system <CALICO_POD> -- \
  /bin/calico-node -bird-ready -felix-ready 2>&1
# Output: BIRD is not ready: unable to connect to BIRDv4 socket

# 3. Check the Installation resource for the mismatch
sudo kubectl get installation default -o yaml | grep -A5 "calicoNetwork"
# Look for: bgp: Enabled  ← THIS IS THE PROBLEM with VXLAN encapsulation

# 4. Confirm VXLAN mode in IPPool
sudo kubectl get ippools -o yaml | grep -E "ipipMode|vxlanMode"
# Expected: ipipMode: Never, vxlanMode: Always
```

**Fix:**

```bash
# Disable BGP in the Installation resource
sudo kubectl patch installation default --type=merge -p '{
  "spec": {
    "calicoNetwork": {
      "bgp": "Disabled"
    }
  }
}'

# The operator will rolling-restart calico-node pods
sudo kubectl get pods -n calico-system -l k8s-app=calico-node -w
```

**Permanent Fix (Code):** In `kubernetes-app/k8s-bootstrap/boot/steps/03_install_calico.py`, ensure the Installation resource includes `bgp: Disabled`:

```yaml
spec:
  calicoNetwork:
    bgp: Disabled          # ← REQUIRED for VXLAN-only mode
    ipPools:
      - cidr: 192.168.0.0/16
        encapsulation: VXLAN
        natOutgoing: Enabled
        nodeSelector: all()
    linuxDataplane: Iptables
```

> [!CAUTION]
> If `bgp` is omitted, the Tigera operator defaults to `bgp: Enabled`. This is harmless in BGP mode but **breaks readiness in VXLAN-only mode**. Always explicitly set `bgp: Disabled` when using `encapsulation: VXLAN`.

### Issue 8: Calico Typha Connection Timeout — Missing SG Rule for Port 5473

**Symptoms:** `calico-node` on **worker nodes** stays `0/1` while `calico-node` on the **control plane** goes `1/1`. Logs show Felix can't connect to Typha:

```text
Failed to connect to typha endpoint 10.0.0.198:5473.
  error=dial tcp 10.0.0.198:5473: i/o timeout
```

**Root Cause:** Calico Typha runs on the control plane (port **5473**). Felix on worker nodes must connect over the network. If port 5473 is missing from the cluster SG, the connection is silently dropped. The control plane calico-node works because Felix connects via **localhost** (no SG involved).

**Diagnose:**

```bash
# 1. Check which node the failing calico-node is on
sudo kubectl get pod <CALICO_POD> -n calico-system -o wide

# 2. Check Felix logs for Typha connection errors
sudo kubectl logs <CALICO_POD> -n calico-system --tail=30 | grep -i typha

# 3. Test Typha port from the worker node
curl -k --connect-timeout 3 https://<CONTROL_PLANE_IP>:5473
```

**Fix (Hotfix):**

```bash
aws ec2 authorize-security-group-ingress \
  --region eu-west-1 --profile dev-account \
  --group-id <CLUSTER_SG_ID> --protocol tcp --port 5473 \
  --source-group <CLUSTER_SG_ID> \
  --description "Calico Typha (intra-cluster)"
```

**Permanent Fix (CDK):** In `infra/lib/stacks/kubernetes/base-stack.ts`:

```typescript
this.securityGroup.addIngressRule(
    this.securityGroup,
    ec2.Port.tcp(5473),
    'Calico Typha (intra-cluster)',
);
```

After adding the SG rule, restart the failing calico-node:

```bash
sudo kubectl delete pod <CALICO_POD> -n calico-system
```

### Issue 9: VXLAN Cross-Node Networking Broken — Tunnel Diagnostics

**Symptoms:** Pods on one node cannot reach pods or services on another node. Local pod traffic works. `calico-node` pods may show `0/1 Running`.

**Root Cause:** In VXLAN mode (`vxlanMode: Always`), all cross-node pod traffic is encapsulated in VXLAN (UDP 4789). If calico-node is unhealthy (Issues 7/8), the VXLAN tunnels never fully establish.

**Diagnose:**

```bash
# 1. Check VXLAN interface exists and is UP
ip link show vxlan.calico
# Expected: <BROADCAST,MULTICAST,UP,LOWER_UP>

# 2. Check VXLAN FDB entries (should list remote node IPs)
bridge fdb show dev vxlan.calico
# Expected: <MAC> dst <WORKER_IP> self permanent

# 3. Check Calico routes via VXLAN
ip route | grep vxlan
# Expected: 192.168.x.0/26 via 192.168.x.y dev vxlan.calico onlink

# 4. Ping a pod on a remote node from the control plane
WORKER_POD_IP=$(sudo kubectl get pod <POD_ON_WORKER> \
  -n <NS> -o jsonpath='{.status.podIP}')
ping -c 3 $WORKER_POD_IP
# 100% packet loss → VXLAN tunnel is broken

# 5. Test from a specific node to isolate cross-node issues
CTRL=$(sudo kubectl get nodes \
  -l node-role.kubernetes.io/control-plane \
  -o jsonpath='{.items[0].metadata.name}')
sudo kubectl run test-local --rm -it --image=busybox \
  --restart=Never \
  --overrides="{\"spec\":{\"nodeName\":\"$CTRL\"}}" -- \
  wget --timeout=5 -qO- https://10.96.0.1:443 \
  --no-check-certificate
```

**Fix:** Resolve the underlying calico-node health issue:

1. Fix BGP/VXLAN mismatch → [Issue 7](#issue-7-calico-nodes-01--bgp-vs-vxlan-mismatch)
2. Fix Typha SG port → [Issue 8](#issue-8-calico-typha-connection-timeout--missing-sg-rule-for-port-5473)
3. Once calico-nodes are `1/1`, tunnels re-establish automatically
4. Delete stuck pods to trigger recovery

> [!TIP]
> To isolate cross-node vs local issues, schedule a test pod on a specific node using `--overrides` with `nodeName`. If it passes on the control plane but fails on a worker, the VXLAN tunnel to that worker is the problem.

---

## CDK Security Group Reference

### Complete Cluster SG Rules (base-stack.ts)

The `k8s-{env}-k8s-cluster` Security Group should have the following rules:

**Self-referencing rules (node-to-node communication):**

| Port(s) | Protocol | Source | Description |
|---|---|---|---|
| 2379–2380 | TCP | Self | etcd client and peer |
| 6443 | TCP | Self | K8s API server |
| 10250 | TCP | Self | kubelet API |
| 10257 | TCP | Self | kube-controller-manager |
| 10259 | TCP | Self | kube-scheduler |
| 30000–32767 | TCP | Self | NodePort services |
| 53 | TCP/UDP | Self | CoreDNS |
| 4789 | UDP | Self | VXLAN overlay |
| 5473 | TCP | Self | Calico Typha |
| 179 | TCP | Self | Calico BGP peering (legacy — can remove if `bgp: Disabled`) |

**Pod CIDR rules (pod-to-node communication):**

| Port | Protocol | Source | Description |
|---|---|---|---|
| 6443 | TCP | `192.168.0.0/16` | K8s API server (from pods) |
| 10250 | TCP | `192.168.0.0/16` | kubelet API (from pods) |
| 53 | UDP | `192.168.0.0/16` | CoreDNS UDP (from pods) |
| 53 | TCP | `192.168.0.0/16` | CoreDNS TCP (from pods) |

> [!WARNING]
> If you modify these rules, always test pod connectivity immediately after deployment. A misconfigured SG can silently break pod networking without any visible errors in `kubectl get pods` — pods simply timeout when trying to reach services.

---

## Glossary

| Term | Definition |
|---|---|
| **ClusterIP** | A virtual IP address (`10.96.x.x`) assigned to a Kubernetes Service. Only accessible from within the cluster. kube-proxy handles routing via iptables DNAT rules. |
| **DNAT** | Destination Network Address Translation. kube-proxy rewrites the destination IP of packets from ClusterIP to the actual pod/node IP. |
| **ENI** | Elastic Network Interface — the virtual network card attached to an EC2 instance. Security Groups evaluate traffic at the ENI level. |
| **Self-referencing SG rule** | A Security Group ingress rule where the source is the Security Group's own ID. Only matches traffic from IPs attached to ENIs in the same SG. |
| **Pod CIDR** | The IP range assigned to pods by the CNI plugin. For Calico with kubeadm, the default is `192.168.0.0/16`. These IPs are NOT associated with any AWS ENI. |
| **Service CIDR** | The IP range for Kubernetes ClusterIP Services. Default: `10.96.0.0/12`. These are virtual IPs managed entirely by kube-proxy in iptables. |
| **kube-proxy** | A Kubernetes component running on every node that manages iptables rules for Service routing (ClusterIP → endpoint DNAT). |
| **CNI** | Container Network Interface — the plugin responsible for assigning IP addresses to pods and setting up pod-to-pod networking. This cluster uses **Calico**. |
| **CrashLoopBackOff** | Kubernetes status indicating a container keeps crashing and restarting. Kubernetes applies exponential backoff (10s, 20s, 40s, … up to 5 min) between restart attempts. |
| **CreateContainerConfigError** | Kubernetes status indicating the container cannot start because a referenced ConfigMap or Secret does not exist. |
| **Init container** | A special container that runs to completion before the main containers start. If an init container crashes, the pod's main containers never start. |
| **secret-init** | An ArgoCD init container that checks for (and creates if missing) the Redis authentication secret on first deployment. |
| **Calico Typha** | A fan-out proxy that sits between Felix (the per-node policy engine) and the Kubernetes API server. Reduces API server load in multi-node clusters. Listens on port **5473**. |
| **Felix** | Calico's per-node agent. Programs routes, ACLs, and other network policies. Must connect to Typha to receive configuration updates. |
| **BIRD** | The BGP Internet Routing Daemon. Used by Calico in BGP mode to advertise pod routes between nodes. **Not used** when `vxlanMode: Always` is configured. |
| **VXLAN** | Virtual Extensible LAN — an encapsulation protocol (UDP port 4789) used by Calico to tunnel pod traffic between nodes. The alternative to BGP routing. |
| **Tigera Operator** | A Kubernetes operator that manages the Calico CNI lifecycle. Watches the `Installation` custom resource and deploys/configures all Calico components. |
| **Installation CR** | The `Installation` custom resource (apiVersion: `operator.tigera.io/v1`) that configures Calico's networking mode, IP pools, and features. Managed by the Tigera operator. |
