---
title: Idempotent Step Runner Pattern
type: pattern
tags: [typescript, idempotency, aws-ssm, kubernetes, bootstrap, state-machine]
sources:
  - sm-a/boot/steps/common.ts
  - sm-a/boot/steps/control_plane.ts
  - sm-a/boot/steps/worker.ts
created: 2026-04-28
updated: 2026-04-28
---

# Idempotent Step Runner Pattern

A TypeScript factory pattern that wraps any async operation in idempotency guarantees, live SSM status reporting, and structured failure classification — used across all 16 bootstrap steps in `control_plane.ts` and `worker.ts`.

## Problem

Bootstrap scripts running inside SSM RunCommand have no persistent state across retries. EC2 instances can be re-launched, SSM documents can be re-invoked for hot-fixes, and partial failures mid-sequence must not cause destructive operations (like `kubeadm init`) to run twice. Simultaneously, operators need live visibility into which step a 20-minute bootstrap sequence is currently executing — without a management cluster.

## Solution: makeRunStep factory

[`sm-a/boot/steps/common.ts`](../../sm-a/boot/steps/common.ts) exports `makeRunStep(scriptName)`, which returns a `runStep` closure bound to the caller's script name. Each script calls the factory once:

```typescript
// control_plane.ts — factory call
const runStep = makeRunStep('control_plane');

// worker.ts — factory call
const runStep = makeRunStep('worker');
```

The returned `runStep` is then used for every step in that script:

```typescript
await runStep('install-calico', () => installCalico(cfg), cfg, CALICO_MARKER);
await runStep('configure-kubectl', () => configureKubectl(cfg), cfg);
```

## Step execution flow

```mermaid
flowchart TD
    A["runStep(name, fn, cfg, marker?)"] --> B{marker file\nexists?}
    B -->|yes| C[Skip — log + return]
    B -->|no| D[Write SSM: status=running]
    D --> E[Execute fn()]
    E --> F{Result?}
    F -->|success| G[Touch marker file\nWrite SSM: success\nAppend run_summary.json]
    F -->|StepDegraded| H[Write SSM: degraded\nDo NOT touch marker\nDo NOT rethrow]
    F -->|Error| I[Write SSM: failed\nRethrow → blocks pipeline]
```

## Marker files — filesystem idempotency

Each step that has permanent side effects receives a marker file path. The marker is a zero-byte file whose existence signals "this step completed successfully":

```typescript
const CALICO_MARKER  = '/var/lib/k8s-bootstrap/.calico-installed';
const CCM_MARKER     = '/var/lib/k8s-bootstrap/.ccm-installed';
const DATA_MOUNT_MARKER = '/var/lib/k8s-bootstrap/.data-volume-mounted';
// etc.
```

If `runStep` is called and the marker exists, the step is logged as skipped and returns immediately — the function `fn` is never called. This makes re-invocation of the full SSM document safe at any point in time.

Steps that are intrinsically idempotent (e.g., `configure-kubectl`, `bootstrap-argocd`) receive no marker and re-run on every invocation. Steps that have permanently destructive side effects (like `kubeadm init`) handle their own idempotency internally via `existsSync(ADMIN_CONF)`.

## SSM status reporting

On every state transition, `runStep` writes a JSON status object to SSM:

```
Path:  {ssmPrefix}/bootstrap/status/boot/{stepName}
Value: {
  script:    "control_plane",
  step:      "install-calico",
  status:    "running" | "success" | "failed" | "degraded",
  startedAt: "2026-04-28T12:00:00.000Z",
  finishedAt?: "...",
  error?:    "..."
}
```

This provides live observability without a management cluster — an operator can query SSM during a running bootstrap to see exactly which step is executing and how long it has been running:

```bash
aws ssm get-parameter \
  --name "/k8s/development/bootstrap/status/boot/install-calico" \
  --query 'Parameter.Value' --output text | jq .
```

## Run summary

On step success, `runStep` appends a line to `/var/lib/k8s-bootstrap/run_summary.json`. After the full sequence completes, this file contains the timing and status of every step — useful for post-mortem analysis and performance profiling.

## StepDegraded — degraded vs failed

The `StepDegraded` class (extends `Error`) is the distinction between "this step has a non-critical issue" and "this step failed and the pipeline must stop":

```typescript
// A non-critical issue — CloudWatch agent installed but metrics config wrong
throw new StepDegraded('CloudWatch agent config incomplete — metrics may be missing');

// A critical failure — kubeadm init failed
throw new Error('kubeadm init exited with code 1');
```

When `StepDegraded` is thrown:
- The SSM status is set to `"degraded"` (visible to operators)
- The marker file is NOT written (step will re-run on next invocation)
- The exception is NOT rethrown — the pipeline continues

When `Error` (or any non-`StepDegraded`) is thrown:
- The SSM status is set to `"failed"`
- The exception IS rethrown — the pipeline halts

This allows bootstrap to complete even when non-critical components have issues, while still surfacing those issues for operator attention.

## Failure classification

`classifyFailure(error: Error): string` maps the error message against known patterns to produce a structured failure code written into the SSM failed-status payload:

| Code | Matched by |
|------|-----------|
| `AMI_MISMATCH` | "ami mismatch" / "ami version" in error message |
| `S3_FORBIDDEN` | "s3" AND "access denied" / "forbidden" |
| `KUBEADM_FAIL` | "kubeadm" |
| `CALICO_TIMEOUT` | "calico" AND "timeout" |
| `ARGOCD_SYNC_FAIL` | "argocd" AND "sync" |
| `CW_AGENT_FAIL` | "cloudwatch agent" |
| `UNKNOWN` | fallback |

The Step Functions state machine embeds this code in the execution failure cause alongside a `aws logs tail` command for immediate diagnosis.

## Subprocess safety

All subprocess invocations use `run(cmd: string[], opts?)` with the **array form** of `spawnSync` — never template strings or shell interpolation. This prevents any SSM-sourced parameter value from reaching a shell as an injectable string:

```typescript
// Safe — array form, no shell
run(['kubeadm', 'init', '--config', configPath]);

// Never written — shell string, injectable
run(`kubeadm init --config ${configPath}`);
```

## Usage in control_plane.ts and worker.ts

**Control plane** — 10 steps, 6 with markers ([`sm-a/boot/steps/control_plane.ts`](../../sm-a/boot/steps/control_plane.ts), lines 1549–1564):

```typescript
await runStep('mount-data-volume',     () => mountDataVolume(cfg),     cfg, DATA_MOUNT_MARKER);
await runStep('dr-restore',            () => drRestore(cfg),            cfg, DR_RESTORE_MARKER);
await runStep('init-kubeadm',          () => initOrReconstruct(cfg),   cfg);
await runStep('install-calico',        () => installCalico(cfg),        cfg, CALICO_MARKER);
await runStep('install-ccm',           () => installCcm(cfg),           cfg, CCM_MARKER);
await runStep('configure-kubectl',     () => configureKubectl(cfg),    cfg);
await runStep('bootstrap-argocd',      () => bootstrapArgocd(cfg),     cfg);
await runStep('verify-cluster',        () => verifyCluster(cfg),       cfg);
await runStep('install-etcd-backup',   () => installEtcdBackup(cfg),   cfg, '/etc/systemd/system/etcd-backup.timer');
await runStep('install-token-rotator', () => installTokenRotator(cfg), cfg, TOKEN_ROTATOR_MARKER);
```

**Worker** — 6 steps, 2 with markers ([`sm-a/boot/steps/worker.ts`](../../sm-a/boot/steps/worker.ts), lines 1207–1212):

```typescript
await runStep('validate-ami',              () => validateAmi(),               cfg);
await runStep('join-cluster',              () => joinCluster(cfg),            cfg);
await runStep('register-instance',         () => registerInstance(cfg),       cfg);
await runStep('install-cloudwatch-agent',  () => installCloudwatchAgent(cfg), cfg, CW_AGENT_MARKER);
await runStep('clean-stale-pvs',           () => cleanStalePvs(cfg),         cfg, STALE_PV_CLEANUP_MARKER);
await runStep('verify-cluster-membership', () => verifyClusterMembership(cfg),cfg);
```

## Related

- [Kubernetes Bootstrap Orchestrator](../projects/kubernetes-bootstrap-orchestrator.md) — where this pattern is applied
- [SSM Automation bootstrap integration](ssm-automation-bootstrap.md) — the SSM parameter paths this pattern writes to

<!--
Evidence trail (auto-generated):
- Source: sm-a/boot/steps/common.ts (read 2026-04-28, 724 lines — makeRunStep factory, StepDegraded, RUN_SUMMARY_FILE, classifyFailure, run() spawnSync array form)
- Source: sm-a/boot/steps/control_plane.ts (read 2026-04-28, lines 1549-1564 — step invocations with marker file names)
- Source: sm-a/boot/steps/worker.ts (read 2026-04-28, lines 1207-1212 — step invocations)
- Generated: 2026-04-28
-->
