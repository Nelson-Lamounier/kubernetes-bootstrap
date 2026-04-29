---
title: ArgoCD Cluster Health Verification
type: runbook
tags: [argocd, kubernetes, verification, kubectl, ssm]
sources:
  - argocd-apps/argo-rollouts.yaml
created: 2026-04-28
updated: 2026-04-28
---

# ArgoCD Readiness Verification Guide

A beginner-friendly, step-by-step guide to connecting to your Kubernetes control plane via AWS SSM and verifying that ArgoCD is fully operational.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Key Concepts Before You Start](#key-concepts-before-you-start)
- [Step 1 — Identify Your Control Plane Instance](#step-1--identify-your-control-plane-instance)
- [Step 2 — SSM Into the Control Plane](#step-2--ssm-into-the-control-plane)
- [Step 3 — Verify Kubernetes Cluster Health](#step-3--verify-kubernetes-cluster-health)
- [Step 4 — Check the ArgoCD Namespace and Pods](#step-4--check-the-argocd-namespace-and-pods)
- [Step 5 — Find Crashing or Unhealthy Pods](#step-5--find-crashing-or-unhealthy-pods)
- [Step 6 — Verify ArgoCD Services](#step-6--verify-argocd-services)
- [Step 7 — Test the ArgoCD API Endpoint](#step-7--test-the-argocd-api-endpoint)
- [Step 8 — Check ArgoCD Application Status](#step-8--check-argocd-application-status)
- [Step 9 — Next Steps After Verification](#step-9--next-steps-after-verification)
- [Quick One-Liner Health Check](#quick-one-liner-health-check)
- [Troubleshooting — Common Issues](#troubleshooting--common-issues)
  - [Problem: 404 page not found When Accessing ArgoCD via HTTPS](#problem-404-page-not-found-when-accessing-argocd-via-https)
  - [Problem: Initial Admin Password is Invalid or Secret Not Found](#problem-initial-admin-password-is-invalid-or-secret-not-found)
- [Glossary](#glossary)

---

## Prerequisites

Before following this guide, ensure you have:

- **AWS CLI** installed and configured with a named profile
- **SSM Plugin** for the AWS CLI installed ([installation guide](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html))
- **Network access** to AWS (internet connection)
- Your control plane EC2 instance must have the **SSM Agent** running and an **IAM instance profile** that allows SSM

---

## Key Concepts Before You Start

### What is SSM (AWS Systems Manager Session Manager)?

SSM is a way to securely connect to your EC2 instances **without needing SSH keys or opening port 22**. Think of it like a secure remote desktop terminal — AWS handles the encrypted connection through its own infrastructure. This is safer than SSH because there is no open port on your server for attackers to target.

### What is a Kubernetes Control Plane?

A Kubernetes cluster has two types of machines:

- **Control Plane (Master)** — The "brain" of the cluster. It decides where containers run, monitors health, and manages the desired state of your applications. This is the machine you connect to for running `kubectl` commands.
- **Worker Nodes** — The machines that actually run your application containers.

### What is ArgoCD?

ArgoCD is a **GitOps continuous delivery tool** for Kubernetes. It watches a Git repository for changes and automatically syncs those changes to your Kubernetes cluster. Think of it like an autopilot for deployments: you push code to Git, and ArgoCD makes sure the cluster matches what's in Git.

### What is `kubectl`?

`kubectl` (pronounced "kube-control" or "kube-C-T-L") is the **command-line tool** for interacting with Kubernetes. Every command in this guide uses `kubectl` to ask the cluster questions like "what pods are running?" or "is this service healthy?".

> **Note:** On self-hosted clusters, you typically need `sudo` before `kubectl` because the kubeconfig file (the credentials file) is owned by root.

---

## Step 1 — Identify Your Control Plane Instance

### The Command

```bash
aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=*control*" "Name=instance-state-name,Values=running" \
  --query "Reservations[].Instances[].[InstanceId, Tags[?Key=='Name'].Value | [0]]" \
  --output table \
  --region us-east-1 \
  --profile <your-profile>
```

### What Each Part Does

| Flag / Part | Meaning |
|---|---|
| `aws ec2 describe-instances` | Ask AWS to list your EC2 instances |
| `--filters "Name=tag:Name,Values=*control*"` | Only show instances whose **Name tag** contains the word "control". The `*` is a wildcard (matches anything). Adjust this to match your naming convention. |
| `"Name=instance-state-name,Values=running"` | Only show instances that are currently **running** (not stopped or terminated). |
| `--query "Reservations[].Instances[].[InstanceId, ...]"` | A JMESPath query that extracts just the **Instance ID** and **Name** from the response, instead of showing the entire JSON blob. |
| `--output table` | Display the results as a human-readable table. |
| `--region us-east-1` | The AWS region where your instance lives. Change this to your actual region. |
| `--profile <your-profile>` | The AWS CLI profile to use for authentication. Replace with your profile name. |

### Why You Need This

You need the **Instance ID** (e.g., `i-0abc123def456`) to start an SSM session in the next step. This command finds it for you without having to log into the AWS Console.

---

## Step 2 — SSM Into the Control Plane

### The Command

```bash
aws ssm start-session \
  --target <instance-id> \
  --region us-east-1 \
  --profile <your-profile>
```

### What Each Part Does

| Flag / Part | Meaning |
|---|---|
| `aws ssm start-session` | Start a secure shell session to an EC2 instance through AWS Systems Manager. |
| `--target <instance-id>` | The EC2 Instance ID you found in Step 1 (e.g., `i-0abc123def456`). |
| `--region us-east-1` | Must match the region where the instance is running. |
| `--profile <your-profile>` | Your AWS CLI profile for authentication. |

### Why You Need This

This gives you a **terminal session inside your control plane server**. From here, you can run `kubectl` commands to inspect the cluster. It's the equivalent of "logging into the server."

### What Success Looks Like

```
Starting session with SessionId: your-user-xxxxxxxx
sh-4.2$
```

You now have a shell prompt on the control plane. All remaining steps are run **inside this session**.

---

## Step 3 — Verify Kubernetes Cluster Health

Before checking ArgoCD, you need to confirm that the Kubernetes cluster itself is healthy.

### 3a — Check Node Status

```bash
sudo kubectl get nodes -o wide
```

| Flag | Meaning |
|---|---|
| `sudo` | Run with administrator privileges. Required because the kubeconfig file is typically owned by root on self-hosted clusters. |
| `kubectl get nodes` | List all machines (control plane + workers) registered to the cluster. |
| `-o wide` | Show extra columns like internal IP, OS, kernel version, and container runtime. The `-o` flag stands for **output format**. |

#### Why You Need This

If a node shows `NotReady`, no pods can run on that machine. All nodes **must** show `Ready` for the cluster to be healthy.

#### What Success Looks Like

```
NAME              STATUS   ROLES           AGE   VERSION   INTERNAL-IP    ...
control-plane-1   Ready    control-plane   5d    v1.28.2   10.0.1.100     ...
worker-1          Ready    <none>          5d    v1.28.2   10.0.2.101     ...
```

- **STATUS = Ready** → The node is healthy and accepting workloads
- **STATUS = NotReady** → Something is wrong with this node (network, kubelet service, resources)

---

## Step 4 — Check the ArgoCD Namespace and Pods

### What is a Namespace?

A **namespace** is like a folder inside Kubernetes. It groups related resources together and keeps them isolated. ArgoCD installs all its components into a namespace called `argocd`. Think of it as a dedicated room where all ArgoCD-related things live.

### What is a Pod?

A **pod** is the smallest deployable unit in Kubernetes. It's a wrapper around one or more containers. When you deploy ArgoCD, it creates several pods, each responsible for a different function (API server, repository syncing, etc.).

### 4a — Verify the Namespace Exists

```bash
sudo kubectl get namespace argocd
```

| Part | Meaning |
|---|---|
| `get namespace argocd` | Ask Kubernetes if a namespace named `argocd` exists. |

#### Why You Need This

If the namespace doesn't exist, ArgoCD was never installed (or was deleted). You'd need to install it first.

### 4b — List All ArgoCD Pods

```bash
sudo kubectl get pods -n argocd -o wide
```

| Flag | Meaning |
|---|---|
| `get pods` | List all pods (running containers). |
| `-n argocd` | **`-n` stands for `--namespace`**. It tells kubectl to look only inside the `argocd` namespace. Without this flag, kubectl looks in the `default` namespace, where ArgoCD pods don't live. |
| `-o wide` | Show extra details like the node each pod is running on and its IP. |

#### Why You Need This

This confirms that all ArgoCD components were deployed and are running. If any pod is missing or not in `Running` status, ArgoCD won't work correctly.

#### What Success Looks Like

```
NAME                                               READY   STATUS    RESTARTS   AGE
argocd-application-controller-0                    1/1     Running   0          2d
argocd-applicationset-controller-69dbc8585-xxxxx   1/1     Running   0          2d
argocd-dex-server-76f5f8d7c4-xxxxx                 1/1     Running   0          2d
argocd-notifications-controller-5c4b87db4d-xxxxx   1/1     Running   0          2d
argocd-redis-74cb89f67b-xxxxx                      1/1     Running   0          2d
argocd-repo-server-68444f6b6b-xxxxx                1/1     Running   0          2d
argocd-server-579f659dd5-xxxxx                     1/1     Running   0          2d
```

#### Understanding the Columns

| Column | Meaning |
|---|---|
| **NAME** | The unique name of the pod. The random suffix (e.g., `-xxxxx`) is generated by Kubernetes. |
| **READY** | `1/1` means 1 out of 1 containers in the pod are ready. If you see `0/1`, the container inside is not ready yet. |
| **STATUS** | The pod's lifecycle state. `Running` is healthy. `CrashLoopBackOff`, `Error`, or `Pending` indicate problems. |
| **RESTARTS** | How many times the container has restarted. A high number (e.g. 5+) means the container keeps crashing and Kubernetes keeps restarting it. |
| **AGE** | How long the pod has been running. |

#### What Each ArgoCD Pod Does

| Pod | Responsibility |
|---|---|
| **argocd-server** | The **API and UI server**. Serves the web dashboard and handles API requests (login, sync, etc.). |
| **argocd-repo-server** | **Clones Git repositories** and generates Kubernetes manifests from them. If this pod is down, ArgoCD cannot read your Git repos. |
| **argocd-application-controller** | The **core brain**. Compares the desired state (from Git) with the actual state (in the cluster) and decides what needs to change. |
| **argocd-redis** | An **in-memory cache** used by ArgoCD to store temporary data and improve performance. |
| **argocd-dex-server** | Handles **authentication** via external providers (GitHub, LDAP, OIDC, etc.). |
| **argocd-applicationset-controller** | Manages **ApplicationSets**, which let you create multiple ArgoCD Applications from a single template. |
| **argocd-notifications-controller** | Sends **notifications** (Slack, email, webhooks) when application sync events occur. |

---

## Step 5 — Find Crashing or Unhealthy Pods

### 5a — Filter for Non-Running Pods

```bash
sudo kubectl get pods -n argocd --field-selector=status.phase!=Running
```

| Flag | Meaning |
|---|---|
| `--field-selector=status.phase!=Running` | This is a **field selector** — a filter that tells Kubernetes to only return pods whose `status.phase` field is **NOT equal to** (`!=`) `Running`. |

#### Breaking Down `--field-selector`

- **`--field-selector`** is a way to filter Kubernetes resources by their **internal fields** (not labels). Think of it as a WHERE clause in SQL.
- **`status.phase`** is a built-in field on every pod that indicates its lifecycle phase.
- **`!=Running`** means "not equal to Running."

So this command says: *"Show me only pods that are NOT in the Running phase"* — which reveals any pods that are broken, pending, or crashing.

#### Possible Pod Phases

| Phase | Meaning |
|---|---|
| `Pending` | The pod has been accepted but containers aren't running yet (may be pulling images or waiting for resources). |
| `Running` | The pod is healthy and all containers are active. |
| `Succeeded` | All containers completed successfully (common for Jobs). |
| `Failed` | All containers terminated and at least one failed. |
| `Unknown` | The pod state can't be determined (usually a node communication issue). |

#### What Success Looks Like

If all pods are healthy, you get:

```
No resources found in argocd namespace.
```

This is **good** — it means there are no unhealthy pods.

### 5b — Check Logs of a Specific Pod

If a pod is unhealthy, inspect its logs:

```bash
sudo kubectl logs <pod-name> -n argocd --tail=50
```

| Flag | Meaning |
|---|---|
| `logs <pod-name>` | Show the console output (stdout/stderr) from a specific pod. Replace `<pod-name>` with the actual pod name from the previous step. |
| `-n argocd` | Look in the `argocd` namespace. |
| `--tail=50` | Only show the **last 50 lines** of logs. Without this, you'd get the entire log history, which can be thousands of lines. |

#### Why You Need This

Logs tell you **what went wrong** inside the container. Common errors include:
- Out of memory
- Cannot connect to Redis
- Failed to clone Git repository
- TLS certificate errors

### 5c — Check Kubernetes Events

```bash
sudo kubectl get events -n argocd --sort-by='.lastTimestamp' | tail -20
```

| Flag | Meaning |
|---|---|
| `get events` | List **events** — these are Kubernetes' internal activity log. Events record things like "pod started", "image pulled", "container crashed", "node out of disk." |
| `-n argocd` | Only show events in the `argocd` namespace. |
| `--sort-by='.lastTimestamp'` | Sort events by when they last occurred, so the most recent events appear at the bottom. The `.lastTimestamp` refers to a field inside the event object. |
| `\| tail -20` | Pipe the output to the `tail` command, which shows only the **last 20 lines**. This filters out old, irrelevant events. |

#### Why You Need This

Events provide **cluster-level context** that pod logs don't. For example:
- *"Failed to pull image"* — the container image doesn't exist or credentials are wrong
- *"Insufficient memory"* — the node doesn't have enough RAM for the pod
- *"FailedScheduling"* — no node can accept this pod (resource constraints or taints)

---

## Step 6 — Verify ArgoCD Services

### What is a Service (`svc`)?

A **Service** (abbreviated `svc` in kubectl) is a networking abstraction in Kubernetes. Pods get random IP addresses and can be created/destroyed at any time, so you can't rely on a pod's IP address. A Service provides a **stable IP and DNS name** that routes traffic to the correct pods, no matter how many times they restart.

Think of it like a phone number that always reaches the right person, even if they change desks.

### 6a — List ArgoCD Services

```bash
sudo kubectl get svc -n argocd
```

| Flag | Meaning |
|---|---|
| `get svc` | List all Services. `svc` is the **shorthand** for `service`. You could also type `get services` — they are identical. |
| `-n argocd` | Look in the `argocd` namespace. |

#### Why You Need This

Without a Service, nothing can talk to ArgoCD — not the web UI, not the CLI, not the API. You need to confirm the Services exist and have a valid ClusterIP.

#### What Success Looks Like

```
NAME                               TYPE        CLUSTER-IP      EXTERNAL-IP   PORT(S)
argocd-applicationset-controller   ClusterIP   10.96.10.100    <none>        7000/TCP
argocd-dex-server                  ClusterIP   10.96.10.101    <none>        5556/TCP,5557/TCP
argocd-redis                       ClusterIP   10.96.10.102    <none>        6379/TCP
argocd-repo-server                 ClusterIP   10.96.10.103    <none>        8081/TCP
argocd-server                      ClusterIP   10.96.10.104    <none>        80/TCP,443/TCP
```

#### Understanding Service Types

| Type | Meaning |
|---|---|
| **ClusterIP** | The Service is only accessible **inside** the cluster. This is the default. |
| **NodePort** | The Service is accessible on a specific port on every node's IP address. |
| **LoadBalancer** | AWS (or your cloud provider) creates a load balancer to expose the Service externally. |

### 6b — Get Detailed Info About the ArgoCD Server Service

```bash
sudo kubectl describe svc argocd-server -n argocd
```

| Flag | Meaning |
|---|---|
| `describe svc argocd-server` | Show **detailed information** about the `argocd-server` service, including endpoints (the actual pod IPs it routes to), ports, labels, and selectors. |

#### Why You Need This

`describe` gives you much more detail than `get`. Critically, it shows you the **Endpoints** field — the actual pod IPs the service routes traffic to. If Endpoints shows `<none>`, the service has no healthy pods to route to, and ArgoCD's API/UI will be unreachable.

#### What the Output Looks Like

```
Name:                     argocd-server
Namespace:                argocd
Labels:                   app.kubernetes.io/component=server
                          app.kubernetes.io/name=argocd-server
                          app.kubernetes.io/part-of=argocd
Annotations:              <none>
Selector:                 app.kubernetes.io/name=argocd-server
Type:                     ClusterIP
IP Family Policy:         SingleStack
IP Families:              IPv4
IP:                       10.99.110.134
IPs:                      10.99.110.134
Port:                     http  80/TCP
TargetPort:               8080/TCP
Endpoints:                192.168.101.8:8080
Port:                     https  443/TCP
TargetPort:               8080/TCP
Endpoints:                192.168.101.8:8080
Session Affinity:         None
Internal Traffic Policy:  Cluster
Events:                   <none>
```

#### Understanding Every Field in the Output

| Field | Meaning |
|---|---|
| **Name** | The name of the Service (`argocd-server`). |
| **Namespace** | Which namespace this Service lives in (`argocd`). |
| **Labels** | Key-value pairs attached to the Service for identification. These are metadata tags — like stickers on a folder — that help organize and select resources. For example, `app.kubernetes.io/component=server` tells you this is the "server" component of ArgoCD. |
| **Annotations** | Additional metadata for tools and integrations (e.g., Prometheus scraping config). `<none>` means no annotations are set. |
| **Selector** | **This is critical.** The Selector defines **which pods this Service routes traffic to**. It works like a filter: the Service finds all pods whose labels match `app.kubernetes.io/name=argocd-server` and sends traffic to them. If no pods match the selector, the Endpoints field will show `<none>` and the Service won't route anywhere. |
| **Type** | The Service type. `ClusterIP` means it's only accessible inside the cluster (see the Service Types table above). |
| **IP Family Policy** | Whether the Service uses IPv4, IPv6, or both. `SingleStack` means IPv4 only. |
| **IP / IPs** | The **ClusterIP** address assigned to this Service (`10.99.110.134`). This is the stable internal IP that other pods use to reach ArgoCD. |
| **Port** | The port the Service **listens on**. This Service listens on port `80` (HTTP) and port `443` (HTTPS). |
| **TargetPort** | The port on the **actual pod** where traffic is forwarded to. Even though the Service listens on `80` and `443`, it forwards all traffic to port `8080` on the ArgoCD server pod. This is because the ArgoCD server application internally runs on port `8080`. Think of it as: *"the front door is port 443, but inside the building the office is on floor 8080."* |
| **Endpoints** | The actual **pod IP addresses** the Service is forwarding traffic to. `192.168.101.8:8080` means there is one healthy pod receiving traffic. If this shows `<none>`, the Service cannot find any matching pods — this is a clear sign something is broken. |
| **Session Affinity** | Whether repeated requests from the same client are always sent to the same pod. `None` means traffic is distributed across pods (round-robin). |
| **Internal Traffic Policy** | How traffic from within the cluster is handled. `Cluster` means any pod in the cluster can reach this Service. |
| **Events** | Recent events related to this Service. `<none>` means no issues have been recorded. |

---

## Step 7 — Test the ArgoCD API Endpoint

### What is the ArgoCD API Endpoint?

The **ArgoCD API endpoint** is the URL where ArgoCD's server listens for requests. It's the same address that:

- The **ArgoCD web UI** (dashboard) loads from
- The **ArgoCD CLI** (`argocd` command) communicates with
- **CI/CD pipelines** use to trigger syncs, check application health, and create API tokens

If this endpoint is unreachable, you cannot use ArgoCD at all — no UI, no CLI, no automated deployments.

### 7a — Test via ClusterIP (Recommended for SSM Sessions)

```bash
# Get the ClusterIP of the argocd-server service
ARGOCD_IP=$(sudo kubectl get svc argocd-server -n argocd -o jsonpath='{.spec.clusterIP}')

# Test the API
curl -sk https://$ARGOCD_IP/api/version
```

| Part | Meaning |
|---|---|
| `$(sudo kubectl get svc argocd-server -n argocd -o jsonpath='{.spec.clusterIP}')` | This is **command substitution**. It runs the kubectl command, extracts just the ClusterIP address using JSONPath, and stores it in the variable `ARGOCD_IP`. |
| `-o jsonpath='{.spec.clusterIP}'` | **JSONPath** output format — instead of a table, extract a single specific field from the JSON response. `.spec.clusterIP` navigates to the Service's cluster IP address. |
| `curl` | A command-line tool for making HTTP requests. Think of it as a text-based web browser. |
| `-s` | **Silent mode** — suppresses the progress bar and extra output. |
| `-k` | **Insecure mode** — skip TLS certificate verification. Necessary because ArgoCD uses a self-signed certificate by default, which `curl` would otherwise reject. |
| `https://$ARGOCD_IP/api/version` | The URL to request. `/api/version` is a simple health-check endpoint on ArgoCD that returns version information. |

#### Why You Need This

This is the **definitive test** that ArgoCD is working. If this call returns a valid JSON response, it means:

1. The ArgoCD server pod is running
2. The Kubernetes Service is correctly routing traffic to it
3. The ArgoCD API is accepting requests

#### What Success Looks Like

```json
{
  "Version": "v2.10.0",
  "BuildDate": "2024-01-20T15:30:00Z",
  "GoVersion": "go1.21.5",
  "Compiler": "gc",
  "Platform": "linux/amd64"
}
```

#### What Failure Looks Like

```
curl: (7) Failed to connect to 10.96.10.104 port 443: Connection refused
```

This means either the pod isn't running or the Service isn't routing correctly. Go back to Steps 4 and 5 to investigate.

### 7b — Alternative: Test via Port-Forward

Port-forwarding creates a secure tunnel from your local machine (or the control plane node you're SSM'd into) directly to the ArgoCD Service in the cluster. This is useful when you want to interact with the ArgoCD UI or API from outside the cluster network.

> **Note:** This process runs in the foreground and occupies your terminal. You'll need a **second terminal** (or a second SSM session) to run the `curl` test.

**Terminal 1 — Start the tunnel:**

```bash
sudo kubectl port-forward svc/argocd-server -n argocd 8080:443
```

Leave this running. It will show:

```
Forwarding from 127.0.0.1:8080 -> 8080
Forwarding from [::1]:8080 -> 8080
```

**Terminal 2 — Test the API:**

```bash
curl -sk https://localhost:8080/api/version
```

When finished, go back to Terminal 1 and press `Ctrl+C` to stop the tunnel.

| Part | Meaning |
|---|---|
| `port-forward svc/argocd-server` | Create a **tunnel** from a local port to the Service inside the cluster. `svc/argocd-server` means "the Service named argocd-server." |
| `8080:443` | Map **local port 8080** to the **Service's port 443**. So requests to `localhost:8080` are forwarded to the ArgoCD server. |
| `-k` | Skip TLS certificate verification (ArgoCD uses a self-signed certificate by default). |

### 7c — Alternative: Test From Inside the Cluster (Debug Pod)

This method tests the endpoint **exactly how other pods and internal services see it**. It's useful for confirming that cluster-internal networking works correctly, independent of port-forwarding.

#### What is a Debug Pod?

A **debug pod** is a temporary, throwaway container you create just for troubleshooting. You launch it, run your diagnostic commands, then it cleans itself up. Think of it as a disposable toolbox you bring into the cluster, use, and then throw away.

#### Launch the Debug Pod

```bash
sudo kubectl run -i --tty --rm debug-curl --image=curlimages/curl --restart=Never -- sh
```

| Flag | Meaning |
|---|---|
| `run` | Create and start a new pod. |
| `-i` | **Interactive** — keep stdin (standard input) open so you can type commands. |
| `--tty` | Allocate a **TTY** (terminal). Together with `-i`, this gives you an interactive shell session inside the pod. |
| `--rm` | **Remove** the pod automatically when you exit. Without this, the pod would remain in a `Completed` state and you'd have to manually delete it later. |
| `debug-curl` | The name of the temporary pod. You can name it anything. |
| `--image=curlimages/curl` | The container image to use. `curlimages/curl` is a lightweight image (~5MB) that has `curl` pre-installed. It's commonly used for network debugging. |
| `--restart=Never` | Tell Kubernetes **not to restart** this pod if it exits. Without this, Kubernetes would treat it as a long-running service and keep restarting it. |
| `-- sh` | The command to run inside the container. `sh` starts a shell session. Everything after `--` is passed to the container as its command. |

#### Test Using the ClusterIP

Once inside the debug pod's shell, test the ArgoCD API using the ClusterIP from Step 6:

```bash
curl -k https://10.99.110.134/api/version
```

#### Test Using Internal Kubernetes DNS

```bash
curl -k https://argocd-server.argocd.svc.cluster.local/api/version
```

#### What is Internal Kubernetes DNS?

Every Service in Kubernetes automatically gets a **DNS name** that follows this pattern:

```
<service-name>.<namespace>.svc.cluster.local
```

Breaking it down:

| Part | Meaning |
|---|---|
| `argocd-server` | The name of the Service. |
| `argocd` | The namespace the Service lives in. |
| `svc` | Short for "service" — tells DNS this is a Service record. |
| `cluster.local` | The default domain for the Kubernetes cluster's internal DNS. |

So `argocd-server.argocd.svc.cluster.local` resolves to the ClusterIP `10.99.110.134`. This DNS name is **more reliable** than using the IP directly because the ClusterIP could change if the Service is deleted and recreated, but the DNS name always resolves to the current IP.

> **Why use DNS over ClusterIP?** The ClusterIP is assigned when the Service is created. If you delete and recreate the Service, it gets a **new** ClusterIP. But the DNS name always resolves to whatever the current ClusterIP is. This is why applications inside Kubernetes should always use DNS names, not hardcoded IPs.

#### Exit the Debug Pod

```bash
exit
```

Because you used the `--rm` flag, the debug pod automatically deletes itself when you exit. You can verify it's gone with:

```bash
sudo kubectl get pods | grep debug-curl
```

This should return no results.

---

## Step 8 — Check ArgoCD Application Status

> **Note:** This step only applies if you've already created ArgoCD Applications (the custom resources that tell ArgoCD which Git repos to watch).

### 8a — List All Applications

```bash
sudo kubectl get applications -n argocd
```

| Part | Meaning |
|---|---|
| `get applications` | List ArgoCD Application resources. An "Application" in ArgoCD is a custom resource that defines which Git repo to watch and where to deploy. |
| `-n argocd` | Applications are stored in the `argocd` namespace. |

#### What Success Looks Like

```
NAME        SYNC STATUS   HEALTH STATUS
my-app      Synced        Healthy
```

| Column | Meaning |
|---|---|
| **SYNC STATUS** | Whether the cluster matches what's in Git. `Synced` = cluster matches Git. `OutOfSync` = there are differences. |
| **HEALTH STATUS** | Whether the deployed application is healthy. `Healthy` = all resources are running. `Degraded` = something is wrong. `Progressing` = changes are being applied. |

### 8b — Get Detailed Application Info

```bash
sudo kubectl get applications -n argocd -o wide
```

The `-o wide` flag adds extra columns showing the Git repository URL, target revision, and destination namespace.

---

## Step 9 — Next Steps After Verification

Once all ArgoCD pods are running and the API responds successfully, there are three things to do next: access the ArgoCD UI, verify the ArgoCD CLI is available, and confirm the prerequisites for your CI/CD pipeline.

### 9a — Access the ArgoCD UI

The **ArgoCD UI** is a web dashboard where you can visually see all your Applications, their sync status, health, and Git source. It's the most intuitive way to interact with ArgoCD.

#### How to Access It

ArgoCD is exposed through **Traefik** (the ingress controller) on your control plane's **Elastic IP (EIP)**. The URL follows this pattern:

```
http://<EIP>/argocd
```

To find your EIP, run this from your local machine (not inside SSM):

```bash
aws ssm get-parameter \
  --name "/k8s/development/elastic-ip" \
  --query 'Parameter.Value' --output text \
  --region eu-west-1 \
  --profile <your-profile>
```

Then open `http://<EIP>/argocd` in your browser.

#### Verify the IngressRoute Exists

If the UI doesn't load, check that the Traefik IngressRoute is configured. From inside the SSM session:

```bash
sudo kubectl get ingressroute -n argocd
```

| Part | Meaning |
|---|---|
| `get ingressroute` | List IngressRoute resources. An **IngressRoute** is a Traefik-specific custom resource that defines how external HTTP/HTTPS traffic is routed to a Service inside the cluster. It's Traefik's equivalent of a Kubernetes Ingress. |
| `-n argocd` | Look in the `argocd` namespace. |

If no IngressRoute exists, ArgoCD won't be reachable from outside the cluster.

#### Log Into the UI

The default credentials are:

- **Username:** `admin`
- **Password:** Stored in a Kubernetes secret. Retrieve it with:

```bash
sudo kubectl get secret argocd-initial-admin-secret -n argocd -o jsonpath='{.data.password}' | base64 -d
```

| Part | Meaning |
|---|---|
| `get secret argocd-initial-admin-secret` | Retrieve the Kubernetes Secret named `argocd-initial-admin-secret`. A **Secret** is a Kubernetes resource that stores sensitive data (passwords, tokens, certificates) in base64 encoding. |
| `-o jsonpath='{.data.password}'` | Extract only the `password` field from the Secret. |
| `\| base64 -d` | **Decode** the base64-encoded password into plain text. Kubernetes Secrets store values in base64, so you need to decode them to read the actual password. |

> **Note:** After your first login, it's recommended to change the admin password or set up SSO (Single Sign-On) via the `argocd-dex-server`.

> [!TIP]
> If the initial admin secret doesn't exist or the password it returns
> doesn't work, see [Problem: Initial Admin Password is Invalid or
> Secret Not Found](#problem-initial-admin-password-is-invalid-or-secret-not-found)
> in the Troubleshooting section below.

### 9b — Check if the ArgoCD CLI is Installed

The **ArgoCD CLI** is an optional command-line tool for interacting with ArgoCD. It's useful for logging in, generating tokens, and triggering syncs from scripts or CI/CD pipelines.

```bash
argocd version
```

- **If installed:** You'll see version output like `argocd: v2.10.0+abc1234`
- **If not installed:** You'll see `command not found`

#### You Don't Strictly Need the CLI

Everything the CLI does can also be done via:

1. **`kubectl`** — Manage ArgoCD Applications as Kubernetes resources
2. **The ArgoCD API** — Using `curl` (as tested in Step 7)
3. **The ArgoCD Web UI** — Visual dashboard (Step 9a)

#### Installing the CLI (If Needed)

```bash
sudo curl -sSL -o /usr/local/bin/argocd \
  https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64

sudo chmod +x /usr/local/bin/argocd

argocd version --client
```

| Part | Meaning |
|---|---|
| `curl -sSL -o /usr/local/bin/argocd` | Download the ArgoCD CLI binary silently (`-sS`), follow redirects (`-L`), and save it to `/usr/local/bin/argocd` (`-o`). |
| `chmod +x` | Make the binary **executable**. Without this, the system won't let you run it. |
| `--client` | Show only the CLI version without trying to connect to an ArgoCD server. |

### 9c — Verify CI/CD Pipeline Prerequisites

Before running the GitOps pipeline (`gitops-k8s-dev.yml`), confirm these prerequisites are in place:

| Prerequisite | Verification Command | What It Does |
|---|---|---|
| **SSH deploy key** | `sudo kubectl get secret -n argocd \| grep repo` | ArgoCD needs this key to **clone your Git repository**. Without it, ArgoCD cannot read your Helm charts or manifests. |
| **App-of-Apps root Application** | `sudo kubectl get applications -n argocd` | The pipeline checks sync status of child Applications (`nextjs`, `traefik`, etc.). These must exist first. |
| **CI bot token in Secrets Manager** | `aws secretsmanager get-secret-value --secret-id "k8s/development/argocd-ci-token" --region eu-west-1` | The pipeline uses this token to **authenticate with the ArgoCD API** and check sync status. |
| **EIP stored in SSM** | `aws ssm get-parameter --name "/k8s/development/elastic-ip" --region eu-west-1` | The pipeline reads this to know **where to reach ArgoCD** from GitHub Actions. |

#### Recommended Order

1. Access the ArgoCD UI and log in (9a)
2. Verify the SSH deploy key is configured
3. Check if ArgoCD Applications exist
4. Confirm the CI bot token is in Secrets Manager
5. **Then** run the pipeline — either via `workflow_dispatch` (manual trigger) or by pushing to a watched path

---

## Quick One-Liner Health Check

Use this single command to get a rapid overview of everything:

```bash
echo "=== NODES ===" && \
sudo kubectl get nodes && \
echo -e "\n=== ARGOCD PODS ===" && \
sudo kubectl get pods -n argocd && \
echo -e "\n=== ARGOCD SERVICES ===" && \
sudo kubectl get svc -n argocd && \
echo -e "\n=== RECENT EVENTS ===" && \
sudo kubectl get events -n argocd --sort-by='.lastTimestamp' | tail -10
```

| Part | Meaning |
|---|---|
| `echo "=== NODES ==="` | Print a section header so the output is easy to read. |
| `&&` | Run the next command **only if the previous one succeeded**. This chains the commands together. |
| `echo -e "\n..."` | Print a header with a blank line before it (`\n` = newline). The `-e` flag enables escape character interpretation. |

---

## Troubleshooting — Common Issues

### Problem: `404 page not found` When Accessing ArgoCD via HTTPS

#### Symptoms

```bash
# HTTP request gets a redirect
curl http://<EIP>/argocd
# Returns: <a href="https://<EIP>/argocd">Temporary Redirect</a>

# Following the HTTPS redirect gives a 404
curl -k https://<EIP>/argocd
# Returns: 404 page not found
```

You can reach ArgoCD via HTTP, but the server immediately redirects to HTTPS, and then you get a 404.

#### Root Cause

This happens because of a **mismatch between how Traefik and ArgoCD are configured**. Here's what's going on step by step:

1. Your IngressRoute is configured with `entryPoints: [web]`, which means it **only listens on the `web` entrypoint** (HTTP / port 80).
2. When a request arrives at `http://<EIP>/argocd`, Traefik matches the IngressRoute and forwards it to ArgoCD.
3. ArgoCD's server, by default, **redirects all HTTP requests to HTTPS** (a `307 Temporary Redirect`).
4. Your browser or curl follows the redirect to `https://<EIP>/argocd`.
5. This HTTPS request arrives at Traefik on the **`websecure` entrypoint** (port 443).
6. But there is **no IngressRoute listening on `websecure`** for `/argocd`, so Traefik returns **404 page not found**.

#### Traffic Flow (What Happens)

```
Browser → http://<EIP>/argocd
  → Traefik (web entrypoint, port 80)
    → IngressRoute matches PathPrefix('/argocd') ✅
      → ArgoCD server receives request
        → ArgoCD returns 307 Redirect → https://<EIP>/argocd

Browser follows redirect → https://<EIP>/argocd
  → Traefik (websecure entrypoint, port 443)
    → No IngressRoute matches ❌
      → Traefik returns 404 page not found
```

#### What is an `entryPoint`?

In Traefik, an **entryPoint** defines a network listener — a port where Traefik accepts incoming connections. The two standard entrypoints are:

| EntryPoint | Protocol | Port | Description |
|---|---|---|---|
| `web` | HTTP | 80 | Unencrypted traffic |
| `websecure` | HTTPS | 443 | TLS-encrypted traffic |

An IngressRoute must specify which entrypoint(s) it listens on. If yours only has `web`, it will never match HTTPS requests.

#### The Fix — Disable ArgoCD's HTTPS Redirect

Instead of adding a second IngressRoute for `websecure` (which requires TLS certificates), the simplest fix is to tell ArgoCD to **stop redirecting to HTTPS** and serve the UI over plain HTTP. You do this by setting two values in the `argocd-cmd-params-cm` ConfigMap.

##### What is a ConfigMap?

A **ConfigMap** is a Kubernetes resource that stores configuration data as key-value pairs. Applications running in pods read these values to configure themselves. The `argocd-cmd-params-cm` ConfigMap is specifically where ArgoCD looks for server configuration overrides.

##### Step 1 — Patch the ConfigMap

```bash
sudo kubectl patch configmap argocd-cmd-params-cm -n argocd --type merge \
  -p '{"data":{"server.insecure":"true","server.rootpath":"/argocd"}}"
```

| Part | Meaning |
|---|---|
| `patch configmap argocd-cmd-params-cm` | Modify the existing ConfigMap named `argocd-cmd-params-cm` without replacing the entire resource. |
| `--type merge` | Use a **merge patch** strategy — only the fields you specify are updated; everything else is left unchanged. |
| `-p '{"data":{...}}'` | The patch payload in JSON format. |
| `server.insecure: "true"` | Tells ArgoCD to **serve HTTP** instead of redirecting to HTTPS. ArgoCD will no longer require TLS — Traefik handles the connection instead. |
| `server.rootpath: "/argocd"` | Tells ArgoCD that its UI and API live under the `/argocd` path, not `/`. Without this, ArgoCD won't generate correct URLs for its assets (CSS, JavaScript, API calls). |

##### Step 2 — Restart the ArgoCD Server

ConfigMap changes are **not automatically picked up** by running pods. You need to restart the ArgoCD server deployment:

```bash
sudo kubectl rollout restart deployment argocd-server -n argocd
```

| Part | Meaning |
|---|---|
| `rollout restart` | Tell Kubernetes to perform a **rolling restart** of the deployment — it creates new pods with the updated config and gracefully terminates the old ones. No downtime. |
| `deployment argocd-server` | The ArgoCD server deployment to restart. |

##### Step 3 — Wait for the Rollout to Complete

```bash
sudo kubectl rollout status deployment argocd-server -n argocd --timeout=60s
```

| Part | Meaning |
|---|---|
| `rollout status` | Watch the rollout progress and wait until the new pod is ready. |
| `--timeout=60s` | Give up waiting after 60 seconds. If the pod fails to start, this prevents the command from hanging forever. |

##### Step 4 — Test the Fix

From your local machine:

```bash
curl -s http://<EIP>/argocd/api/version
```

Expected response:

```json
{"Version":"v3.3.2"}
```

Then open `http://<EIP>/argocd` in your browser — the ArgoCD login page should appear without any HTTPS redirect.

##### Why This Works

```
Browser → http://<EIP>/argocd
  → Traefik (web entrypoint, port 80)
    → IngressRoute matches PathPrefix('/argocd') ✅
      → ArgoCD server receives request
        → server.insecure=true → serves HTTP directly (no redirect) ✅
        → server.rootpath=/argocd → UI assets load correctly ✅
          → ArgoCD login page is returned
```

##### Verify the ConfigMap Was Applied

To confirm the settings are in place:

```bash
sudo kubectl get configmap argocd-cmd-params-cm -n argocd -o yaml
```

You should see under `data:`:

```yaml
data:
  server.insecure: "true"
  server.rootpath: /argocd
```

---

### Problem: Initial Admin Password is Invalid or Secret Not Found

#### Symptoms

You try to retrieve the ArgoCD admin password:

```bash
sudo kubectl get secret argocd-initial-admin-secret -n argocd \
  -o jsonpath='{.data.password}' | base64 -d
```

And one of the following happens:

- The secret **doesn't exist**: `Error from server (NotFound): secrets "argocd-initial-admin-secret" not found`
- The secret exists but the **password is rejected** by the ArgoCD login page
- You deleted the secret and restarted ArgoCD, but it **was not regenerated**

#### Root Cause

ArgoCD creates the `argocd-initial-admin-secret` only **once** during the very first installation. This is important to understand:

| Scenario | What Happens |
| --- | --- |
| Fresh install | ArgoCD auto-generates the secret with a random password |
| Password changed via UI or CLI | The secret is **not updated** — it still holds the original password, which is now stale |
| Secret manually deleted | ArgoCD v2.4+ does **not** regenerate it on restart |
| ArgoCD server restarted | The secret is **not** regenerated — the password hash is stored internally in `argocd-secret` |

The actual admin password is stored as a **bcrypt hash** inside the `argocd-secret` Secret (not `argocd-initial-admin-secret`). The `argocd-initial-admin-secret` is just a convenience copy.

#### Fix — Reset the Admin Password via bcrypt

Since the control plane node may not have `bcrypt` or `htpasswd` installed, generate the password hash inside a temporary container in the cluster.

##### Step 1 — Generate a bcrypt hash

Run this command to generate a bcrypt hash for your new password. Replace `YourNewPassword123!` with your desired password:

```bash
sudo kubectl run bcrypt-gen --rm -i --restart=Never \
  --image=python:3.12-alpine -- \
  sh -c 'pip install -q bcrypt 2>&1 >/dev/null && python3 -c "import bcrypt; print(bcrypt.hashpw(b\"YourNewPassword123!\", bcrypt.gensalt()).decode())"'
```

| Part | Meaning |
| --- | --- |
| `kubectl run bcrypt-gen` | Create a temporary pod named `bcrypt-gen` |
| `--rm -i` | Delete the pod when done (`--rm`) and keep stdin open (`-i`) to capture output |
| `--restart=Never` | Don't restart the pod when it finishes (one-shot execution) |
| `--image=python:3.12-alpine` | Use a lightweight Python image that can install `bcrypt` |
| `pip install -q bcrypt` | Install the bcrypt library quietly |
| `bcrypt.hashpw(...)` | Generate a bcrypt hash of your password with a random salt |

This will print a hash string that looks like:

```
$2b$12$aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789AbCdEfGhIjKl
```

**Copy this entire hash string** — you'll need it in Step 2.

##### Step 2 — Patch the ArgoCD Secret

Paste the hash from Step 1 into this command (replacing `<PASTE_HASH_HERE>`):

```bash
sudo kubectl -n argocd patch secret argocd-secret \
  -p '{"stringData": {"admin.password": "<PASTE_HASH_HERE>", "admin.passwordMtime": "2026-03-04T05:00:00Z"}}'
```

| Part | Meaning |
| --- | --- |
| `patch secret argocd-secret` | Modify the `argocd-secret` — this is where ArgoCD stores the **actual** admin password hash (not `argocd-initial-admin-secret`) |
| `stringData` | Tells Kubernetes to accept **plain text** values and automatically base64-encode them before storing. This avoids you having to manually encode the hash. |
| `admin.password` | The field that stores the bcrypt hash of the admin password |
| `admin.passwordMtime` | The timestamp of when the password was last changed. ArgoCD uses this to invalidate existing sessions. Set to the current date/time. |

> [!IMPORTANT]
> You must do this in **two separate steps** (generate hash, then paste).
> Combining them into a single command often fails because the hash
> contains `$` characters that the shell interprets as variable
> references, corrupting the JSON payload.

##### Step 3 — Restart the ArgoCD Server

```bash
sudo kubectl rollout restart deployment argocd-server -n argocd
```

Wait for the rollout to complete:

```bash
sudo kubectl rollout status deployment argocd-server -n argocd --timeout=60s
```

##### Step 4 — Test the New Password

Log in via the ArgoCD UI at `http://<EIP>/argocd` with:

- **Username:** `admin`
- **Password:** The plain-text password you chose in Step 1 (e.g., `YourNewPassword123!`)

Or test via the API:

```bash
curl -s http://<EIP>/argocd/api/v1/session \
  -d '{"username": "admin", "password": "YourNewPassword123!"}'
```

#### What Success Looks Like

The API returns a JSON object containing a JWT token:

```json
{"token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."}
```

If it returns `{"error":"Invalid username or password","code":16}`, the hash was not applied correctly — repeat from Step 1.

#### Why Deleting the Secret Doesn't Work

A common troubleshooting attempt is to delete `argocd-initial-admin-secret` and restart the server, expecting ArgoCD to create a new one:

```bash
# This does NOT work on ArgoCD v2.4+
sudo kubectl delete secret argocd-initial-admin-secret -n argocd
sudo kubectl rollout restart deployment argocd-server -n argocd
# Secret is NOT regenerated
```

This approach worked in ArgoCD v2.3 and earlier, but **v2.4+ changed the behavior**. The initial admin secret is only generated during the first `argocd-server` startup when no `admin.password` field exists in `argocd-secret`. Since the `argocd-secret` already has a password hash (set during original install), the server skips initial password generation entirely.

The only reliable approach is to patch `argocd-secret` directly with a new bcrypt hash, as shown above.

> [!NOTE]
> **Resolved.** After patching `argocd-secret` with a new bcrypt hash
> and restarting the ArgoCD server, the admin login works with the
> new password.

---

## Glossary

| Term | Definition |
|---|---|
| **SSM** | AWS Systems Manager Session Manager — a secure way to get shell access to EC2 instances without SSH. |
| **Control Plane** | The set of Kubernetes components that manage the cluster (API server, scheduler, controller manager, etcd). |
| **Node** | A machine (physical or virtual) in a Kubernetes cluster. |
| **Namespace** | A logical grouping mechanism in Kubernetes, like a folder for resources. Specified with `-n` flag. |
| **Pod** | The smallest deployable unit in Kubernetes; wraps one or more containers. |
| **Service (svc)** | A stable network endpoint that routes traffic to pods. Pods come and go, but Services provide a fixed address. |
| **ClusterIP** | A type of Service only accessible within the cluster. |
| **kubectl** | The CLI tool for interacting with Kubernetes. |
| **Field Selector** | A filter (`--field-selector`) for querying Kubernetes resources by their built-in fields. |
| **API Endpoint** | A URL where a server listens for requests. ArgoCD's API endpoint serves both the UI and programmatic access. |
| **GitOps** | A methodology where Git is the single source of truth for infrastructure and application config. |
| **CrashLoopBackOff** | A pod status indicating the container keeps crashing and Kubernetes is waiting before restarting it again. |
| **Events** | Kubernetes' internal activity log that records scheduling decisions, errors, and state changes. |
| **JSONPath** | A query language for extracting specific fields from JSON data, used with `-o jsonpath=`. |
| **Port-Forward** | A kubectl feature that creates a tunnel from your local machine to a pod or service inside the cluster. |
| **TargetPort** | The port on the actual pod container that the Service forwards traffic to (may differ from the Service's own port). |
| **Endpoints** | The real pod IP:port pairs that a Service routes traffic to. Shows which pods are actively receiving traffic. |
| **Selector** | A label-based filter on a Service that determines which pods receive its traffic. |
| **Internal DNS** | Kubernetes automatically creates DNS records for Services in the format `<service>.<namespace>.svc.cluster.local`. |
| **Debug Pod** | A temporary, throwaway pod used for troubleshooting networking or other issues inside the cluster. |
| **IngressRoute** | A Traefik-specific custom resource that defines how external traffic is routed to a Service inside Kubernetes. |
| **Secret** | A Kubernetes resource for storing sensitive data (passwords, tokens) in base64 encoding. |
| **EIP (Elastic IP)** | A static public IP address from AWS that stays the same even if the underlying EC2 instance is stopped and restarted. |
| **Deploy Key** | An SSH key that grants read-only (or read-write) access to a specific Git repository. ArgoCD uses this to clone your repo. |
| **App-of-Apps** | An ArgoCD pattern where one root Application manages multiple child Applications, enabling centralized control. |
| **EntryPoint** | A Traefik network listener defined by protocol and port (e.g., `web` = HTTP/80, `websecure` = HTTPS/443). IngressRoutes must specify which entrypoint(s) they listen on. |
| **ConfigMap** | A Kubernetes resource that stores non-sensitive configuration data as key-value pairs. Pods read ConfigMaps to configure applications. |
| **rootpath** | An ArgoCD server setting (`server.rootpath`) that tells ArgoCD its UI is served under a sub-path (e.g., `/argocd`) rather than the root `/`. |
