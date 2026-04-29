# Step Functions + SSM Automation: Design Decision

**Reviewed:** 2026-04-21  
**Reviewer:** Claude (via AWS MCP `awsknowledge` knowledge base)  
**Verdict:** Correct pattern. Follows AWS Prescriptive Guidance.

---

## Context

The Kubernetes bootstrap pipeline needs to run setup scripts on EC2 instances (control plane + workers) immediately after ASG launch. Two AWS orchestration services are involved — Step Functions and SSM — and their relationship is easy to misread.

---

## Actual Execution Flow

```
EC2 instance launches (ASG)
  └─ EventBridge rule (detail-type: EC2 Instance Launch Successful)
       └─ SM-A: BootstrapOrchestrator (Step Functions state machine)
            ├─ Lambda router → determines CP vs worker
            ├─ SSM SendCommand → bootstrap-runner document
            │    └─ /opt/k8s-bootstrap/orchestrator.py  ← pre-baked in AMI
            └─ SM-A execution succeeds
                 └─ EventBridge rule (ExecutionSucceeded)
                      └─ SM-B: ConfigOrchestrator (Step Functions state machine)
                           ├─ SSM SendCommand → deploy-runner document
                           │    └─ aws s3 sync (config scripts, runtime pull)
                           └─ Injects app secrets, cluster addons
```

### SSM Automation Documents (Secondary Path)

`k8s-bootstrap-control-plane` and `k8s-bootstrap-worker` SSM Automation documents exist but are **not** on the primary path. They are retained for:

- Backwards compatibility with EC2 user-data direct invocation
- Manual ad-hoc runs via SSM console or CLI without triggering a full Step Functions execution
- Debugging individual nodes in isolation

---

## Why Step Functions Instead of Pure SSM Automation

SSM Automation is document-scoped — it runs a sequence of steps on one target machine. It has no cross-machine coordination primitives. The bootstrap workflow requires coordination that SSM Automation cannot provide natively:

| Requirement | Why SSM Automation Falls Short | How Step Functions Solves It |
|---|---|---|
| Wait for all workers to join the cluster after CP replacement | No parallel fan-out + rejoin primitive | `Map` state collects all worker executions; state machine blocks until all complete |
| Poll for kubeadm join token (up to 20 min) | No wait-and-retry loop across documents | `Wait` → `GetCommandInvocation` → `Choice` loop (40 × 30s ceiling) |
| Rich failure messages with stdout/stderr | Automation failure output is minimal | `fetchFailureOutput` Lambda reads SSM command output; `formatFailureCause` embeds stdout/stderr into Step Functions error cause |
| Auto-trigger config orchestration (SM-B) after bootstrap succeeds | No built-in successor chaining | EventBridge rule on `ExecutionSucceeded` fires SM-B automatically |
| Visual execution graph for debugging | Automation console shows steps only | Step Functions console shows full execution graph with per-state I/O |
| Retry with backoff on transient errors | Automation has limited retry semantics | Built-in `Retry` config on `SendCommand` state catches `InvalidInstanceIdException` with exponential backoff |

---

## AWS Prescriptive Guidance Alignment

The `awsknowledge` MCP knowledge base (sourced from AWS Prescriptive Guidance) confirms:

> *"Run AWS Systems Manager Automation tasks synchronously from AWS Step Functions"*

This is an official AWS pattern. The implementation here uses SSM **RunCommand** (not Automation) as the executor — a deliberate simplification:

- RunCommand: fire-and-forget script execution on a target instance, no document versioning required
- SSM Automation: multi-step document with built-in branching, better suited for complex workflows that need to remain self-contained within SSM

For a bootstrap script that is already managed as a Python module (`orchestrator.py`) inside the AMI, RunCommand is the correct choice.

---

## Bootstrap Script Delivery: Bake-Time vs Runtime

The two state machines use different script delivery strategies — intentionally asymmetric:

| | SM-A (Bootstrap) | SM-B (Config) |
|---|---|---|
| Script location | `/opt/k8s-bootstrap/` pre-baked into AMI | `aws s3 sync` at runtime |
| When scripts are fetched | AMI bake time (Image Builder pipeline) | Instance launch time |
| S3 dependency at runtime | None — scripts already on disk | Required — S3 bucket must exist |
| Script update cadence | Requires new AMI bake | Immediate on next instance launch |
| Rationale | Bootstrap scripts are stable; baking eliminates network dependency during node join | Config scripts (app secrets, addons) change frequently; runtime pull ensures latest without baking |

This distinction is intentional. Bootstrap scripts rarely change; baking them into the AMI trades flexibility for reliability. Config scripts change with each deployment; runtime S3 sync gives the config pipeline a fast feedback loop without triggering an AMI rebuild.

---

## What Correct Looks Like

The architecture satisfies the canonical criteria for reaching for Step Functions over SSM Automation alone:

1. **Multi-machine coordination** — CP waits for workers; workers wait for CP token
2. **Long-running async polling** — join token poll loop
3. **Error enrichment** — stdout/stderr surfaced in execution history
4. **Automatic successor chaining** — SM-B fires only on SM-A success
5. **Auditability** — every execution persisted in Step Functions history with full I/O

If the requirement were "run a script on one machine and check it succeeded," SSM Automation alone would be sufficient. The Kubernetes node join protocol requires cross-machine sequencing, which is exactly the problem Step Functions is designed to solve.

---

## Potential Future Improvements

- **SM-B script delivery**: Consider baking stable config scripts into the AMI (separate path from bootstrap). Only truly dynamic secrets need runtime S3 pull. This would make SM-B resilient to S3 outages.
- **SSM Automation document cleanup**: If the backwards-compat path is never exercised, the Automation documents add maintenance surface without benefit. Consider removing after confirming no user-data references remain.
- **Step Functions Express vs Standard**: SM-A uses Standard workflows (required for long-running polling). SM-B could use Express if execution duration stays under 5 minutes, reducing cost.
