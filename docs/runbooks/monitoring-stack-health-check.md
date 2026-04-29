---
title: Monitoring Stack Health Check
type: runbook
tags: [monitoring, prometheus, grafana, loki, kubernetes, verification]
sources:
  - argocd-apps/monitoring.yaml
  - charts/monitoring/
created: 2026-04-28
updated: 2026-04-28
---

# Monitoring Stack Troubleshooting Guide

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

### How the Monitoring Stack is Deployed

The monitoring stack is deployed to Kubernetes using a **Helm chart** managed by **ArgoCD**. Here's how all the pieces fit together:

```text
Git Repository (develop branch)
  └── kubernetes-app/app-deploy/monitoring/
        ├── chart/
        │     ├── Chart.yaml                → Helm chart metadata
        │     ├── values.yaml               → Default config (all components)
        │     └── templates/
        │           ├── prometheus-deployment.yaml   → Prometheus pod definition
        │           ├── prometheus-configmap.yaml    → Scrape configuration
        │           ├── prometheus-pvc.yaml          → Prometheus storage
        │           ├── prometheus-rbac.yaml         → Prometheus RBAC
        │           ├── prometheus-service.yaml      → ClusterIP Service
        │           ├── grafana-deployment.yaml      → Grafana pod definition
        │           ├── grafana-configmap.yaml       → Datasource provisioning
        │           ├── grafana-pvc.yaml             → Grafana storage
        │           ├── grafana-secret.yaml          → Admin credentials
        │           ├── grafana-service.yaml         → ClusterIP Service
        │           ├── loki-deployment.yaml         → Loki pod definition
        │           ├── loki-configmap.yaml          → Loki configuration
        │           ├── loki-pvc.yaml                → Loki storage
        │           ├── loki-service.yaml            → ClusterIP Service
        │           ├── tempo-deployment.yaml        → Tempo pod definition
        │           ├── tempo-configmap.yaml         → Tempo configuration
        │           ├── tempo-pvc.yaml               → Tempo storage
        │           ├── tempo-service.yaml           → ClusterIP Service
        │           ├── promtail-daemonset.yaml      → Promtail (DaemonSet)
        │           ├── promtail-configmap.yaml      → Promtail scrape config
        │           ├── promtail-service.yaml        → ClusterIP Service
        │           ├── node-exporter-daemonset.yaml → Node Exporter (DaemonSet)
        │           ├── node-exporter-service.yaml   → ClusterIP Service
        │           ├── kube-state-metrics-*.yaml    → Kube State Metrics
        │           ├── resource-quota.yaml          → Namespace resource limits
        │           └── network-policy.yaml          → Network isolation rules
        └── monitoring-values.yaml → Dev environment overrides
```

ArgoCD watches this Git path and **automatically syncs** changes to the cluster (within ~3 minutes of a push).

### Component Architecture

```text
┌─────────────────────────────────────────────────────────────────────┐
│                     monitoring namespace                            │
│                                                                     │
│  ┌──────────────┐  ┌──────────┐  ┌──────┐  ┌───────┐              │
│  │  Prometheus   │  │ Grafana  │  │ Loki │  │ Tempo │              │
│  │  (Deployment) │  │(Deploy)  │  │(Dep) │  │(Dep)  │              │
│  │  :9090        │  │ :3000    │  │:3100 │  │:3200  │              │
│  │  PVC: 10Gi    │  │ PVC:5Gi  │  │PVC:  │  │PVC:   │              │
│  │               │  │          │  │10Gi  │  │10Gi   │              │
│  │  Scrapes:     │  │ Reads:   │  │      │  │       │              │
│  │  ├node-export │  │├Prometheus│ │      │  │       │              │
│  │  ├kube-state  │  │├Loki     │  │      │  │       │              │
│  │  └promtail    │  │└Tempo    │  │      │  │       │              │
│  └──────────────┘  └──────────┘  └──────┘  └───────┘              │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  DaemonSets (run on ALL nodes)                               │    │
│  │  ┌──────────────┐  ┌────────────┐                           │    │
│  │  │ Node Exporter │  │  Promtail  │                           │    │
│  │  │ :9100         │  │  :9080     │                           │    │
│  │  │ Host metrics  │  │  Log ship  │                           │    │
│  │  └──────────────┘  └────────────┘                           │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌────────────────────┐                                             │
│  │ Kube State Metrics  │  (Deployment, 1 replica)                   │
│  │ :8080               │                                             │
│  └────────────────────┘                                             │
│                                                                     │
│  ResourceQuota: monitoring-quota                                    │
│  NetworkPolicy: monitoring-allow-internal                           │
└─────────────────────────────────────────────────────────────────────┘
```

### What Namespace Does the Monitoring Stack Run In?

All monitoring resources are deployed into the `monitoring` namespace. Every `kubectl` command in this guide uses `-n monitoring` to target this namespace.

### Where Do Monitoring Pods Run?

| Component | Type | Node Selector | Runs On |
|---|---|---|---|
| Prometheus | Deployment | `workload: monitoring` | Monitoring worker only |
| Grafana | Deployment | `workload: monitoring` | Monitoring worker only |
| Loki | Deployment | `workload: monitoring` | Monitoring worker only |
| Tempo | Deployment | `workload: monitoring` | Monitoring worker only |
| Kube State Metrics | Deployment | `workload: monitoring` | Monitoring worker only |
| Node Exporter | DaemonSet | none | **All 3 nodes** |
| Promtail | DaemonSet | none | **All 3 nodes** |

> [!IMPORTANT]
> The `workload: monitoring` label is applied to the monitoring worker node during bootstrap. If no node has this label, Deployment pods will remain in `Pending` state.

### What Are PersistentVolumeClaims?

Prometheus, Grafana, Loki, and Tempo each need persistent storage to survive pod restarts. They use **PersistentVolumeClaims (PVCs)** backed by the `local-path` StorageClass (provided by the local-path-provisioner).

| PVC | Size | Used By |
|---|---|---|
| `prometheus-data` | 10Gi | Prometheus (metrics storage) |
| `grafana-data` | 5Gi | Grafana (dashboards, config) |
| `loki-data` | 10Gi | Loki (log storage) |
| `tempo-data` | 10Gi | Tempo (trace storage) |

### What is the ResourceQuota?

The `monitoring-quota` ResourceQuota limits total resource consumption in the `monitoring` namespace. **Every container** (including init containers) **must** specify `resources.requests` and `resources.limits`, or Kubernetes will reject the pod.

---

## Step 1 — Verify Kubernetes Cluster Health

Before checking the monitoring stack, confirm the cluster itself is healthy.

### 1a — Check Node Status

```bash
sudo kubectl get nodes -o wide
```

| Flag | Meaning |
|---|---|
| `sudo` | Run with administrator privileges. Required because the kubeconfig is owned by root. |
| `kubectl get nodes` | List all machines registered to the cluster. |
| `-o wide` | Show extra columns: internal IP, OS, kernel version, and container runtime. |

#### Why You Need This

If the monitoring worker node shows `NotReady`, monitoring pods cannot run.

#### What Success Looks Like

```text
NAME               STATUS   ROLES           INTERNAL-IP   OS-IMAGE
ip-10-0-0-169...   Ready    control-plane   10.0.0.169    Amazon Linux 2023
ip-10-0-0-160...   Ready    <none>          10.0.0.160    Amazon Linux 2023
ip-10-0-0-26...    Ready    <none>          10.0.0.26     Amazon Linux 2023
```

All 3 nodes should show `Ready`.

### 1b — Verify Node Labels

```bash
sudo kubectl get nodes -o custom-columns='NAME:.metadata.name,WORKLOAD:.metadata.labels.workload'
```

| Flag | Meaning |
|---|---|
| `-o custom-columns=...` | Show custom columns extracted from the JSON structure of each node. |
| `.metadata.labels.workload` | Extract the value of the `workload` label from each node. |

#### What Success Looks Like

```text
NAME                                       WORKLOAD
ip-10-0-0-160.eu-west-1.compute.internal   frontend
ip-10-0-0-169.eu-west-1.compute.internal   <none>
ip-10-0-0-26.eu-west-1.compute.internal    monitoring
```

One node must have `workload=monitoring`. If not, apply the label:

```bash
sudo kubectl label node <NODE_NAME> workload=monitoring
```

---

## Step 2 — Check the Monitoring Namespace

### 2a — Verify the Namespace Exists

```bash
sudo kubectl get namespace monitoring
```

#### What Success Looks Like

```text
NAME         STATUS   AGE
monitoring   Active   24h
```

If the namespace shows `Terminating` or doesn't exist, ArgoCD may not have synced yet.

### 2b — List All Resources in the Namespace

```bash
sudo kubectl get all -n monitoring
```

| Flag | Meaning |
|---|---|
| `get all` | Show pods, services, deployments, replicasets, and daemonsets. |
| `-n monitoring` | Target the monitoring namespace. |

This gives a quick overview of everything deployed.

---

## Step 3 — Inspect ArgoCD Sync Status

```bash
sudo kubectl get applications -n argocd -o wide
```

| Flag | Meaning |
|---|---|
| `applications` | ArgoCD custom resource representing a deployed application. |
| `-n argocd` | ArgoCD lives in the `argocd` namespace. |
| `-o wide` | Show extra columns: revision (Git commit hash). |

#### What Success Looks Like

```text
NAME         SYNC STATUS   HEALTH STATUS   REVISION
monitoring   Synced        Healthy         43321b5a80e8...
```

#### Understanding Health Status

| Status | Meaning |
|---|---|
| **Healthy** | All Kubernetes resources are running correctly. |
| **Degraded** | One or more resources are unhealthy (pod crash, PVC unbound, etc.). |
| **Progressing** | Resources are updating (rolling out new pods). |
| **Missing** | Expected resources don't exist in the cluster. |

> [!NOTE]
> ArgoCD may take a few minutes to re-check health after fixing an issue. You can force a refresh by clicking "Refresh" in the ArgoCD UI or by running:
> ```bash
> sudo kubectl -n argocd patch application monitoring \
>   --type=merge -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}'
> ```

---

## Step 4 — Inspect Pod Status

### 4a — List All Monitoring Pods

```bash
sudo kubectl get pods -n monitoring -o wide
```

| Flag | Meaning |
|---|---|
| `get pods` | List all pods in the namespace. |
| `-o wide` | Show the assigned node address, pod IP, and nominated node. |

#### What Success Looks Like

```text
NAME                                  READY   STATUS    NODE
grafana-7996bdc64-9knhz               1/1     Running   ip-10-0-0-26...
kube-state-metrics-6bb7899667-5rdht   1/1     Running   ip-10-0-0-26...
node-exporter-4skt9                   1/1     Running   ip-10-0-0-26...
node-exporter-gbz4w                   1/1     Running   ip-10-0-0-160...
node-exporter-vp6cf                   1/1     Running   ip-10-0-0-169...
prometheus-57b6c56878-gthzn           1/1     Running   ip-10-0-0-26...
promtail-cdt2t                        1/1     Running   ip-10-0-0-26...
promtail-nj9k4                        1/1     Running   ip-10-0-0-160...
promtail-xk8sg                        1/1     Running   ip-10-0-0-169...
tempo-fff5fb67f-k9gnp                 1/1     Running   ip-10-0-0-26...
```

#### Expected Pod Count

| Component | Expected Pods | Type |
|---|---|---|
| Prometheus | 1 | Deployment |
| Grafana | 1 | Deployment |
| Loki | 1 | Deployment |
| Tempo | 1 | Deployment |
| Kube State Metrics | 1 | Deployment |
| Node Exporter | 3 (one per node) | DaemonSet |
| Promtail | 3 (one per node) | DaemonSet |

**Total: 10 pods** when fully healthy.

### 4b — Check Pod Status Interpretation

| Status | Meaning | Action |
|---|---|---|
| `Running` + `1/1` | Pod is healthy and ready. | None — all good! |
| `Pending` | Pod cannot be scheduled. | Go to [Step 6](#step-6--diagnose-pending-pods). |
| `CrashLoopBackOff` | Pod keeps crashing and restarting. | Go to [Step 9](#step-9--check-pod-logs). |
| `ContainerCreating` | Pod is pulling images or mounting volumes. | Wait a minute then re-check. |
| `ImagePullBackOff` | Cannot download the container image. | Check image name and network/registry access. |

---

## Step 5 — Check PersistentVolumeClaims

```bash
sudo kubectl get pvc -n monitoring
```

| Flag | Meaning |
|---|---|
| `get pvc` | List all PersistentVolumeClaims — storage requests made by pods. |

#### What Success Looks Like

```text
NAME              STATUS   VOLUME                                     CAPACITY   STORAGECLASS
grafana-data      Bound    pvc-abc123...                              5Gi        local-path
loki-data         Bound    pvc-def456...                              10Gi       local-path
prometheus-data   Bound    pvc-ghi789...                              10Gi       local-path
tempo-data        Bound    pvc-jkl012...                              10Gi       local-path
```

All 4 PVCs must show `Bound`. If any show `Pending`, the pod that needs that volume cannot start.

#### Diagnose a Pending PVC

```bash
sudo kubectl describe pvc <PVC_NAME> -n monitoring
```

Look at the **Events** section at the bottom:

| Event Message | Root Cause | Fix |
|---|---|---|
| `no persistent volumes available for this claim and no storage class is set` | PVC has no `storageClassName` and no default StorageClass | Set `storageClassName: local-path` in the PVC spec, or set `local-path` as the default StorageClass |
| `waiting for first consumer to be created before binding` | Normal with `WaitForFirstConsumer` | PVC will bind when a pod using it gets scheduled |
| `storageclass.storage.k8s.io "xxx" not found` | The requested StorageClass doesn't exist | Install local-path-provisioner or correct the storageClass name |

#### Fix: Set local-path as Default StorageClass

```bash
sudo kubectl patch sc local-path -p \
  '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

#### Verify StorageClass

```bash
sudo kubectl get sc
```

**Expected:**

```text
NAME                   PROVISIONER             RECLAIMPOLICY   VOLUMEBINDINGMODE
local-path (default)   rancher.io/local-path   Delete          WaitForFirstConsumer
```

The `(default)` annotation must be present.

---

## Step 6 — Diagnose Pending Pods

If a pod shows `Pending`, inspect why:

```bash
sudo kubectl describe pod <POD_NAME> -n monitoring
```

| Flag | Meaning |
|---|---|
| `describe pod` | Show detailed information about a specific pod, including events. |

Scroll to the **Events** section at the bottom. Common scheduling failures:

### 6a — No Matching Node (NodeSelector)

```text
0/3 nodes are available: 1 node(s) had untolerated taint, 2 node(s) didn't match Pod's node selector.
```

**Root Cause:** The pod requires `nodeSelector: workload=monitoring` but no node has this label.

**Fix:**

```bash
# Check current node labels
sudo kubectl get nodes --show-labels | grep workload

# Apply the label to the monitoring worker
sudo kubectl label node <NODE_NAME> workload=monitoring
```

### 6b — Unbound PersistentVolumeClaim

```text
0/3 nodes are available: pod has unbound immediate PersistentVolumeClaims.
```

**Root Cause:** The PVC referenced by the pod hasn't bound yet. See [Step 5](#step-5--check-persistentvolumeclaims).

### 6c — Insufficient Resources

```text
0/3 nodes are available: Insufficient cpu. Insufficient memory.
```

**Root Cause:** The node doesn't have enough free CPU or memory to satisfy the pod's `resources.requests`.

**Diagnose:**

```bash
# Check resource consumption on the monitoring worker
sudo kubectl describe node <MONITORING_WORKER_NAME> | grep -A 20 "Allocated resources"
```

**Fix:** Either reduce resource requests in `values.yaml` or scale up the EC2 instance.

---

## Step 7 — Check ResourceQuota

The `monitoring-quota` ResourceQuota limits total resource consumption in the namespace.

```bash
sudo kubectl get resourcequota -n monitoring -o yaml
```

| Flag | Meaning |
|---|---|
| `resourcequota` | Kubernetes resource that enforces resource limits at the namespace level. |
| `-o yaml` | Show the full YAML including `status.used` vs `spec.hard`. |

#### Key Fields

```yaml
spec:
  hard:                          # Maximum allowed
    requests.cpu: "2"
    requests.memory: 4Gi
    limits.cpu: "4"
    limits.memory: 8Gi
    persistentvolumeclaims: "10"
status:
  used:                          # Currently consumed
    requests.cpu: 550m
    requests.memory: 800Mi
    limits.cpu: 1206m
    limits.memory: 1600Mi
    persistentvolumeclaims: "4"
```

> [!IMPORTANT]
> When a ResourceQuota is active, **every container** (including init containers) **must specify** `resources.requests` and `resources.limits`. If any container omits this, Kubernetes will reject the pod with a `FailedCreate` error.

#### Check for Quota Violations

If a pod can't be created, the ReplicaSet events will show:

```text
Error creating: pods "xxx" is forbidden: failed quota: monitoring-quota:
  must specify limits.cpu for: <container>;
  limits.memory for: <container>
```

**Fix:** Add `resources` to the offending container in the Helm template. See [Step 8](#step-8--check-replicasets-for-failedcreate) for details.

---

## Step 8 — Check ReplicaSets for FailedCreate

When a Deployment's ReplicaSet can't create pods, the error appears in the ReplicaSet events — not the Deployment events.

### 8a — List ReplicaSets

```bash
sudo kubectl get replicasets -n monitoring
```

| Flag | Meaning |
|---|---|
| `replicasets` | Intermediate controller between Deployment and Pod. Manages pod replicas. |

Look for ReplicaSets with `DESIRED > 0` but `CURRENT = 0`:

```text
NAME               DESIRED   CURRENT   READY   AGE
loki-6dd77dd79d    1         0         0       7h     ← Problem!
```

### 8b — Describe the Failing ReplicaSet

```bash
sudo kubectl describe rs <REPLICASET_NAME> -n monitoring
```

| Flag | Meaning |
|---|---|
| `describe rs` | Show detailed information about a ReplicaSet, including pod creation events. |

#### Example: Missing Resources on Init Container

```text
Events:
  Warning  FailedCreate  replicaset-controller  Error creating: pods "loki-xxx" is forbidden:
    failed quota: monitoring-quota:
    must specify limits.cpu for: fix-permissions;
    limits.memory for: fix-permissions;
    requests.cpu for: fix-permissions;
    requests.memory for: fix-permissions
```

**Root Cause:** The `fix-permissions` init container lacked `resources`, violating the ResourceQuota.

**Fix:** Add resources to the init container in the Helm template:

```yaml
initContainers:
  - name: fix-permissions
    image: busybox:1.36
    command: ["sh", "-c", "chown -R 10001:10001 /loki"]
    securityContext:
      runAsUser: 0
    resources:            # ← This was missing
      requests:
        cpu: 10m
        memory: 32Mi
      limits:
        cpu: 50m
        memory: 64Mi
```

After fixing the template, commit and push to Git. ArgoCD will sync the change and recreate the pod.

### 8c — Force a Rollout After Fix

If ArgoCD has already synced but the old ReplicaSet still exists:

```bash
sudo kubectl rollout restart deployment loki -n monitoring
sudo kubectl rollout status deployment loki -n monitoring --timeout=120s
```

---

## Step 9 — Check Pod Logs

### 9a — Tail Recent Logs

```bash
sudo kubectl logs <POD_NAME> -n monitoring --tail=50
```

| Flag | Meaning |
|---|---|
| `logs <POD_NAME>` | Fetch container output (stdout/stderr) for the specified pod. |
| `--tail=50` | Show only the last 50 lines, keeping the output manageable. |

### 9b — Logs from a Specific Container

Some pods have init containers. To see logs from a specific container:

```bash
# List containers in a pod
sudo kubectl get pod <POD_NAME> -n monitoring -o jsonpath='{.spec.containers[*].name}'

# View logs for a specific container
sudo kubectl logs <POD_NAME> -n monitoring -c <CONTAINER_NAME>
```

### 9c — Logs from a Previous (Crashed) Container

If a container restarted, view the previous container's logs:

```bash
sudo kubectl logs <POD_NAME> -n monitoring --previous --tail=50
```

### 9d — Check Specific Component Logs

```bash
# Prometheus
sudo kubectl logs -n monitoring -l app=prometheus --tail=30

# Grafana
sudo kubectl logs -n monitoring -l app=grafana --tail=30

# Loki
sudo kubectl logs -n monitoring -l app=loki --tail=30

# Tempo
sudo kubectl logs -n monitoring -l app=tempo --tail=30
```

#### Common Log Errors

| Error | Component | Likely Cause |
|---|---|---|
| `opening storage failed` | Prometheus | PVC not mounted or permissions wrong |
| `permission denied` | Loki/Tempo | Init container (`fix-permissions`) didn't run |
| `connection refused` | Grafana | Datasource target (Prometheus/Loki/Tempo) not running |
| `503 Service Unavailable` | Tempo | Startup delay — ingester ring not ready yet (transient) |

---

## Step 10 — Verify Health Probes

Each stateful component has readiness and liveness probes.

### 10a — Check Probe Configuration

```bash
sudo kubectl get deploy <DEPLOYMENT_NAME> -n monitoring \
  -o jsonpath='{.spec.template.spec.containers[0].readinessProbe}' | python3 -m json.tool
```

### 10b — Manually Test a Probe Endpoint

```bash
# Prometheus readiness
sudo kubectl exec -n monitoring deploy/prometheus -- wget -qO- http://localhost:9090/-/ready 2>&1

# Grafana health
sudo kubectl exec -n monitoring deploy/grafana -- wget -qO- http://localhost:3000/api/health 2>&1

# Loki readiness
sudo kubectl exec -n monitoring deploy/loki -- wget -qO- http://localhost:3100/ready 2>&1

# Tempo readiness
sudo kubectl exec -n monitoring deploy/tempo -- wget -qO- http://localhost:3200/ready 2>&1
```

#### What Success Looks Like

- **Prometheus:** Returns the text `Prometheus Server is Ready.`
- **Grafana:** Returns `{"commit":"...","database":"ok","version":"..."}`
- **Loki:** Returns `ready`
- **Tempo:** Returns `ready` (may return 503 during initial startup for ~30 seconds)

> [!NOTE]
> Tempo's readiness probe often returns **503** for the first 20–30 seconds after startup while the ingester ring forms. This is normal — Kubernetes will retry the probe until it succeeds.

---

## Step 11 — Verify Services and Endpoints

### 11a — List All Services

```bash
sudo kubectl get svc -n monitoring
```

#### What Success Looks Like

```text
NAME                 TYPE        CLUSTER-IP       PORT(S)
grafana              ClusterIP   10.96.xxx.xxx    3000/TCP
kube-state-metrics   ClusterIP   10.96.xxx.xxx    8080/TCP
loki                 ClusterIP   10.96.xxx.xxx    3100/TCP
node-exporter        ClusterIP   10.96.xxx.xxx    9100/TCP
prometheus           ClusterIP   10.96.xxx.xxx    9090/TCP
promtail             ClusterIP   10.96.xxx.xxx    9080/TCP
tempo                ClusterIP   10.96.xxx.xxx    3200/TCP,4317/TCP,4318/TCP
```

### 11b — Verify Service Has Endpoints

A Service with no endpoints means no healthy pods match its selector:

```bash
sudo kubectl get endpoints -n monitoring
```

#### What Success Looks Like

Each service should have at least one IP address (the pod IP):

```text
NAME                 ENDPOINTS
grafana              192.168.177.15:3000
kube-state-metrics   192.168.177.7:8080
loki                 192.168.177.16:3100
prometheus           192.168.177.14:9090
...
```

If an endpoint shows `<none>`, the corresponding pods are either not running or their readiness probe is failing.

---

## Step 12 — Verify Cross-Node Connectivity

DaemonSet pods (Node Exporter, Promtail) run on **all nodes**, while Prometheus runs on the **monitoring worker**. Prometheus must be able to scrape metrics from pods on other nodes.

### 12a — Test Cross-Node Scraping

```bash
# Get Prometheus pod
PROM_POD=$(sudo kubectl get pods -n monitoring -l app=prometheus \
  -o jsonpath='{.items[0].metadata.name}')

# Get a node-exporter pod IP on a DIFFERENT node
EXPORTER_IP=$(sudo kubectl get pods -n monitoring -l app=node-exporter \
  --field-selector spec.nodeName=$(sudo kubectl get node \
    -l node-role.kubernetes.io/control-plane -o jsonpath='{.items[0].metadata.name}') \
  -o jsonpath='{.items[0].status.podIP}')

echo "Testing Prometheus → Node Exporter ($EXPORTER_IP) cross-node"
sudo kubectl exec -n monitoring $PROM_POD -- wget -qO- --timeout=3 \
  http://$EXPORTER_IP:9100/metrics 2>&1 | head -5
```

If this fails, see the [Cross-Node Networking Troubleshooting Guide](./cross-node-networking-troubleshooting.md).

### 12b — Check Prometheus Targets

```bash
sudo kubectl exec -n monitoring deploy/prometheus -- \
  wget -qO- http://localhost:9090/api/v1/targets 2>&1 | python3 -m json.tool | grep -E '"health"|"job"'
```

All targets should show `"health": "up"`. Any showing `"health": "down"` indicate a connectivity or configuration issue.

---

## Step 13 — End-to-End Validation

### 13a — Verify Grafana Datasources

```bash
# Log into Grafana API and check datasources
GRAFANA_POD=$(sudo kubectl get pods -n monitoring -l app=grafana \
  -o jsonpath='{.items[0].metadata.name}')
sudo kubectl exec -n monitoring $GRAFANA_POD -- \
  curl -s http://admin:admin@localhost:3000/api/datasources 2>&1 | python3 -m json.tool
```

You should see Prometheus, Loki, and Tempo as configured datasources.

### 13b — Query Prometheus for Active Metrics

```bash
sudo kubectl exec -n monitoring deploy/prometheus -- \
  wget -qO- 'http://localhost:9090/api/v1/query?query=up' 2>&1 | python3 -m json.tool
```

This should return a list of all scrape targets with their current `up` status (1 = healthy, 0 = down).

### 13c — Verify Loki is Receiving Logs

```bash
sudo kubectl exec -n monitoring deploy/grafana -- \
  curl -s 'http://loki:3100/loki/api/v1/query?query={namespace="monitoring"}' 2>&1 \
  | python3 -m json.tool | head -20
```

### 13d — Verify Tempo is Ready

```bash
sudo kubectl exec -n monitoring deploy/tempo -- \
  wget -qO- http://localhost:3200/status 2>&1
```

---

## Quick One-Liner Health Check

Run this comprehensive check from the control plane:

```bash
echo "=== Monitoring Stack Health ===" && \
echo "--- Pods ---" && \
sudo kubectl get pods -n monitoring -o wide && \
echo "--- PVCs ---" && \
sudo kubectl get pvc -n monitoring && \
echo "--- Services ---" && \
sudo kubectl get svc -n monitoring && \
echo "--- ResourceQuota ---" && \
sudo kubectl get resourcequota -n monitoring \
  -o custom-columns='NAME:.metadata.name,CPU-USED:.status.used.requests\.cpu,CPU-LIMIT:.status.hard.requests\.cpu,MEM-USED:.status.used.requests\.memory,MEM-LIMIT:.status.hard.requests\.memory' && \
echo "--- ArgoCD ---" && \
sudo kubectl get applications monitoring -n argocd \
  -o custom-columns='SYNC:.status.sync.status,HEALTH:.status.health.status'
```

---

## Glossary

| Term | Definition |
|---|---|
| **ArgoCD** | GitOps continuous delivery tool — syncs Kubernetes manifests from Git to the cluster |
| **Calico** | Open-source networking and network security solution for Kubernetes (CNI plugin) |
| **ClusterIP** | An internal-only IP address assigned to a Kubernetes Service, reachable only from within the cluster |
| **CNI (Container Network Interface)** | Plugin standard that configures pod networking in Kubernetes |
| **ConfigMap** | Kubernetes resource for storing non-sensitive configuration data as key-value pairs |
| **DaemonSet** | Kubernetes workload that ensures one pod runs on every node (or every matching node) |
| **Deployment** | Kubernetes workload that manages a set of identical pods via ReplicaSets |
| **Endpoints** | List of pod IPs that a Service routes traffic to |
| **Grafana** | Open-source observability platform for visualization and dashboards |
| **Helm** | Kubernetes package manager — templates and deploys YAML manifests as versioned charts |
| **Init Container** | A container that runs before the main containers in a pod, used for setup tasks |
| **Kube State Metrics** | Exports Kubernetes object states (pods, deployments, nodes) as Prometheus metrics |
| **Liveness Probe** | Periodic health check — if it fails, Kubernetes restarts the container |
| **Local-Path Provisioner** | Rancher's lightweight storage provisioner — creates PersistentVolumes on the node's local disk |
| **Loki** | Log aggregation system from Grafana Labs — like Prometheus, but for logs |
| **Node Exporter** | Prometheus exporter for host-level metrics (CPU, memory, disk, network) |
| **NodeSelector** | Pod scheduling constraint — only schedule the pod on nodes with matching labels |
| **PersistentVolumeClaim (PVC)** | A request for storage — binds to a PersistentVolume provided by a StorageClass |
| **Prometheus** | Open-source time-series database and monitoring system — scrapes metrics from targets |
| **Promtail** | Log collection agent from Grafana Labs — ships logs to Loki |
| **Readiness Probe** | Periodic health check — if it fails, Kubernetes removes the pod from Service traffic |
| **ReplicaSet** | Controller that ensures the desired number of pod replicas are running |
| **ResourceQuota** | Namespace-level constraint on total CPU, memory, and object counts |
| **SSM Automation** | AWS Systems Manager capability for running multi-step runbooks on EC2 instances |
| **StorageClass** | Defines how PersistentVolumes are created (provisioner, reclaim policy, binding mode) |
| **Tempo** | Distributed tracing backend from Grafana Labs — stores and queries trace data |
| **ImagePullBackOff** | A pod status indicating Kubernetes cannot pull the container image and is retrying with increasing delays. Common causes: non-existent image tag, private registry without credentials, or network issues. |

## Related

- [Monitoring Stack Degraded](../troubleshooting/monitoring-stack-degraded.md) — common issues and fixes for Prometheus, Grafana, Loki
- [Prometheus Scrape Targets](../troubleshooting/prometheus-scrape-targets.md) — Prometheus-specific scrape target debugging

<!--
Evidence trail (auto-generated):
- Source: docs/incoming/monitoring-troubleshooting-guide.md (migrated 2026-04-28 — split from 1661-line doc; Steps 1-13 + Glossary extracted for runbook)
- Generated: 2026-04-28
-->
