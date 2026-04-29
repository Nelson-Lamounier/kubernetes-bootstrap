---
title: SSM RunCommand Timeout Killing Bootstrap Mid-Run
type: troubleshooting
tags: [aws-ssm, bootstrap, kubernetes, step-functions, aws-cdk]
sources:
  - infra/lib/stacks/ssm-automation-stack.ts
created: 2026-04-29
updated: 2026-04-29
---

# SSM RunCommand Timeout Killing Bootstrap Mid-Run

## Symptom

The Step Functions bootstrap execution shows `FAILED` with an error message containing an `aws logs tail` command. The bootstrap SSM RunCommand output ends abruptly mid-step — the log line for the step beginning is present but no completion or error line follows. The process exit code is `143` (SIGTERM).

The bootstrap appeared healthy up to the point of termination — no application error was logged, no step explicitly failed.

```
[2026-04-13T10:12:42Z] INFO: === Step 9: create_ci_bot — starting ===
[2026-04-13T10:12:43Z] INFO:   ✓ argocd-cm patched with accounts.ci-bot
# --- execution ends here, no further output ---
```

SSM execution status: `Failed`, exit code `143`.

## Root cause

The SSM `RunCommand` document step has a `timeoutSeconds` setting. When a bootstrap run exceeds this value, SSM sends `SIGTERM` to the process — **regardless of whether the process is healthy and making progress**.

The production incident on **2026-04-13** was caused by the default `timeoutSeconds: 600` (10 minutes). A full fresh-node bootstrap — `kubeadm init` + Calico + CCM + ArgoCD (31 steps) — takes 20–30 minutes. The process was killed at exactly the 10-minute mark during step 9 (`create_ci_bot` argocd-server rollout wait).

The fix is recorded in `infra/lib/stacks/ssm-automation-stack.ts` lines 271–274:

```typescript
// SSM's own timeoutSeconds must be >= SM-A ceiling or it will SIGKILL mid-run.
// Root cause of 2026-04-13 failure: default 600s killed control_plane.py at
// Step 9 (create_ci_bot rollout wait) after exactly 10 minutes of execution.
timeoutSeconds: 3600,
```

The current value is `3600` (1 hour). The Step Functions SM-A state machine poll ceiling is `1800s` (30 minutes), so the SSM timeout must be at least `1800 + safety margin`.

## How to diagnose

```bash
# 1. Get the SSM RunCommand invocation ID from Step Functions execution
# (visible in the execution details, under the "runScript" step output)

# 2. Fetch the command output
aws ssm get-command-invocation \
  --command-id <invocation-id> \
  --instance-id <instance-id> \
  --query '[Status,StatusDetails,ResponseCode]'
# Status: Failed, ResponseCode: 143 → SIGTERM (timeout kill)
# ResponseCode: 1  → application error (different problem)

# 3. Tail bootstrap logs to see where it stopped
aws logs tail /k8s/development/bootstrap \
  --since 2h \
  --filter-pattern '{ $.level = "ERROR" || $.level = "INFO" }'
# Look for the last step that started but never completed

# 4. Confirm the current SSM document timeout
aws ssm describe-document \
  --name <bootstrap-runner-document-name> \
  --query 'Document.Content' \
  | python3 -c "import sys,json; d=json.loads(json.load(sys.stdin)); \
    [print(s.get('timeoutSeconds')) for s in d.get('mainSteps',[])]"
```

## How to fix

### Immediate recovery — re-trigger the bootstrap

If the bootstrap was killed mid-run, the instance state may be partially initialised. Re-trigger the SSM RunCommand document via the Step Functions state machine or directly:

```bash
# Option A: via Step Functions — re-start the SM-A execution for this instance
# (the bootstrap scripts are idempotent via marker files)

# Option B: direct SSM RunCommand
aws ssm send-command \
  --instance-ids <instance-id> \
  --document-name <bootstrap-runner-document-name> \
  --parameters ScriptPath=sm-a/boot/steps/orchestrator.ts,Mode=control-plane
```

The bootstrap is safe to re-run — each step checks its marker file and skips if already complete.

### Fix the timeout value

In `infra/lib/stacks/ssm-automation-stack.ts`, verify the `timeoutSeconds` value in the `runScript` step is `3600`:

```typescript
// infra/lib/stacks/ssm-automation-stack.ts ~line 274
timeoutSeconds: 3600,
```

If it has been reduced, restore it and re-deploy the stack:

```bash
cd infra
npx cdk deploy Monitoring-K8s-Compute-development
```

## How to prevent

The value `3600` must not be reduced without also reducing the Step Functions SM-A poll ceiling (`40 iterations × 30s = 1800s`). The two values are coupled: SSM timeout must always be ≥ SM-A ceiling.

If adding new bootstrap steps that are slow (e.g., a long Helm chart install with a built-in wait), check whether the new total runtime could approach the SSM ceiling. The safest check is to tail CloudWatch logs for the bootstrap log group after a full fresh-node run and compare the total elapsed time to `timeoutSeconds`.

The code comment at `infra/lib/stacks/ssm-automation-stack.ts` lines 271–274 is the authoritative record of this constraint. Any code review that proposes reducing `timeoutSeconds` should reference the 2026-04-13 production incident.

## Related

- [Kubernetes Bootstrap Orchestrator](../projects/kubernetes-bootstrap-orchestrator.md) — SM-A Step Functions poll loop, 40×30s ceiling
- [kubeadm Control Plane Init — OS-Level Runbook](../runbooks/kubeadm-control-plane-init.md) — full step sequence with timing context

<!--
Evidence trail (auto-generated):
- Source: infra/lib/stacks/ssm-automation-stack.ts (lines 271-274 — comment text verbatim, timeoutSeconds=3600)
- Incident: production incident 2026-04-13 — default 600s killed control_plane.py at Step 9 after 10 minutes (recorded in code comment)
- Generated: 2026-04-29
-->
