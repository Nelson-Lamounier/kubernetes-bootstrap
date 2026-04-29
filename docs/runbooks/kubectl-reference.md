---
title: kubectl Operations Reference
type: runbook
tags: [kubectl, kubernetes, argocd, argo-rollouts, operations, reference]
sources:
  - argocd-apps/argo-rollouts.yaml
created: 2026-04-28
updated: 2026-04-28
---

# kubectl Operations Reference

Practical kubectl command reference tailored to this project's
ArgoCD-managed K8s cluster. Each section explains **what**, **when**,
and **why** — not just the syntax.

---

## Table of Contents

1. [Core Concepts](#1-core-concepts)
2. [Inspecting Resources — `get` and `describe`](#2-inspecting-resources)
3. [Running Commands Inside Pods — `exec`](#3-exec)
4. [Managing Deployments — `rollout`](#4-rollout)
5. [Logs](#5-logs)
6. [ConfigMaps and Secrets](#6-configmaps-and-secrets)
7. [Resource Quotas and Limits](#7-resource-quotas-and-limits)
8. [ArgoCD + kubectl Workflow](#8-argocd--kubectl-workflow)
9. [JMESPath / JSONPath Queries](#9-jmespath--jsonpath-queries)
10. [Troubleshooting Patterns](#10-troubleshooting-patterns)
11. [Grafana Dashboard Debugging](#11-grafana-dashboard-debugging)

---

## 1. Core Concepts

### Command Structure

```
kubectl <verb> <resource-type> [resource-name] [flags]
│        │      │                │               │
│        │      │                │               └─ Options (namespace, output, etc.)
│        │      │                └─ Optional specific resource
│        │      └─ What kind (pod, deployment, service, configmap, etc.)
│        └─ Action (get, describe, exec, logs, rollout, apply, delete)
└─ The CLI tool
```

### Key Flags (apply to most commands)

| Flag | Short | Purpose | Example |
|:-----|:------|:--------|:--------|
| `--namespace` | `-n` | Target namespace | `-n monitoring` |
| `--output` | `-o` | Output format | `-o json`, `-o yaml`, `-o wide` |
| `--all-namespaces` | `-A` | All namespaces | `kubectl get pods -A` |
| `--selector` | `-l` | Filter by label | `-l app=steampipe` |
| `--watch` | `-w` | Stream changes live | `kubectl get pods -w` |

---

## 2. Inspecting Resources

### `kubectl get` — List resources (summary view)

**When to use:** Quick status check. Shows name, status, age, restarts.

```bash
# All pods in a namespace
kubectl get pods -n monitoring

# Wide output (shows node, IP, additional columns)
kubectl get pods -n monitoring -o wide

# All pods across all namespaces
kubectl get pods -A

# Filter by label
kubectl get pods -n monitoring -l app=steampipe

# Specific resource types
kubectl get deployments -n monitoring
kubectl get services -n monitoring
kubectl get configmaps -n monitoring
kubectl get nodes
```

### `kubectl describe` — Detailed resource info

**When to use:** Debugging. Shows events, conditions, attached volumes,
environment variables, and recent state transitions.

```bash
# Describe a specific pod (shows events, restarts, OOM kills)
kubectl describe pod <pod-name> -n monitoring

# Describe a deployment (shows rollout strategy, replicas, conditions)
kubectl describe deployment steampipe -n monitoring

# Describe a node (shows capacity, allocatable resources, conditions)
kubectl describe node <node-name>
```

> **`get` vs `describe`:** Use `get` for a quick status table. Use
> `describe` when something is wrong and you need events and conditions.

---

## 3. `exec` — Run Commands Inside a Pod

### What It Is

`exec` runs a command **inside a running pod's container**. It's like
SSH-ing into a container. The command runs in the container's filesystem
and environment, not on the host.

### When to Use

- Verify config files mounted into a pod
- Run diagnostic queries (e.g., Steampipe SQL queries)
- Check network connectivity from inside a pod
- Inspect environment variables

### Syntax

```
kubectl exec [flags] <pod-or-deployment> -- <command> [args...]
              │       │                   │    │
              │       │                   │    └─ The command to run inside the container
              │       │                   └─ Separator (everything after is the command)
              │       └─ Target pod or deployment/
              └─ Namespace, container selection, etc.
```

> **The `--` separator is critical.** Without it, kubectl interprets
> flags after the pod name as its own flags, not as part of the command.

### Examples

```bash
# Run a single command
kubectl exec -n monitoring deployment/steampipe -- steampipe plugin list

# Interactive shell (if available)
kubectl exec -n monitoring deployment/steampipe -it -- /bin/bash
#  -i = stdin (interactive)
#  -t = allocate a TTY (terminal)

# Check a mounted config file
kubectl exec -n monitoring deployment/steampipe -- \
  cat /home/steampipe/.steampipe/config/aws.spc

# Run a Steampipe query
kubectl exec -n monitoring deployment/steampipe -- \
  steampipe query "SELECT instance_id, region FROM aws_ec2_instance"

# Check environment variables
kubectl exec -n monitoring deployment/steampipe -- env | grep AWS

# Test DNS resolution from inside a pod
kubectl exec -n monitoring deployment/steampipe -- \
  nslookup steampipe.monitoring.svc.cluster.local
```

### Targeting a Deployment vs a Pod

```bash
# Target deployment (kubectl picks one pod automatically)
kubectl exec -n monitoring deployment/steampipe -- ...

# Target a specific pod (when you need a precise pod)
kubectl exec -n monitoring steampipe-5fbf75fcf7-w2l7l -- ...
```

### Multi-Container Pods

```bash
# Specify which container (required if pod has multiple containers)
kubectl exec -n monitoring <pod> -c steampipe -- ...
#                                 └─ Container name
```

---

## 4. `rollout` — Manage Deployment Updates

### What It Is

`rollout` manages the lifecycle of Deployment updates. When you change
a Deployment spec (image, env, config), Kubernetes performs a **rolling
update** — gradually replacing old pods with new ones.

### When to Use

| Scenario | Command |
|:---------|:--------|
| ConfigMap changed but pod didn't restart | `rollout restart` |
| Check if a deployment finished updating | `rollout status` |
| Something broke after update, need to revert | `rollout undo` |
| View update history | `rollout history` |

### Commands

```bash
# Force restart all pods in a deployment (new pods created, old ones terminated)
# USE THIS after ConfigMap/Secret changes — they don't auto-restart pods
kubectl rollout restart deployment/steampipe -n monitoring

# Watch the rollout progress (blocks until complete or failed)
kubectl rollout status deployment/steampipe -n monitoring

# Undo — revert to the previous revision
kubectl rollout undo deployment/steampipe -n monitoring

# Undo to a specific revision
kubectl rollout undo deployment/steampipe -n monitoring --to-revision=2

# View rollout history
kubectl rollout history deployment/steampipe -n monitoring
```

> **Key insight:** `rollout restart` doesn't change the spec — it adds
> a `restartedAt` annotation that forces Kubernetes to recreate all pods.
> This is safe and idempotent.

---

## 5. Logs

### `kubectl logs` — View container output

```bash
# Current pod logs (last 100 lines)
kubectl logs -n monitoring deployment/steampipe --tail=100

# Follow logs in real time (like tail -f)
kubectl logs -n monitoring deployment/steampipe -f

# Previous container's logs (after a crash/restart)
kubectl logs -n monitoring <pod-name> --previous

# Specific container in a multi-container pod
kubectl logs -n monitoring <pod-name> -c steampipe

# All pods with a label (e.g., all monitoring pods)
kubectl logs -n monitoring -l app=steampipe --all-containers
```

---

## 6. ConfigMaps and Secrets

### View ConfigMaps

```bash
# List all ConfigMaps
kubectl get configmaps -n monitoring

# View a specific ConfigMap's contents
kubectl get configmap steampipe-config -n monitoring -o yaml

# View just the data section
kubectl get configmap steampipe-config -n monitoring \
  -o jsonpath='{.data.steampipe\.spc}'
```

### Quick-Edit a ConfigMap (for testing)

```bash
# Edit in-place (opens $EDITOR)
kubectl edit configmap steampipe-config -n monitoring

# After editing, restart the pod to pick up changes
kubectl rollout restart deployment/steampipe -n monitoring
```

> **Warning:** In-place edits will be **overwritten by ArgoCD** on next
> sync. For permanent changes, modify the Helm template and push to Git.

---

## 7. Resource Quotas and Limits

```bash
# View namespace quota usage vs limits
kubectl describe resourcequota -n monitoring

# View a pod's actual resource usage (requires metrics-server)
kubectl top pods -n monitoring

# View node resource usage
kubectl top nodes

# Temporarily patch resource limits (for testing, ArgoCD will revert)
kubectl set resources -n monitoring deployment/steampipe \
  --limits=cpu=500m,memory=1Gi \
  --requests=cpu=100m,memory=512Mi
```

---

## 8. ArgoCD + kubectl Workflow

### The Typical Cycle

```
1. Edit Helm chart locally
2. git commit + git push origin develop
3. ArgoCD auto-syncs from Git (~3 min)
4. ConfigMap updated? → kubectl rollout restart
5. Verify with kubectl exec / kubectl logs
```

### Post-ArgoCD-Sync Commands

```bash
# 1. Check if ArgoCD synced the new ConfigMap
kubectl get configmap steampipe-config -n monitoring -o yaml

# 2. ConfigMap changed? Restart pods (ConfigMaps don't auto-restart)
kubectl rollout restart deployment/steampipe -n monitoring

# 3. Wait for rollout
kubectl rollout status deployment/steampipe -n monitoring

# 4. Verify the new config inside the pod
kubectl exec -n monitoring deployment/steampipe -- \
  cat /home/steampipe/.steampipe/config/aws.spc

# 5. Test functionality
kubectl exec -n monitoring deployment/steampipe -- \
  steampipe query "SELECT count(*) FROM aws_ec2_instance"
```

### Force ArgoCD to Sync Immediately

```bash
# Via ArgoCD CLI (if installed)
argocd app sync monitoring

# Via kubectl (patch the Application resource)
kubectl patch application monitoring -n argocd \
  --type merge -p '{"operation":{"sync":{"force":true}}}'
```

---

## 9. JMESPath / JSONPath Queries

kubectl uses **JSONPath** (not JMESPath). The AWS CLI uses JMESPath.
Both are useful in this project.

### kubectl JSONPath

JSONPath expressions start with `{` and use `.` for field access,
`[*]` for arrays, and `[?()]` for filtering.

```bash
# Pod names only
kubectl get pods -n monitoring -o jsonpath='{.items[*].metadata.name}'

# Pod names + status (custom columns)
kubectl get pods -n monitoring \
  -o custom-columns='NAME:.metadata.name,STATUS:.status.phase,RESTARTS:.status.containerStatuses[0].restartCount'

# Get the image used by a deployment
kubectl get deployment steampipe -n monitoring \
  -o jsonpath='{.spec.template.spec.containers[0].image}'

# Get all container statuses (detect OOMKilled)
kubectl get pods -n monitoring -l app=steampipe \
  -o jsonpath='{.items[*].status.containerStatuses[*].lastState.terminated.reason}'

# Node internal IPs
kubectl get nodes \
  -o jsonpath='{.items[*].status.addresses[?(@.type=="InternalIP")].address}'

# ConfigMap data value
kubectl get configmap steampipe-config -n monitoring \
  -o jsonpath='{.data.steampipe\.spc}'

# Memory limits for all containers in a namespace
kubectl get pods -n monitoring \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[*].resources.limits.memory}{"\n"}{end}'
```

### AWS CLI JMESPath (used with `aws` commands)

JMESPath uses `[]` for arrays, `.` for field access, and `|` for
pipe-like chaining.

```bash
# Get instance IDs and types
aws ec2 describe-instances \
  --query 'Reservations[*].Instances[*].[InstanceId,InstanceType,State.Name]' \
  --output table

# Filter running instances only
aws ec2 describe-instances \
  --query 'Reservations[*].Instances[?State.Name==`running`].[InstanceId,PrivateIpAddress]' \
  --output table

# Get SSM parameter value
aws ssm get-parameter \
  --name "/k8s/development/elastic-ip" \
  --query 'Parameter.Value' --output text

# ECR image tags
aws ecr describe-images \
  --repository-name steampipe-aws \
  --query 'imageDetails[*].[imageTags[0],imagePushedAt]' \
  --output table

# Sort by date (most recent first)
aws ecr describe-images \
  --repository-name steampipe-aws \
  --query 'sort_by(imageDetails, &imagePushedAt)[-1].imageTags[0]' \
  --output text

# CloudWatch log groups matching a pattern
aws logs describe-log-groups \
  --query 'logGroups[?contains(logGroupName, `monitoring`)].logGroupName' \
  --output table
```

### JMESPath vs JSONPath Quick Reference

| Feature | JSONPath (kubectl) | JMESPath (AWS CLI) |
|:--------|:-------------------|:-------------------|
| Field access | `.metadata.name` | `Parameter.Value` |
| Array all | `[*]` | `[*]` |
| Filter | `[?(@.type=="X")]` | `[?State==\`X\`]` |
| Pipe | N/A | `\|` |
| Output wrapper | `{..}{"\n"}` | `[Field1,Field2]` |
| Multi-select | `custom-columns=` | `[A,B,C]` |

---

## 10. Troubleshooting Patterns

### Pod Won't Start

```bash
# 1. Check pod status and events
kubectl describe pod <pod-name> -n monitoring
# Look for: ImagePullBackOff, CrashLoopBackOff, OOMKilled, Pending

# 2. Check if it's a quota issue
kubectl describe resourcequota -n monitoring

# 3. Check node resources
kubectl top nodes
```

### Pod Crashed (Exit Code 137 = OOM Kill)

```bash
# Confirm OOM
kubectl get pods -n monitoring -l app=steampipe \
  -o jsonpath='{.items[*].status.containerStatuses[*].lastState.terminated.reason}'
# Output: "OOMKilled"

# Fix: increase memory limit
kubectl set resources deployment/steampipe -n monitoring \
  --limits=memory=1Gi
```

### ConfigMap Changed But Pod Uses Old Config

```bash
# ConfigMaps do NOT trigger pod restarts. Force it:
kubectl rollout restart deployment/steampipe -n monitoring
kubectl rollout status deployment/steampipe -n monitoring
```

### ArgoCD Keeps Reverting My Changes

```bash
# In-cluster edits are overwritten by ArgoCD on sync.
# For permanent changes: edit Helm chart → git push → ArgoCD syncs.
# For temporary testing: pause ArgoCD sync first:
kubectl patch application monitoring -n argocd \
  --type merge -p '{"spec":{"syncPolicy":null}}'

# Re-enable auto-sync after testing:
kubectl patch application monitoring -n argocd \
  --type merge -p '{"spec":{"syncPolicy":{"automated":{"selfHeal":true}}}}'
```

### Check What ArgoCD Sees

```bash
# List ArgoCD Applications
kubectl get applications -n argocd

# Check sync status
kubectl get applications -n argocd -o custom-columns=\
'NAME:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status'
```

---

## 11. Grafana Dashboard Debugging

When dashboard panels show errors like "Bad Gateway", "does not exist",
or "wrong type", use these three levels to isolate the issue.

### Level 1: Grafana UI — Query Inspector (per-panel)

The fastest way to see the exact SQL and error for a failing panel:

1. **Hover** over the panel → click the **⋮ menu** (three dots)
2. Select **Inspect → Query**
3. View the **exact SQL** Grafana sends and the **raw error response**
4. If the panel shows an error badge, click **Inspect → Error** for
   the full error text

> **Tip:** Copy the SQL from the inspector and test it directly in
> Steampipe (Level 3) to confirm whether the problem is in the query
> itself or in the Grafana → Steampipe connection.

### Level 2: Grafana Pod Logs (connection errors)

Catches "Bad Gateway", "No available server", and connection-level
failures between Grafana and the Steampipe PostgreSQL datasource.

```bash
# Live tail — watch errors as you load/refresh the dashboard
kubectl logs -f -n monitoring deployment/grafana | grep -i "error\|failed\|bad gateway"

# Last 100 lines of Grafana logs
kubectl logs -n monitoring deployment/grafana --tail=100

# Previous container logs (if Grafana restarted)
kubectl logs -n monitoring deployment/grafana --previous --tail=50
```

### Level 3: Steampipe Pod Logs (SQL and plugin errors)

Catches "column does not exist", "wrong type", plugin crashes, and
FDW (Foreign Data Wrapper) errors.

```bash
# Live tail — watch query errors as dashboard panels load
kubectl logs -f -n monitoring deployment/steampipe

# Filter for errors only
kubectl logs -n monitoring deployment/steampipe --tail=200 \
  | grep -i "error\|fatal\|panic"

# Previous container logs (if Steampipe crashed/OOM)
kubectl logs -n monitoring deployment/steampipe --previous --tail=100
```

### Step-by-Step Debugging Workflow

```text
1. Panel shows error in Grafana
       ↓
2. Click panel → Inspect → Query
   (copy the exact SQL and error message)
       ↓
3. Test the SQL directly against Steampipe:
   kubectl exec -n monitoring deployment/steampipe -- \
     steampipe query "<PASTE SQL HERE>"
       ↓
4a. Query FAILS in Steampipe too?
    → Fix the SQL (column name, type cast, etc.)
    → Check: kubectl logs -n monitoring deployment/steampipe --tail=50
       ↓
4b. Query WORKS in Steampipe but FAILS in Grafana?
    → Connection issue — check Grafana logs:
    → kubectl logs -n monitoring deployment/grafana --tail=50
    → Possibly Steampipe overloaded (too many concurrent queries)
```

### Direct Steampipe Query Testing

Before modifying dashboard SQL, test queries interactively:

```bash
# Test Security Group rules (cidr type handling)
kubectl exec -n monitoring deployment/steampipe -- \
  steampipe query "SELECT count(*) FROM aws_vpc_security_group_rule"

# Test S3 tables (column availability)
kubectl exec -n monitoring deployment/steampipe -- \
  steampipe query "SELECT name, region FROM aws_s3_bucket LIMIT 3"

# Test Route 53 (checks multi-region and plugin connectivity)
kubectl exec -n monitoring deployment/steampipe -- \
  steampipe query "SELECT count(*) FROM aws_route53_zone"

# List available columns for a table (useful when "column X does not exist")
kubectl exec -n monitoring deployment/steampipe -- \
  steampipe query ".inspect aws_s3_bucket"
```

> **Common Steampipe SQL Pitfalls:**
>
> | Symptom | Cause | Fix |
> |:--------|:------|:----|
> | "Invalid input syntax cidr" | cidr type in COALESCE with text | Cast with `::text` |
> | "Attribute N wrong type" | `boolean::text` in JOIN/SELECT | Use `CASE WHEN col THEN 'Yes' ELSE 'No' END` |
> | "column X does not exist" | Plugin version mismatch | Run `.inspect <table>` to check actual columns |
> | "Bad Gateway" / "No available server" | Steampipe FDW overloaded | Reduce concurrent panels or increase pod resources |
