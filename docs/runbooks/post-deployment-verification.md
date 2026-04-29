---
title: Post-Deployment Verification
type: runbook
tags: [verification, kubernetes, deployment, kubectl, argocd, monitoring]
sources:
  - argocd-apps/admin-api.yaml
  - argocd-apps/nextjs.yaml
created: 2026-04-28
updated: 2026-04-28
---

# Kubernetes Post-Deployment Verification Guide

> **Audience:** Beginners with no prior Kubernetes experience.
> **When to use:** After the CI/CD pipeline has completed and the application is running across the 3-node Kubernetes cluster (1 control plane + 2 workers).
> **Pre-requisite:** You must be SSM'd into the **control plane node** before running `kubectl` commands. For worker-specific diagnostics, SSM into the individual worker node.

---

## Table of Contents

1. [Before You Start — Key Concepts](#1-before-you-start--key-concepts)
2. [Verify kubectl Access](#2-verify-kubectl-access)
3. [Check Cluster Health](#3-check-cluster-health)
4. [Verify Namespaces](#4-verify-namespaces)
5. [Check Running Pods](#5-check-running-pods)
6. [Inspect a Specific Pod in Detail](#6-inspect-a-specific-pod-in-detail)
7. [Read Pod Logs](#7-read-pod-logs)
8. [Check Services](#8-check-services)
9. [Verify Ingress Routes (Traefik)](#9-verify-ingress-routes-traefik)
10. [Verify ArgoCD](#10-verify-argocd)
11. [Check Monitoring Stack](#11-check-monitoring-stack)
12. [Verify Next.js Application](#12-verify-nextjs-application)
13. [Check Persistent Storage](#13-check-persistent-storage)
14. [Verify Networking (Calico CNI)](#14-verify-networking-calico-cni)
15. [Check Resource Usage](#15-check-resource-usage)
16. [End-to-End Connectivity Test](#16-end-to-end-connectivity-test)
17. [Common Issues & Troubleshooting](#17-common-issues--troubleshooting)
18. [Quick Health-Check Cheat Sheet](#18-quick-health-check-cheat-sheet)

---

## 1. Before You Start — Key Concepts

| Term | What It Means |
|------|--------------|
| **Node** | A machine (EC2 instance) that runs containers. Our cluster has 3 nodes: 1 control plane + 2 workers (app and monitoring). |
| **Pod** | The smallest unit in Kubernetes — a wrapper around one or more containers. Think of it as a "box" your app runs inside. |
| **Namespace** | A virtual partition inside the cluster to separate workloads (e.g. `nextjs-app` vs `monitoring`). |
| **Service** | An internal load balancer that gives pods a stable address so other pods can talk to them. |
| **Deployment** | A controller that manages pods — it ensures the right number of copies are always running. |
| **Ingress** | A rule that controls how external HTTP/HTTPS traffic reaches your services. |
| **kubectl** | The command-line tool to interact with Kubernetes. Every command below uses it. |

### Our Architecture at a Glance

```
Internet → CloudFront → Elastic IP → Traefik (DaemonSet, hostNetwork on all nodes)
                                           │
                     ┌─────────────────────┼─────────────────────┐
                     │                     │                     │
               Control Plane          App Worker         Monitoring Worker
               (kubeadm master)     (nextjs-app ns)      (monitoring ns)
               ├── etcd             ├── Next.js pods     ├── Prometheus
               ├── kube-apiserver   └── HPA autoscaler   ├── Grafana
               ├── ArgoCD                                ├── Loki / Tempo
               └── Calico (CNI)                          └── Promtail
```

The platform includes **ArgoCD** for GitOps, **Calico** for pod networking, and **Traefik** as a DaemonSet with `hostNetwork: true` across all nodes.

---

## 2. Verify kubectl Access

Before doing anything, confirm you can talk to the cluster.

```bash
kubectl cluster-info
```

**What this does:** Shows the address of the Kubernetes API server and the CoreDNS service. If this command fails, `kubectl` is not configured correctly.

**Expected output (example):**
```
Kubernetes control plane is running at https://10.0.1.50:6443
CoreDNS is running at https://10.0.1.50:6443/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy
```

> [!TIP]
> If you get `The connection to the server localhost:8080 was refused`, this error has **two possible causes**:
>
> **Cause 1 — KUBECONFIG not set** (most common on re-login):
> ```bash
> export KUBECONFIG=/etc/kubernetes/admin.conf
> ```
>
> **Cause 2 — `admin.conf` does not exist** (cluster was never initialized):
> ```bash
> sudo ls -la /etc/kubernetes/admin.conf
> ```
> If the file doesn't exist, `kubeadm init` never completed successfully. See [Section 17: Cluster Not Initialized](#cluster-not-initialized-kubeadm-init-never-ran) for the full diagnostic and recovery steps.

---

## 3. Check Cluster Health

### 3a. Check Node Status

```bash
kubectl get nodes -o wide
```

**What this does:** Lists all machines (nodes) in the cluster and their current status. The `-o wide` flag shows extra details like the operating system and container runtime.

**What to look for:**
- The `STATUS` column should say **Ready** for all nodes. If any node says `NotReady`, that node has a problem (network, kubelet, or resources).
- You should see exactly **3 nodes**: 1 with `ROLES` = `control-plane` and 2 with `ROLES` = `<none>` (workers).

**Expected output (example):**
```
NAME              STATUS   ROLES           AGE   VERSION   INTERNAL-IP   OS-IMAGE            CONTAINER-RUNTIME
ip-10-0-1-50      Ready    control-plane   2d    v1.35.1   10.0.1.50     Amazon Linux 2023   containerd://1.7.x
ip-10-0-1-100     Ready    <none>          2d    v1.35.1   10.0.1.100    Amazon Linux 2023   containerd://1.7.x
ip-10-0-1-150     Ready    <none>          2d    v1.35.1   10.0.1.150    Amazon Linux 2023   containerd://1.7.x
```

> [!TIP]
> The two `<none>` role nodes are your workers. To identify which is the app worker and which is the monitoring worker, check node labels:
> ```bash
> kubectl get nodes --show-labels | grep -E 'role=(app|monitoring)'
> ```

### 3b. Check System Components

```bash
kubectl get componentstatuses
```

**What this does:** Reports the health of core cluster components like the scheduler (assigns pods to nodes) and controller-manager (keeps the cluster in the desired state).

> [!NOTE]
> In newer Kubernetes versions (1.19+) this command may show `Unhealthy` for the scheduler/controller-manager even when they are working fine. This is a known cosmetic issue. If `kubectl get nodes` shows `Ready`, the cluster is healthy.

### 3c. Check System Pods

```bash
kubectl get pods -n kube-system
```

**What this does:** Lists all pods in the `kube-system` namespace. These are the core Kubernetes components that make the cluster work.

**What to look for:** Every pod should show `Running` in the `STATUS` column and the `READY` column should show all containers ready (e.g. `1/1`).

**Key system pods you should see:**
| Pod | Purpose |
|-----|---------|
| `kube-apiserver-*` | The front door to the cluster — all `kubectl` commands go through it |
| `kube-controller-manager-*` | Ensures pods match the desired state |
| `kube-scheduler-*` | Decides which node a new pod runs on |
| `etcd-*` | The cluster's database — stores all cluster state |
| `coredns-*` | Internal DNS so pods can find each other by name |
| `kube-proxy-*` | Manages network rules for services |

### 3d. Verify Worker Nodes Joined the Cluster

```bash
kubectl get nodes
```

**What this does:** Confirms all 3 nodes are registered and `Ready`. If a worker is missing, it hasn't joined the cluster yet.

**If a worker is missing:**
```bash
# On the control plane — generate a new join token
sudo kubeadm token create --print-join-command
```

Then SSM into the worker node and run the printed join command.

### 3e. Check Node Labels and Taints

```bash
kubectl describe nodes | grep -A 5 "Labels:\|Taints:"
```

**What this does:** Shows the labels and taints on each node. Labels control pod scheduling:

| Node | Expected Label | Purpose |
|------|---------------|--------|
| Control Plane | `node-role.kubernetes.io/control-plane` | Runs system components (etcd, API server, ArgoCD) |
| App Worker | `role=app` | Runs Next.js application pods |
| Monitoring Worker | `role=monitoring` | Runs Prometheus, Grafana, Loki, Tempo |

> [!NOTE]
> The control plane has a taint `node-role.kubernetes.io/control-plane:NoSchedule` that prevents regular workloads from being scheduled on it. Only system pods with a matching toleration run there.

### 3f. Verify Pod Scheduling (Pods on Correct Nodes)

```bash
kubectl get pods -A -o wide
```

**What this does:** The `-o wide` flag adds a `NODE` column showing which node each pod runs on. Verify that:

- **Next.js pods** (`nextjs-app` namespace) are on the **app worker**
- **Monitoring pods** (`monitoring` namespace) are on the **monitoring worker**
- **System pods** (`kube-system`, `argocd`) are on the **control plane**

If pods are on the wrong node, check that node labels and `nodeSelector`/`nodeAffinity` rules are correctly configured in the manifests.

---

## 4. Verify Namespaces

```bash
kubectl get namespaces
```

**What this does:** Lists all namespaces (virtual partitions) in the cluster.

**Expected namespaces:**

| Namespace | Purpose |
|-----------|---------|
| `default` | Built-in namespace — we don't deploy anything here |
| `kube-system` | Core Kubernetes components |
| `kube-node-lease` | Node heartbeats (internal) |
| `kube-public` | Publicly readable data (internal) |
| `calico-system` | Calico CNI networking pods |
| `tigera-operator` | Calico's operator controller |
| `monitoring` | Prometheus, Grafana, Loki, Tempo, and related exporters |
| `nextjs-app` | The Next.js portfolio application |
| `argocd` | ArgoCD GitOps controller |
| `traefik` | Traefik ingress controller (if deployed as namespace, otherwise in `kube-system`) |

---

## 5. Check Running Pods

### 5a. All Pods Across All Namespaces

```bash
kubectl get pods --all-namespaces
```

**What this does:** Shows every pod in every namespace. This is the single best "big picture" view of your cluster.

**Shorthand version:**
```bash
kubectl get pods -A
```

**What to look for:**
- **STATUS** column: Every pod should say `Running` (or `Completed` for one-time jobs).
- **READY** column: Should show `1/1` (or `2/2` if the pod has 2 containers). This means all containers inside the pod are ready.
- **RESTARTS** column: Should be `0` or very low. High restart counts mean the pod is crashing and restarting repeatedly (called a "CrashLoopBackOff").

### 5b. Pods in a Specific Namespace

```bash
kubectl get pods -n <namespace-name>
```

Replace `<namespace-name>` with the namespace you want to check.

**What this does:** Lists only the pods in the specified namespace. Useful when you want to focus on one application layer.

**Examples:**
```bash
# Check Next.js application pods
kubectl get pods -n nextjs-app

# Check monitoring stack pods
kubectl get pods -n monitoring

# Check ArgoCD pods
kubectl get pods -n argocd
```

### 5c. Watch Pods in Real-Time

```bash
kubectl get pods -n <namespace-name> -w
```

**What this does:** The `-w` (watch) flag keeps the command running and shows live updates. Useful when waiting for pods to start up. Press `Ctrl+C` to stop watching.

---

## 6. Inspect a Specific Pod in Detail

```bash
kubectl describe pod <pod-name> -n <namespace-name>
```

**What this does:** Shows comprehensive details about a single pod including:
- **Events** (at the bottom) — The most useful section. Shows scheduling decisions, image pulls, container starts/restarts, and errors.
- **Conditions** — Whether the pod is scheduled, initialized, ready, and has containers ready.
- **Container info** — Image, ports, environment variables, resource requests/limits.

**Example:**
```bash
kubectl describe pod nextjs-deployment-abc123-xyz -n nextjs-app
```

> [!TIP]
> You don't need to type the full pod name. Use `Tab` for autocomplete, or copy the name from the `kubectl get pods` output.

---

## 7. Read Pod Logs

### 7a. View Recent Logs

```bash
kubectl logs <pod-name> -n <namespace-name>
```

**What this does:** Prints the stdout/stderr output from the container inside the pod. This is equivalent to reading an application's log file.

### 7b. View Logs with Tail (Last N Lines)

```bash
kubectl logs <pod-name> -n <namespace-name> --tail=100
```

**What this does:** Shows only the last 100 lines of logs instead of the full history. Change `100` to any number you need.

### 7c. Stream Logs in Real-Time

```bash
kubectl logs <pod-name> -n <namespace-name> -f
```

**What this does:** The `-f` (follow) flag streams new log lines as they are written — like `tail -f` on a regular log file. Press `Ctrl+C` to stop.

### 7d. Logs from a Crashed/Restarted Pod

```bash
kubectl logs <pod-name> -n <namespace-name> --previous
```

**What this does:** Shows the logs from the **previous** container instance. Essential for debugging why a pod crashed — because once a pod restarts, its old logs are gone.

### 7e. Logs from a Multi-Container Pod

```bash
kubectl logs <pod-name> -n <namespace-name> -c <container-name>
```

**What this does:** If a pod has multiple containers (sidecars), this targets a specific one. Use `kubectl describe pod <pod-name>` to see which containers exist inside the pod.

---

## 8. Check Services

```bash
kubectl get services --all-namespaces
```

**What this does:** Lists all Services across every namespace. A Service gives pods a stable internal IP address and DNS name.

**Shorthand:**
```bash
kubectl get svc -A
```

**Types of services you'll see:**

| Type | What It Does |
|------|-------------|
| `ClusterIP` | Internal-only access (default). Other pods inside the cluster can reach it, but external traffic cannot. |
| `NodePort` | Opens a port on the node's IP. External traffic can reach it via `<node-ip>:<node-port>`. |
| `LoadBalancer` | Creates an external load balancer (cloud provider specific). |

**Check a specific namespace:**
```bash
kubectl get svc -n monitoring
```

---

## 9. Verify Ingress Routes (Traefik)

Traefik is the ingress controller — it acts as a reverse proxy, routing incoming HTTP/HTTPS traffic to the correct service.

### 9a. Check Traefik Is Running

```bash
kubectl get pods -A | grep traefik
```

**What this does:** Filters the pod list to show only Traefik-related pods. Traefik should be `Running` with `1/1` ready.

### 9b. Check IngressRoutes

```bash
kubectl get ingressroutes --all-namespaces
```

**What this does:** Lists all Traefik IngressRoute resources. These define the routing rules (e.g., "requests to `/` go to the Next.js service").

> [!NOTE]
> `IngressRoute` is a Traefik-specific custom resource (CRD), not the standard Kubernetes `Ingress`. If the above command fails with "resource not found", Traefik CRDs may not be installed yet.

### 9c. Check Standard Ingress Resources

```bash
kubectl get ingress --all-namespaces
```

**What this does:** Lists standard Kubernetes Ingress resources (if any are used alongside Traefik IngressRoutes).

---

## 10. Verify ArgoCD

ArgoCD is the GitOps controller that keeps Kubernetes manifests in sync with your Git repository.

### 10a. Check ArgoCD Pods

```bash
kubectl get pods -n argocd
```

**What this does:** Lists all ArgoCD pods. You should see several pods, including the server, repo-server, application-controller, and redis.

**Key pods to expect:**
| Pod Name Pattern | Purpose |
|-----------------|---------|
| `argocd-server-*` | The web UI and API server |
| `argocd-repo-server-*` | Clones and processes Git repositories |
| `argocd-application-controller-*` | Watches for drift between Git and the cluster |
| `argocd-redis-*` | In-memory cache |
| `argocd-applicationset-controller-*` | Manages ApplicationSets |
| `argocd-dex-server-*` | Authentication provider |
| `argocd-notifications-controller-*` | Sends sync notifications |

### 10b. Check ArgoCD Applications

```bash
kubectl get applications -n argocd
```

**What this does:** Lists all ArgoCD-managed applications and their sync status.

**What to look for:**
- **SYNC STATUS** should be `Synced` — this means the cluster state matches what's in Git.
- **HEALTH STATUS** should be `Healthy` — this means all pods managed by this application are running normally.

If either is `OutOfSync` or `Degraded`, ArgoCD detected a difference or an unhealthy pod.

### 10c. Get Detailed Application Info

```bash
kubectl describe application <app-name> -n argocd
```

**What this does:** Shows full details of an ArgoCD application including the Git source, target namespace, sync history, and any error messages.

### 10d. Day-1: Generate CI Bot Token (One-Time Setup)

After `Pipeline A` (`deploy-kubernetes`) completes its first deployment and ArgoCD pods are `Running`, you must manually generate a CI bot token. This token is used by `Pipeline B` (`gitops-k8s-dev.yml`) to verify ArgoCD sync status.

> [!IMPORTANT]
> The bootstrap script (`bootstrap_argocd.py`) registers the `ci-bot` account and RBAC policy automatically. However, on Day-1 the token generation may fail because ArgoCD pods were still starting. This one-time manual step resolves that.

**Step 1 — SSM into the control plane:**
```bash
just ec2-session <instance-id> dev-account
```

**Step 2 — Switch to root and set kubectl namespace:**
```bash
sudo su -
export KUBECONFIG=/etc/kubernetes/admin.conf
kubectl config set-context --current --namespace=argocd
```

**Step 3 — Verify ci-bot account exists:**
```bash
kubectl get configmap argocd-cm -n argocd -o jsonpath='{.data.accounts\.ci-bot}'
# Expected output: apiKey
```

**Step 4 — Generate the token:**
```bash
argocd account generate-token --account ci-bot --core --grpc-web
```

Copy the output token.

**Step 5 — Store the token in Secrets Manager (from your local machine):**
```bash
just argocd-ci-token
# Paste the token when prompted
```

> [!NOTE]
> The `just argocd-ci-token` command handles both create and update. If the secret already exists (e.g., from a previous deployment), it will update it.

---

## 11. Check Monitoring Stack

The monitoring namespace contains the full observability platform.

### 11a. List All Monitoring Pods

```bash
kubectl get pods -n monitoring
```

**Expected components:**

| Component | What It Does |
|-----------|-------------|
| **Prometheus** | Scrapes metrics from all services and stores time-series data |
| **Grafana** | Web dashboard for visualising Prometheus metrics and Loki logs |
| **Loki** | Log aggregation system (like a lightweight Elasticsearch for logs) |
| **Promtail** | Agent that ships pod logs to Loki |
| **Tempo** | Distributed tracing backend |
| **Node Exporter** | Exports hardware and OS metrics (CPU, memory, disk) from the node |
| **Kube State Metrics** | Exports Kubernetes object metrics (pod counts, deployment status) |

### 11b. Check Monitoring Services

```bash
kubectl get svc -n monitoring
```

**What this does:** Shows the services exposing each monitoring component. Look for Grafana's service — it's the main dashboard you'll access.

### 11c. Verify Grafana Is Accessible

```bash
kubectl get svc -n monitoring | grep grafana
```

**What this does:** Finds the Grafana service and shows its port. If Grafana is exposed via a `NodePort`, you can access it at `http://<node-ip>:<node-port>`.

### 11d. Check Prometheus Targets

```bash
kubectl port-forward svc/prometheus -n monitoring 9090:9090 &
curl -s http://localhost:9090/api/v1/targets | head -50
```

**What this does:**
1. `kubectl port-forward` creates a temporary tunnel from the EC2 instance to the Prometheus service. This lets you access Prometheus locally without exposing it to the internet.
2. `curl` queries the Prometheus targets API to confirm it is scraping metrics.

> [!NOTE]
> Press `Ctrl+C` or run `kill %1` to stop the port-forward when done.

---

## 12. Verify Next.js Application

### 12a. Check Next.js Pods

```bash
kubectl get pods -n nextjs-app
```

**What this does:** Lists the Next.js application pods. You should see one or more pods with `Running` status.

### 12b. Check the Deployment

```bash
kubectl get deployment -n nextjs-app
```

**What this does:** Shows the deployment controller that manages the Next.js pods. The `READY` column (e.g., `2/2`) shows how many replicas are running out of the desired count.

### 12c. Check Next.js Service

```bash
kubectl get svc -n nextjs-app
```

**What this does:** Shows the service that routes internal traffic to the Next.js pods.

### 12d. Check Horizontal Pod Autoscaler (HPA)

```bash
kubectl get hpa -n nextjs-app
```

**What this does:** Shows the autoscaler configuration. The HPA automatically adds or removes pods based on CPU/memory usage.

**Columns explained:**
- **TARGETS** — Current resource usage vs target (e.g., `45%/80%` means 45% CPU used with an 80% target).
- **MINPODS/MAXPODS** — The allowed range of replicas.
- **REPLICAS** — How many pods are currently running.

### 12e. Check Next.js Secrets

```bash
kubectl get secrets -n nextjs-app
```

**What this does:** Lists secrets (sensitive configuration like database table names, API URLs) injected into the Next.js pods by the boot script.

### 12f. Quick HTTP Check

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:80
```

**What this does:** Sends an HTTP request to the Traefik ingress on port 80 and prints just the HTTP status code.

- **200** — The application is responding normally.
- **502/503** — The backend pods are not ready yet.
- **404** — Traefik can't find a matching route.

---

## 13. Check Persistent Storage

### 13a. List Persistent Volumes

```bash
kubectl get pv
```

**What this does:** Lists Persistent Volumes (PV) — these represent actual storage resources (like the EBS volume attached to the EC2 instance).

### 13b. List Persistent Volume Claims

```bash
kubectl get pvc --all-namespaces
```

**What this does:** Lists Persistent Volume Claims (PVC) — these represent storage requests from pods. A PVC "binds" to a PV.

**What to look for:** The `STATUS` should be `Bound`, meaning the claim successfully connected to a physical volume.

### 13c. Check EBS Mount (Control Plane)

```bash
df -h /data
```

**What this does:** Shows the disk space usage for the `/data` mount point on the **control plane node** where the EBS volume is attached. This volume stores Kubernetes etcd data, ArgoCD state, and other persistent configuration.

> [!NOTE]
> Run this command from the **control plane** via SSM. Worker nodes may have separate EBS volumes — check them individually by SSM'ing into the specific worker.

### 13d. Check Storage Across All Nodes

```bash
# From the control plane — check which PVCs are bound and on which nodes
kubectl get pvc -A -o wide
```

**What this does:** Shows where persistent storage is allocated across the cluster. Monitoring PVCs (Prometheus, Grafana data) should be bound on the monitoring worker node.

---

## 14. Verify Networking (Calico CNI)

Calico is the Container Network Interface (CNI) plugin — it provides networking between pods.

### 14a. Check Calico Pods

```bash
kubectl get pods -n calico-system
```

**What this does:** Lists all Calico networking pods. They should all be `Running`.

### 14b. Check Calico Operator

```bash
kubectl get pods -n tigera-operator
```

**What this does:** Checks that the Calico operator (which manages Calico components) is running.

### 14c. Check Network Policies

```bash
kubectl get networkpolicies --all-namespaces
```

**What this does:** Lists all NetworkPolicy resources. These act like firewall rules between pods — controlling which pods can talk to each other.

### 14d. Test Pod-to-Pod DNS

```bash
kubectl run test-dns --image=busybox --rm -it --restart=Never -- nslookup kubernetes.default
```

**What this does:** Launches a temporary pod that performs a DNS lookup for the Kubernetes API service. If DNS is working, it will resolve to an IP address. The pod is automatically deleted after the lookup completes (`--rm` flag).

---

## 15. Check Resource Usage

### 15a. Node Resource Usage

```bash
kubectl top nodes
```

**What this does:** Shows CPU and memory usage for each node (requires the Metrics Server to be running). With 3 nodes, you'll see a row per node.

> [!TIP]
> Compare resource usage across nodes. The monitoring worker typically uses more memory (Prometheus retention), while the app worker uses more CPU (Next.js SSR). If one node is at capacity, consider adjusting resource requests or scaling.

> [!NOTE]
> If this command fails with "Metrics API not available", the metrics server may not be installed. This is informational only — the cluster still works without it.

### 15b. Pod Resource Usage

```bash
kubectl top pods --all-namespaces
```

**What this does:** Shows CPU and memory usage for every pod. This helps identify pods that are consuming too many resources.

### 15c. Resource Quotas

```bash
kubectl get resourcequotas --all-namespaces
```

**What this does:** Lists resource quotas — limits on how much CPU/memory each namespace can consume. This prevents one namespace from starving others.

---

## 16. End-to-End Connectivity Test

Run this sequence to validate the full traffic path from CloudFront → Traefik → Next.js:

### Step 1: Verify the EIP is associated (run on control plane)

```bash
curl -s http://169.254.169.254/latest/meta-data/public-ipv4
```

**What this does:** Queries the EC2 instance metadata service to show the current public IP. This should match the Elastic IP assigned by CDK to the control plane.

### Step 2: Test Traefik locally (run on any node)

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost
```

**What this does:** Sends a request to Traefik's HTTP port. Since Traefik runs as a DaemonSet with `hostNetwork: true`, this works on **any node** in the cluster. A `200` response means Traefik is routing traffic to the application.

### Step 3: Test from the public IP

```bash
PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)
curl -s -o /dev/null -w "%{http_code}\n" http://$PUBLIC_IP
```

**What this does:** Tests the application from its public Elastic IP, simulating how CloudFront reaches the origin.

### Step 4: Test CloudFront (from your local machine, not the EC2)

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://dev.nelsonlamounier.com
```

**What this does:** Hits the full production URL (CloudFront → EIP → Traefik → Next.js). A `200` means the entire chain is working.

---

## 17. Common Issues & Troubleshooting

### Cluster Not Initialized (`kubeadm init` Never Ran)

**Symptoms:**
- `kubectl cluster-info` returns `connection refused` to `localhost:8080`
- `/etc/kubernetes/admin.conf` does not exist
- `kubelet` is `inactive (dead)` with no journal entries

**Diagnostic steps:**

```bash
# 1. Check if admin.conf exists
sudo ls -la /etc/kubernetes/admin.conf

# 2. Inspect the kubernetes directory (should contain admin.conf, manifests, pki, etc.)
sudo ls -la /etc/kubernetes/

# 3. Check kubelet status (should say Active: active (running))
sudo systemctl status kubelet

# 4. Check kubelet logs (should have entries)
sudo journalctl -u kubelet --no-pager --lines=30

# 5. Check cloud-init logs to see where the boot script failed
sudo tail -200 /var/log/cloud-init-output.log

# 6. Check if the EBS data volume is mounted
df -h /data

# 7. Check if the boot script was downloaded from S3
ls -la /data/k8s-bootstrap/boot/boot-k8s.sh 2>/dev/null || echo "Boot script NOT found"
```

**How to interpret:**
- If `/etc/kubernetes/` only contains an empty `manifests/` directory → `kubeadm` was installed but `kubeadm init` never completed.
- If `kubelet` shows `inactive (dead)` with `-- No entries --` → kubelet was never started because `kubeadm init` never ran.
- Check `cloud-init-output.log` for the exact failure. The most common cause is:

> [!CAUTION]
> **`ip_forward` not enabled** — The `kubeadm init` preflight check requires `/proc/sys/net/ipv4/ip_forward` to be set to `1`. If the boot script doesn't set this before calling `kubeadm init`, the init will fail with:
> ```
> [ERROR FileContent--proc-sys-net-ipv4-ip_forward]: /proc/sys/net/ipv4/ip_forward contents are not set to 1
> ```

**Fix — Enable IP forwarding and run `kubeadm init` manually:**

```bash
# Step 1: Enable IP forwarding (required by Kubernetes networking)
sudo sysctl -w net.ipv4.ip_forward=1
echo 'net.ipv4.ip_forward = 1' | sudo tee /etc/sysctl.d/k8s.conf
sudo sysctl --system

# Step 2: Ensure containerd is running
sudo systemctl start containerd
sudo systemctl status containerd

# Step 3: Get the instance IPs for certificate SANs
IMDS_TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
PRIVATE_IP=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)

# Step 4: Run kubeadm init
sudo kubeadm init \
  --kubernetes-version=1.35.1 \
  --pod-network-cidr=192.168.0.0/16 \
  --service-cidr=10.96.0.0/12 \
  --control-plane-endpoint=${PRIVATE_IP}:6443 \
  --apiserver-cert-extra-sans=${PRIVATE_IP},${PUBLIC_IP} \
  --upload-certs

# Step 5: Configure kubectl
export KUBECONFIG=/etc/kubernetes/admin.conf

# Step 6: Verify the cluster is up
kubectl cluster-info
kubectl get nodes
```

> [!IMPORTANT]
> After manually initializing the cluster, you still need to install the CNI (Calico), taint the control-plane node to allow workload scheduling, and deploy the remaining components. If the boot script is available on S3, re-trigger it via SSM State Manager to complete the full bootstrap.

---

### Worker Node Failed to Join (or Needs to Rejoin)

**Symptoms:**
- `kubectl get nodes` shows only 1–2 nodes instead of 3
- A worker node was replaced by AutoScaling (new instance ID)
- Worker shows `NotReady` or is missing entirely

**Diagnostic steps (run on control plane):**

```bash
# 1. Check current nodes
kubectl get nodes -o wide

# 2. Generate a new join token (tokens expire after 24h)
sudo kubeadm token create --print-join-command
```

**Recovery (run on the missing worker node via SSM):**

```bash
# 1. Verify prerequisites
sudo systemctl status containerd
sudo sysctl net.ipv4.ip_forward

# 2. If the node was previously joined, reset first
sudo kubeadm reset -f

# 3. Run the join command from the control plane output above
sudo kubeadm join 10.0.1.50:6443 --token <token> \
  --discovery-token-ca-cert-hash sha256:<hash>

# 4. Verify from the control plane
kubectl get nodes -o wide
```

> [!IMPORTANT]
> After a worker rejoins, pods should automatically be scheduled by the kube-scheduler within 1–2 minutes. Verify with `kubectl get pods -A -o wide` that workloads are landing on the new worker.

---

### Pod Stuck in `Pending`

```bash
kubectl describe pod <pod-name> -n <namespace>
```

**Cause:** Usually insufficient CPU/memory. Check the Events section for messages like `Insufficient cpu` or `Insufficient memory`.

**Fix:** Either reduce the pod's resource requests or scale up the node.

---

### Pod in `CrashLoopBackOff`

```bash
kubectl logs <pod-name> -n <namespace> --previous
```

**Cause:** The application inside the pod is crashing. The `--previous` flag shows logs from the last crash.

**Common causes:**
- Missing environment variables or secrets
- Incorrect container image
- Application configuration error

---

### Pod in `ImagePullBackOff`

```bash
kubectl describe pod <pod-name> -n <namespace>
```

**Cause:** Kubernetes can't download the container image. Check Events for:
- `ImagePullBackOff` — Image name or tag is wrong
- `ErrImagePull` — Registry authentication issue

**Fix:** Verify the image exists in ECR and the instance role has ECR pull permissions.

---

### kubectl: `connection refused`

**Diagnostic flow:**

```bash
# 1. Check if admin.conf exists
sudo ls -la /etc/kubernetes/admin.conf

# 2a. If it EXISTS → set the variable
export KUBECONFIG=/etc/kubernetes/admin.conf

# 2b. If it DOES NOT exist → cluster was never initialized
# See "Cluster Not Initialized" section above
```

**Root causes (in order of likelihood):**
1. **KUBECONFIG not set** — the SSM session doesn't set it automatically
2. **admin.conf doesn't exist** — `kubeadm init` never ran or failed
3. **API server is down** — kubelet or containerd crashed

**Permanent fix (for KUBECONFIG on every login):**

```bash
sudo mkdir -p ~ssm-user/.kube
sudo cp /etc/kubernetes/admin.conf ~ssm-user/.kube/config
sudo chown ssm-user:ssm-user ~ssm-user/.kube/config
echo 'export KUBECONFIG=~/.kube/config' | sudo tee -a ~ssm-user/.bashrc
```

---

### Node Shows `NotReady`

First, identify **which** node is `NotReady`:

```bash
kubectl get nodes -o wide
```

Then SSM into the affected node and run:

```bash
sudo systemctl status kubelet
sudo journalctl -u kubelet --no-pager --lines=50
```

**What these do:**
- `systemctl status kubelet` — Shows whether the kubelet service (the agent that runs pods) is active.
- `journalctl -u kubelet` — Shows the kubelet's system logs for error details.

**Additional checks (run on the affected node):**
```bash
# Check if containerd is running (kubelet depends on it)
sudo systemctl status containerd

# Check if the node can reach the API server (workers must reach control plane port 6443)
curl -sk https://10.0.1.50:6443/healthz
```

> [!TIP]
> If a **worker** node is `NotReady` but the **control plane** is fine, the most common causes are:
> 1. **Security group** — Port 6443 not open between worker and control plane
> 2. **Kubelet crashed** — Restart with `sudo systemctl restart kubelet`
> 3. **Token expired** — The worker needs to rejoin (see "Worker Node Failed to Join" above)

---

### Certificates Expired

```bash
sudo kubeadm certs check-expiration
```

**What this does:** Shows the expiration date for all Kubernetes certificates. If any are expired, the API server will stop accepting connections.

**Fix:**
```bash
sudo kubeadm certs renew all
sudo systemctl restart kubelet
```

---

### Boot Script Did Not Complete

If the cluster is partially initialized, check where the boot script stopped. **SSM into the affected node** (control plane or worker) and run:

```bash
# Check cloud-init output (UserData runs here)
sudo tail -200 /var/log/cloud-init-output.log

# Check if kubeadm init/join log exists
cat /tmp/kubeadm-init.log 2>/dev/null || echo "No kubeadm-init log found"

# Check SSM agent logs (for SSM State Manager triggered scripts)
sudo tail -100 /var/log/amazon/ssm/amazon-ssm-agent.log
```

**Common boot script failures:**

| Failure | Affected Node | Cloud-init Log Clue | Fix |
|---------|--------------|--------------------|----- |
| `ip_forward` not set | Any | `[ERROR FileContent--proc-sys-net-ipv4-ip_forward]` | `sudo sysctl -w net.ipv4.ip_forward=1` then re-run |
| containerd not found | Any | `WARNING: containerd not found` | Check Day-0 install in cloud-init log |
| S3 download failed | Any | `Unable to locate credentials` or `404` | Verify IAM Instance Profile and S3 bucket |
| EBS not attached | Control Plane | `mount: /data: special device not found` | Check EBS attachment in Base Stack |
| Join command failed | Workers | `unable to connect to API server` | Check SG port 6443 and regenerate token |
| Token expired | Workers | `token has expired` | Run `kubeadm token create --print-join-command` on control plane |

---

## 18. Quick Health-Check Cheat Sheet

Copy-paste this block to verify the cluster's health in under 30 seconds:

```bash
echo "=== Node Status (expect 3 Ready) ==="
kubectl get nodes -o wide

echo ""
echo "=== Pod Placement (which pod is on which node) ==="
kubectl get pods -A -o wide --sort-by='.spec.nodeName'

echo ""
echo "=== All Pods ==="
kubectl get pods -A

echo ""
echo "=== Services ==="
kubectl get svc -A

echo ""
echo "=== Problem Pods (non-Running) ==="
kubectl get pods -A | grep -v Running | grep -v Completed | grep -v NAMESPACE

echo ""
echo "=== Events (last 10 warnings) ==="
kubectl get events -A --sort-by='.lastTimestamp' --field-selector type=Warning | tail -10

echo ""
echo "=== Disk (control plane) ==="
df -h /data

echo ""
echo "=== HTTP Check ==="
curl -s -o /dev/null -w "HTTP Status: %{http_code}\n" http://localhost
```

**What this does:** Runs a quick sweep of the most important health indicators in one go:
- Node readiness (all 3 nodes should be `Ready`)
- Pod placement — which workloads are on which nodes
- Pod status across all namespaces
- Any pods NOT in `Running`/`Completed` state (problems)
- Recent warning events (Kubernetes logs problems as "Warning" events)
- Disk space on the data volume (control plane)
- HTTP connectivity to the application

---

## Appendix: Useful kubectl Shortcuts

| Shorthand | Full Form | Example |
|-----------|-----------|---------|
| `po` | pods | `kubectl get po -A` |
| `svc` | services | `kubectl get svc -n monitoring` |
| `deploy` | deployments | `kubectl get deploy -n nextjs-app` |
| `ns` | namespaces | `kubectl get ns` |
| `no` | nodes | `kubectl get no -o wide` |
| `-A` | `--all-namespaces` | `kubectl get pods -A` |
| `-n` | `--namespace` | `kubectl get pods -n monitoring` |
| `-o wide` | wide output | `kubectl get pods -o wide` |
| `-o yaml` | YAML output | `kubectl get pod my-pod -o yaml` |
| `-w` | watch mode | `kubectl get pods -w` |
