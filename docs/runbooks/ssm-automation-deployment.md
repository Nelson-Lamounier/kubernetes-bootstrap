---
title: SSM Automation Deployment Runbook
type: runbook
tags: [ssm-automation, kubernetes, bootstrap, aws, deployment, step-functions]
sources:
  - infra/lib/stacks/ssm-automation-stack.ts
  - argocd-apps/argo-rollouts.yaml
created: 2026-04-28
updated: 2026-04-28
---

# SSM Automation — Deployment & Redeployment Runbook

> **Purpose**: Operate the SSM Automation bootstrap pipeline — first deploy,
> day-2 script updates, full redeployment, and failure troubleshooting.

**Last Updated:** 2026-03-25
**Operator:** Solo — infrastructure owner

---

## Architecture Overview

The bootstrap lifecycle is split across **two pipelines**:

| Pipeline | Responsibility |
| :--- | :--- |
| `_deploy-kubernetes.yml` | Deploys **all CDK stacks** — networking, compute, IAM, SSM Automation documents, and IAM roles |
| `_deploy-ssm-automation.yml` | Syncs scripts to S3, triggers SSM Automation on existing EC2 nodes, verifies, then delegates to post-bootstrap config |

### Job Flow (`_deploy-ssm-automation.yml`)

```text
sync-scripts → trigger-bootstrap → verify-ssm-automation
                                 → post-bootstrap-config
                                     └ deploy-*-secrets → verify
```

| Job | Duration | Description |
| :--- | :---: | :--- |
| `sync-scripts` | ~2 min | `aws s3 sync` of `k8s-bootstrap/` + `workloads/` to S3 |
| `trigger-bootstrap` | ~15 min | Resolves instance IDs from SSM, triggers automation: control-plane first → workers |
| `verify-ssm-automation` | ~3 min | Integration tests: instance targeting + health checks |
| `post-bootstrap-config` | ~5 min | Deploys K8s Secrets + ArgoCD health + smoke tests |

### Instance Discovery

EC2 user data publishes instance IDs to SSM parameters on boot:

- `/k8s/<env>/bootstrap/control-plane-instance-id`
- `/k8s/<env>/bootstrap/app-worker-instance-id`
- `/k8s/<env>/bootstrap/mon-worker-instance-id`

The `trigger-bootstrap` job reads these to target SSM Automation. If a
parameter is missing, that node role is skipped (not yet deployed).

---

## Day-1: First Deployment

### Prerequisites

1. The **Kubernetes CDK pipeline** has been deployed (`_deploy-kubernetes.yml`),
   creating the SSM Automation documents, IAM roles, S3 bucket, and EC2 instances.
2. EC2 instances are running and have published their instance IDs to SSM.
3. Bootstrap scripts exist under `kubernetes-app/k8s-bootstrap/`.

### Steps

```bash
# 1. Trigger the SSM Automation pipeline
gh workflow run deploy-ssm-automation.yml --ref develop

# 2. Watch the pipeline in real-time
gh run watch
```

The pipeline will:

1. Sync the latest Python step scripts and Helm charts to S3.
2. Trigger SSM Automation on the **control plane** first.
3. Wait for the control plane to complete, then trigger **workers**.
4. Run integration tests to verify instance targeting and health.
5. Deploy Kubernetes Secrets (Next.js, monitoring) via the post-bootstrap job.
6. Verify ArgoCD health and run smoke tests.

---

## Day-2+: Script Updates & Redeployment

When you update bootstrap scripts (e.g. `control_plane.py`, `worker.py`,
`bootstrap_argocd.py`), re-run the pipeline to sync and re-execute:

```bash
# 1. Commit and push your changes
git add kubernetes-app/k8s-bootstrap/
git commit -m "feat(bootstrap): update control plane step 4b"
git push origin develop

# 2. Trigger the pipeline (or let CI auto-trigger)
gh workflow run deploy-ssm-automation.yml --ref develop
```

> [!IMPORTANT]
> The S3 sync happens **before** the SSM trigger within the pipeline. However,
> if you trigger SSM Automation manually (outside the pipeline), ensure the
> updated script has been synced to S3 first, otherwise the node will execute
> the stale version.

### Script-Only Re-sync (without bootstrap trigger)

To sync scripts without triggering bootstrap (e.g. to pre-stage for a
future run):

```bash
# Sync locally using the justfile
just sync-k8s-bootstrap development
```

---

## Full Redeployment (Infrastructure + Bootstrap)

When underlying infrastructure changes (VPC, IAM roles, SSM documents):

```bash
# 1. Deploy all CDK stacks first
gh workflow run deploy-kubernetes.yml --ref develop

# 2. Then trigger bootstrap with the updated infrastructure
gh workflow run deploy-ssm-automation.yml --ref develop
```

---

## Troubleshooting with `just` Commands

Three local diagnostic commands provide rapid debugging without navigating
the AWS Console or CloudWatch.

### 1. Bootstrap Execution Status

Shows recent SSM Automation executions and per-step status for both
control-plane and worker documents.

```bash
# Default: last 3 executions, development
just ssm-bootstrap-status

# Last 5 executions
just ssm-bootstrap-status 5

# Specific environment
just ssm-bootstrap-status 3 staging eu-west-1 stg-account
```

**Output includes:**

- Execution ID, overall status, start/end timestamps
- Per-step icons: ✅ Success, ❌ Failed, 🔄 InProgress, ⏰ TimedOut, ⛔ Cancelled

### 2. Bootstrap Step Logs (stdout/stderr)

Retrieves the actual command output for each step of the **latest**
execution — the primary debugging tool for bootstrap failures.

```bash
# Default: last 50 lines per step, development, all documents
just ssm-bootstrap-logs

# Last 100 lines, worker document only
just ssm-bootstrap-logs 100 development worker

# Control plane only
just ssm-bootstrap-logs 50 development control-plane
```

**Output includes:**

- Per-step stdout and stderr from `get-command-invocation`
- If output is empty or truncated, a fallback hint to check CloudWatch
  log group `/ssm/k8s/<env>/bootstrap`

### 3. S3 Sync Status

Verifies that the latest bootstrap scripts and Helm charts are present in
S3 — essential after a pipeline sync or local `just sync-k8s-bootstrap`.

```bash
# Default: development, top 5 files per prefix
just ssm-s3-sync-status

# Show last 10 files per prefix
just ssm-s3-sync-status development 10
```

**Output includes:**

- S3 bucket name (resolved from SSM parameter `/k8s/<env>/scripts-bucket`)
- Per-prefix breakdown for `k8s-bootstrap/`, `platform/charts/`, `workloads/charts/`:
  - Total file count
  - Last sync timestamp (most recent `LastModified`)
  - Most recently modified files with size

---

## Common Failure Scenarios

### Scenario 1: Step Fails — Script Error

**Symptoms:** `ssm-bootstrap-status` shows ❌ on a specific step.

```bash
# 1. Check which step failed
just ssm-bootstrap-status

# 2. Read the stderr for the failed step
just ssm-bootstrap-logs 100 development control-plane

# 3. Fix the script, commit, and re-run the pipeline
gh workflow run deploy-ssm-automation.yml --ref develop
```

### Scenario 2: Stale Scripts — S3 Not Synced

**Symptoms:** Pipeline succeeds but bootstrap behaviour is outdated.

```bash
# 1. Verify the S3 sync timestamps
just ssm-s3-sync-status

# 2. If timestamps are old, force a re-sync
just sync-k8s-bootstrap development

# 3. Confirm the sync
just ssm-s3-sync-status

# 4. Re-trigger bootstrap
gh workflow run deploy-ssm-automation.yml --ref develop
```

### Scenario 3: CCM Deadlock — Pods Stuck Pending

If the Cloud Controller Manager is not installed before ArgoCD, all nodes
retain the `uninitialized` taint and no pods can schedule.

> **Full recovery procedure:** See the dedicated
> [Bootstrap Deadlock Runbook](./bootstrap-deadlock-ccm.md).

**Quick diagnosis:**

```bash
# Connect to cluster
just k8s-tunnel-auto

# Check for 'uninitialized' taint
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.taints}{"\n"}{end}'
```

### Scenario 4: Instance Not Found — SSM Parameter Missing

**Symptoms:** `trigger-bootstrap` skips a node role.

The EC2 user data script publishes the instance ID to SSM on first boot.
If the parameter is missing, the instance either hasn't booted or user
data failed.

```bash
# Check if the SSM parameter exists
aws ssm get-parameter \
  --name "/k8s/development/bootstrap/control-plane-instance-id" \
  --query "Parameter.Value" --output text \
  --region eu-west-1 --profile dev-account
```

If empty, check the EC2 instance's system log:

```bash
aws ec2 get-console-output \
  --instance-id <instance-id> \
  --output text --latest \
  --region eu-west-1 --profile dev-account
```

---

## SSM Automation Execution — Manual Trigger

For targeted debugging, trigger SSM Automation directly:

```bash
# Control plane
just ssm-trigger-control-plane <instance-id> development

# Worker
just ssm-trigger-worker <instance-id> development

# Monitor execution
just ssm-status <execution-id>
```

---

## Pipeline Integration — CI/CD Commands

These commands are used by the pipeline workflow and can also be run
manually for debugging:

```bash
# Sync scripts (used by sync-scripts job)
just ci-sync-scripts --environment development --region eu-west-1

# Trigger bootstrap (used by trigger-bootstrap job)
just ci-trigger-bootstrap --environment development --region eu-west-1

# Integration tests (used by verify-ssm-automation job)
just ci-integration-test kubernetes/ssm-automation-runtime development --verbose
```

---

## Verification Checklist

After any deployment or redeployment, confirm all is healthy:

```bash
# 1. Bootstrap completed successfully
just ssm-bootstrap-status

# 2. Scripts are up-to-date in S3
just ssm-s3-sync-status

# 3. Step logs show no errors
just ssm-bootstrap-logs

# 4. Connect to cluster and verify
just k8s-tunnel-auto
kubectl get nodes -o wide
kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded

# 5. ArgoCD applications syncing
kubectl get applications -n argocd

# 6. Endpoints responding
curl -sk -o /dev/null -w "%{http_code}" https://ops.nelsonlamounier.com/argocd/
```

---

## Source Files

| File | Purpose |
| :--- | :--- |
| `.github/workflows/_deploy-ssm-automation.yml` | Bootstrap pipeline (sync → trigger → verify → secrets) |
| `.github/workflows/_post-bootstrap-config.yml` | Post-bootstrap secrets and verification |
| `infra/lib/constructs/ssm/automation-document.ts` | CDK construct for SSM Automation documents |
| `kubernetes-app/k8s-bootstrap/boot/steps/control_plane.py` | Control plane bootstrap steps |
| `kubernetes-app/k8s-bootstrap/boot/steps/worker.py` | Worker node bootstrap steps |
| `kubernetes-app/k8s-bootstrap/system/argocd/bootstrap_argocd.py` | ArgoCD bootstrap (step 7) |

---

## Related Runbooks

- [Bootstrap Deadlock — CCM Recovery](./bootstrap-deadlock-ccm.md)
- [Cross-AZ Disaster Recovery](./cross-az-recovery.md)

---

*Commands and paths above are real values from the cdk-monitoring repository.*
