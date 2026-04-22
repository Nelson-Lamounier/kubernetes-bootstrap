# Kubernetes-Bootstrap: Technical Audit Report

> **Scope**: `infra/` (CDK TypeScript) and `system/` (Python orchestration)
> **Objective**: Identify design gaps, anti-patterns, dead code, and assess TypeScript migration feasibility.

---

## Table of Contents

1. [Repository Overview](#1-repository-overview)
2. [Infra Layer Audit (`infra/`)](#2-infra-layer-audit)
3. [System Layer Audit (`system/`)](#3-system-layer-audit)
4. [Dead Code Inventory](#4-dead-code-inventory)
5. [Design Gaps & Anti-Patterns](#5-design-gaps--anti-patterns)
6. [TypeScript Migration Feasibility](#6-typescript-migration-feasibility)
7. [Prioritised Recommendations](#7-prioritised-recommendations)

---

## 1. Repository Overview

The repository implements a two-phase Kubernetes bootstrap system on AWS:

| Layer | Location | Language | Purpose |
|-------|----------|----------|---------|
| CDK Infrastructure | `infra/` | TypeScript | IAM, Step Functions, SSM documents, EventBridge, CloudWatch |
| Bootstrap Orchestration | `system/argocd/` | Python | Runtime K8s + ArgoCD configuration on the EC2 node |
| Auxiliary Scripts | `system/cert-manager/`, `system/dr/`, `system/arc/` | Python/Shell | TLS persistence, etcd DR, GitHub Actions Runner |
| CDK App Entry | `infra/bin/app.ts` | TypeScript | Stack resolution + instantiation |

**Execution Flow:**

```
EC2 Launch (UserData via AMI)
  └─> SM-A (Step Functions): BootstrapOrchestratorConstruct
        └─> SSM Automation Document: bootstrapDocName
              └─> S3 sync + bash: bootstrap-argocd.sh
                    └─> Python: bootstrap_argocd.py
                          ├─> steps/install.py  (Steps 1–4c)
                          ├─> steps/namespace.py (Step 4d)
                          ├─> steps/networking.py (Step 4e–4f)
                          ├─> steps/apps.py     (Steps 5–5e)
                          ├─> steps/auth.py     (Steps 8–11)
                          └─> [EventBridge trigger]
                                └─> SM-B: ConfigOrchestratorConstruct
                                      └─> SSM Automation Document: deployDocName
                                            └─> S3 sync + bash: deploy.sh → deploy.py
```

---

## 2. Infra Layer Audit

### 2.1 `ssm-automation-stack.ts` — Stack Entrypoint

**Strengths:**
- Clean separation of concerns: IAM, SM-A, SM-B, cleanup, alarm are each separate constructs.
- `ResourceCleanupProvider` elegantly solves the CFN orphan-resource problem.
- `cdk-nag` is integrated, enforcing AwsSolutions rule compliance.
- Construct-level outputs (SSM param names, state machine ARNs) are exported for downstream stacks.

**Gaps identified:**

| # | Gap | Severity |
|---|-----|----------|
| G1 | `deploySecretsDocName` is defined in the stack but its usage cannot be confirmed from any downstream consumer. Possible dead infrastructure. | Medium |
| G2 | `notificationEmail` for `BootstrapAlarmConstruct` is hardcoded via environment config rather than injected via SSM or Secrets Manager, creating a redeploy requirement for email changes. | Low |
| G3 | The `K8sSsmAutomationStack` creates both SM-A and SM-B in the same stack. If SM-B config iterates frequently, the shared stack creates unnecessary deploy coupling. | Low |

---

### 2.2 `bootstrap-orchestrator.ts` — SM-A (Cluster Infrastructure)

**Strengths:**
- The `routerFunction` (Lambda) correctly resolves ASG tags at runtime rather than baking in instance IDs at deploy time — this is the right pattern for auto-scaling groups.
- Uses `sfn_tasks.LambdaInvoke` with `.addRetry()` for transient failures.
- `waitForBootstrap` polling loop is cleanly modelled as a Step Functions Wait + Choice state.

**Critical Anti-Patterns:**

#### AP-1: Inline Python in Lambda (High Severity)

The `routerFunction` Lambda contains a significant block of inline Python code embedded as a TypeScript string literal:

```typescript
// Inside bootstrap-orchestrator.ts
const routerFunction = new lambda.Function(this, 'RouterFunction', {
    runtime: lambda.Runtime.PYTHON_3_12,
    code: lambda.Code.fromInline(`
import boto3
import json
...
`),
```

**Problems:**
- No IDE support (syntax highlighting, autocomplete, type checking).
- Cannot be unit tested in isolation — the function is destroyed and rebuilt on every CDK synth.
- ESLint/Prettier have no visibility into this code.
- The string is not type-safe — a python syntax error becomes a runtime failure post-deploy.
- Refactoring is painful: even simple changes require touching the CDK construct file.

**Recommendation:** Extract to `infra/lib/lambda/router-function/index.py` (or migrate to TypeScript `index.ts`) and use `lambda.Code.fromAsset()`.

---

#### AP-2: `waitForBootstrap` SSM Polling via Step Functions (Medium Severity)

The orchestrator polls SSM parameters in a tight loop (every 60s) to detect bootstrap completion. The current design:

```
Wait(60s) → Lambda(checkStatus) → Choice → [Done | Retry | Fail]
```

This works but has cost implications: each Lambda invocation costs money and each iteration consumes a Step Functions history entry (hard limit: 25,000 events per execution). On a slow bootstrap (>20min), this generates ~300 history events from polling alone.

**Recommendation:** Replace the polling loop with an EventBridge rule triggered by the SSM parameter `PutParameter` event on the completion marker, eliminating all polling cost and staying well under the history limit.

---

#### AP-3: No Dead-Letter Queue on `routerFunction` (Low Severity)

The router Lambda has `.addRetry()` but no DLQ configured. A failure that exhausts all retry attempts is silently dropped — SM-A continues but may send a `SendCommand` to the wrong or no instances.

---

### 2.3 `automation-document.ts` — SSM Automation Document

**Strengths:**
- The `AutomationDocumentConstruct` cleanly abstracts two document categories (`bootstrap` and `deploy`) behind a shared interface.
- S3 sync logic is parameterised and reusable.
- `updateMethod: 'NewVersion'` ensures document history is preserved across CDK updates.

**Gaps:**

| # | Gap |
|---|-----|
| G4 | The embedded shell script inside the SSM document (`set -exo pipefail; aws s3 sync...`) is not tested. A shell syntax error will only surface during an actual bootstrap. |
| G5 | The `--exact-timestamps` flag on `aws s3 sync` is not used, meaning unchanged files may be re-downloaded on every execution, adding unnecessary latency. |
| G6 | The S3 sync and script execution are in the same SSM step. Separating them would allow independent retries (e.g., retry just the sync without re-running setup). |

---

### 2.4 `config-orchestrator.ts` — SM-B (Application Config)

**Strengths:**
- Correctly triggered by SM-A completion via EventBridge (`sfn:executionStatus` = `SUCCEEDED`).
- Independent retry logic from SM-A.

**Gaps:**

| # | Gap |
|---|-----|
| G7 | The EventBridge rule that triggers SM-B matches on SM-A's ARN. If SM-A is recreated (e.g., after a `cdk destroy`), the ARN changes and the EventBridge trigger silently stops working until the stack is redeployed. This is a configuration drift risk. |
| G8 | SM-B has no alarm construct of its own — only SM-A is wired to `BootstrapAlarmConstruct`. SM-B failures (e.g., Grafana credential injection failure) go unnoticed. |

---

### 2.5 `resource-cleanup-provider.ts` — Custom Resource

**Strengths:**
- This is the most sophisticated construct in the repo. The `onEvent` Lambda correctly pre-deletes Log Groups and SSM Parameters before a CFN `Create` or `Update`, preventing the "already exists" CFN failure on re-deploys.
- Correctly handles the `cfnresponse` protocol.

**Gaps:**

| # | Gap |
|---|-----|
| G9 | The cleanup Lambda's timeout is 15 minutes (default). If there are many Log Groups to delete (e.g., large-scale deployments), this could time out mid-cleanup, leaving resources in a partially deleted state. A configurable timeout property would improve robustness. |
| G10 | The cleanup Lambda uses `any` type in places, bypassing TypeScript's type safety for the event payload shape. |

---

### 2.6 `node-drift-enforcement.ts` — SSM State Manager

**Strengths:**
- Using SSM State Manager Associations at a 30-min schedule is the correct pattern for enforcement (vs. one-shot correction).
- Enforces kernel modules, sysctl, and service states — a genuine production-hardening component.

**Gaps:**

| # | Gap |
|---|-----|
| G11 | The drift-enforcement script enforces sysctl and kernel modules but does not validate that the `containerd` or `kubelet` versions match the expected AMI version. Version drift is possible without triggering the association. |
| G12 | There is no CloudWatch metric filter or alarm wired to the State Manager execution results. Failed enforcement runs are visible in SSM Console but not auto-alerted. |

---

### 2.7 `ssm-run-command-document.ts` & `ssm-parameter-store.ts`

Both constructs are well-written, reusable, and properly typed. The `ssm-run-command-document.ts` construct is the correct abstraction for SSM Command documents.

> [!NOTE]
> `ssm-parameter-store.ts` appears to be a standalone utility that defines a standardised parameter path hierarchy. It is referenced in the stack but could potentially be extracted into a shared library for cross-stack usage.

---

## 3. System Layer Audit

### 3.1 Entry Points

**`bootstrap-argocd.sh`** — Thin Bash wrapper. Handles `pip3` installation on Amazon Linux 2023 where `pip3` is absent from PATH. This is correct and necessary.

**`bootstrap_argocd.py`** — Main orchestrator. Calls step functions sequentially with a `BootstrapLogger` context manager per step. Step errors that raise exceptions are logged and swallowed for "non-fatal" steps; hard failures propagate and terminate the script.

**`helpers/config.py`** — `Config` dataclass with `@property env`. Clean, minimal.

**`helpers/runner.py`** — Wraps `subprocess.run`, sets `KUBECONFIG` and `HOME`, lazy-imports boto3. The lazy import is intentional for test environments without boto3.

**`helpers/logger.py`** — `BootstrapLogger` with CloudWatch-native JSON structured logging + SSM Parameter Store step-status markers. Sophisticated and production-grade.

---

### 3.2 Step Modules

#### `steps/install.py` (Steps 1–4c)
Covers: kubeadm init, kubeconfig setup, ArgoCD namespace, ArgoCD installation, rootpath configuration, signing key restore.

**Gaps:**
- Step 3b (signing key restore) and Step 4c (rootpath config) both trigger `kubectl rollout restart argocd-server`. The `create_ci_bot` function in `auth.py` guards against this with a pre-check, but `install.py` does not — if Step 4c rolls out slowly, Step 3b's restart races with it.
- ArgoCD `install.yaml` is vendored in-repo (`system/argocd/install.yaml` — **1.89 MB**). This is the entire ArgoCD manifest. It will become stale silently as upstream releases. There is no automated pinning or update check.

#### `steps/namespace.py` (Step 4d)
Covers: K8s namespace creation, labels, resource quotas.

Clean and minimal. No significant gaps.

#### `steps/networking.py` (Steps 4e–4f)
Covers: Traefik IngressRoute for ArgoCD, rate-limit Middleware, network policies.

**Gaps:**
- Traefik middleware `rate-limit-middleware.yaml` is applied as a static file. If Traefik CRDs are not yet installed, `kubectl apply` fails with "no matches for kind Middleware". The step does not poll for CRD readiness before applying.

#### `steps/apps.py` (Steps 5–5e)
The largest step file at 873 lines. Covers: root app application, monitoring Helm params, Prometheus basic auth, ECR credentials seed, Crossplane credentials, TLS restore, cert-manager ClusterIssuer, ArgoCD Notifications secret.

**Gaps:**

| # | Gap | Severity |
|---|-----|----------|
| A1 | `env_short = cfg.env[:3]` on line 354 to derive `"dev"` from `"development"` is fragile. If the environment name changes (e.g., `"staging"` → `"sta"`), the Secrets Manager path will silently break. | High |
| A2 | The ECR registry ID `771826808455` is hardcoded in `seed_ecr_credentials` (line 263). This is a specific AWS account ID baked into the source code. | High |
| A3 | `inject_monitoring_helm_params` creates a new `get_ssm_client(cfg)` inside the inner `for` loop (lines 90–91), creating a new boto3 client on every IP address iteration. The client should be created once outside the loop. | Low |
| A4 | `apply_cert_manager_issuer` embeds the Let's Encrypt email address `lamounierleao2025@outlook.com` as a hardcoded string (line 648). This is a personal email address in source code — it should be an SSM parameter or config field. | Medium |
| A5 | `provision_crossplane_credentials` stores raw IAM access key credentials in a K8s `Opaque` Secret. This is a [known security concern](https://github.com/crossplane-contrib/provider-aws/issues/1153). The recommended pattern is pod identity/IRSA. | Medium |

#### `steps/auth.py` (Steps 8–11)
Covers: ArgoCD CLI install, CI bot account, token generation, admin password, TLS backup, signing key backup, summary.

**Strengths:**
- `generate_ci_token` has a three-attempt retry with progressive backoff (15s, 30s, 60s).
- Token is validated against the ArgoCD API before being written to Secrets Manager — "safe store" pattern.
- `create_ci_bot` guards against double rollout with a pre-check before restarting `argocd-server`.

**Gaps:**

| # | Gap | Severity |
|---|-----|----------|
| A6 | `install_argocd_cli` downloads the binary via `curl` at step runtime with no checksum verification. A MITM or GitHub release corruption could install a malicious binary. | Medium |
| A7 | `_ARGOCD_API_ENDPOINT = "argocd-server.argocd.svc.cluster.local"` is a module-level constant (line 215) but is referenced only in `generate_ci_token`. It should either be in `Config` or documented as an intentional constant. | Low |
| A8 | `backup_tls_cert` waits up to 5 minutes (10 × 30s) for the TLS secret, polling every 30 seconds via `subprocess.run`. This is blocking — no timeout escalation or early-exit if cert-manager is clearly unhealthy. | Low |

---

### 3.3 `helpers/logger.py` — `BootstrapLogger`

**Production-grade.** The CloudWatch JSON emission pattern, SSM status markers, and context manager step lifecycle are all exemplary. The 3 KB truncation on error messages is a thoughtful workaround for the SSM Standard tier 4 KB limit.

**One gap:** `_write_ssm_status` imports `boto3` inside the method on every call. Since the logger is long-lived (used throughout bootstrap), the client should be cached after first instantiation.

---

## 4. Dead Code Inventory

The following items appear unused or superseded based on structural analysis:

| Item | Location | Evidence of Dead Status | Recommendation |
|------|----------|------------------------|----------------|
| `deploySecretsDocName` SSM Document | `ssm-automation-stack.ts` | SSM document name is exported, but no downstream stack or CDK construct references it. SM-B uses `deployDocName`, not `deploySecretsDocName`. | **Audit cross-repo** (e.g., `cdk-monitoring`). If not referenced, delete. |
| `system/argocd/ingress.yaml` | `system/argocd/ingress.yaml` | Defines a Traefik `IngressRoute` for ArgoCD. The same configuration is applied dynamically by `steps/networking.py`. Static YAML may be legacy. | Verify if still used in any `kubectl apply`. If not, delete. |
| `system/argocd/bootstrap-argocd.sh` | `system/argocd/` | The `.sh` wrapper is a thin delegator to the Python script. The SSM document could call `python3 bootstrap_argocd.py` directly. | Keep if caller compatibility is needed; otherwise inline into SSM document. |
| `system/arc/` subdirectory | `system/arc/` | GitHub Actions Runner self-hosted setup scripts. Not referenced by any SSM document or Step Functions workflow. | Assess if ARC is used in production. If not, move to `docs/` or delete. |
| `BootstrapLogger.warn()` method | `helpers/logger.py:110` | Method exists but `grep` reveals zero call sites in `bootstrap_argocd.py` or any step module. `log()` from `runner.py` is used for warnings everywhere. | Either use it consistently or remove it. |

---

## 5. Design Gaps & Anti-Patterns

### AP Summary Table

| ID | Anti-Pattern | Location | Severity |
|----|-------------|----------|----------|
| AP-1 | Inline Python Lambda code in CDK construct | `bootstrap-orchestrator.ts` | 🔴 High |
| AP-2 | Step Functions polling loop vs. event-driven completion detection | `bootstrap-orchestrator.ts` | 🟡 Medium |
| AP-3 | No DLQ on critical router Lambda | `bootstrap-orchestrator.ts` | 🟡 Medium |
| AP-4 | Mixed language stack (TypeScript CDK + Python runtime) | Entire repo | 🟡 Medium |
| AP-5 | Hardcoded account ID in source code | `steps/apps.py:263` | 🔴 High |
| AP-6 | Hardcoded personal email in Let's Encrypt issuer manifest | `steps/apps.py:648` | 🟡 Medium |
| AP-7 | Fragile string slicing for environment name derivation | `steps/apps.py:354` | 🔴 High |
| AP-8 | No alarm on SM-B failure | `config-orchestrator.ts` | 🟡 Medium |
| AP-9 | Vendored 1.89 MB ArgoCD install manifest with no version tracking | `system/argocd/install.yaml` | 🟡 Medium |
| AP-10 | IAM access key credentials in K8s Opaque Secret for Crossplane | `steps/apps.py` | 🟡 Medium |
| AP-11 | ArgoCD CLI downloaded at runtime with no checksum verification | `steps/auth.py` | 🟡 Medium |
| AP-12 | boto3 client created per-loop-iteration rather than once | `steps/apps.py:90` | 🟢 Low |
| AP-13 | boto3 client not cached in `BootstrapLogger` | `helpers/logger.py` | 🟢 Low |

---

### Gap Summary Table

| ID | Gap | Location | Severity |
|----|-----|----------|----------|
| G1 | `deploySecretsDocName` document may be dead infrastructure | `ssm-automation-stack.ts` | 🟡 Medium |
| G7 | EventBridge trigger uses SM-A ARN (breaks on stack recreation) | `config-orchestrator.ts` | 🟡 Medium |
| G8 | SM-B has no CloudWatch alarm | `config-orchestrator.ts` | 🟡 Medium |
| G11 | Drift enforcement doesn't check kubelet/containerd version | `node-drift-enforcement.ts` | 🟢 Low |
| G12 | No alarm on drift enforcement failures | `node-drift-enforcement.ts` | 🟢 Low |
| A1 | `env[:3]` fragile environment name slicing | `steps/apps.py:354` | 🔴 High |
| A2 | Hardcoded AWS account ID | `steps/apps.py:263` | 🔴 High |
| A4 | Hardcoded personal email in ClusterIssuer | `steps/apps.py:648` | 🟡 Medium |

---

## 6. TypeScript Migration Feasibility

### 6.1 Migration Rationale

The core case for migration is stack unification:

| Concern | Python | TypeScript |
|---------|--------|------------|
| Type safety | Runtime errors only | Compile-time, shared interfaces with CDK |
| Dependency mgmt | `requirements.txt` + `venv` | `package.json` + `yarn` (already used) |
| IDE support | PyRight/Pylance (separate setup) | Same VSCode as CDK — full IntelliSense |
| Test framework | `pytest` (55 tests, offline) | `jest` (already used for CDK tests) |
| AWS SDK | `boto3` | `@aws-sdk/client-ssm`, `@aws-sdk/client-secretsmanager` |
| K8s SDK | `kubernetes` Python client | `@kubernetes/client-node` |
| Lambda inline code | N/A — Python string in TS | Native TS, same language as Lambda runtime |

### 6.2 Component-by-Component Assessment

#### `helpers/config.py` → `src/config.ts`

**Effort: Low.** Direct mapping. The `Config` dataclass becomes a TypeScript interface + factory function.

```typescript
// Before (Python)
@dataclass
class Config:
    ssm_prefix: str = field(default_factory=lambda: os.environ.get("SSM_PREFIX", "/k8s/development"))

// After (TypeScript)
export interface BootstrapConfig {
  readonly ssmPrefix: string;
  readonly awsRegion: string;
  readonly kubeconfig: string;
  readonly argocdDir: string;
  readonly argocdCliVersion: string;
  readonly argoTimeout: number;
  readonly dryRun: boolean;
}

export function loadConfig(): BootstrapConfig {
  return {
    ssmPrefix: process.env.SSM_PREFIX ?? '/k8s/development',
    ...
  };
}
```

This `BootstrapConfig` interface can be **shared between the CDK stack and the runtime scripts** — the single greatest type-safety benefit of the migration.

---

#### `helpers/runner.py` → `src/subprocess-runner.ts`

**Effort: Low.** Node.js `child_process.spawnSync` is the direct equivalent of `subprocess.run`. The dry-run wrapper is trivial:

```typescript
import { spawnSync, SpawnSyncReturns } from 'child_process';

export function run(
  cmd: string[],
  opts: { cfg: BootstrapConfig; check?: boolean; capture?: boolean }
): SpawnSyncReturns<string> {
  if (opts.cfg.dryRun) {
    console.log(`  [DRY-RUN] ${cmd.join(' ')}`);
    return { status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null };
  }
  return spawnSync(cmd[0], cmd.slice(1), {
    env: { ...process.env, KUBECONFIG: opts.cfg.kubeconfig, HOME: process.env.HOME ?? '/root' },
    encoding: 'utf-8',
  });
}
```

---

#### `helpers/logger.py` → `src/logger.ts`

**Effort: Medium.** The structured JSON logging and SSM status markers are straightforward to replicate. The `boto3` client can be replaced with `SSMClient` from `@aws-sdk/client-ssm`. The context manager pattern (`with logger.step(...):`) becomes an `async` wrapper function:

```typescript
export async function withStep<T>(
  logger: BootstrapLogger,
  stepName: string,
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  logger.emit(stepName, 'info', 'start');
  try {
    const result = await fn();
    logger.emit(stepName, 'info', 'success', { durationMs: Date.now() - start });
    return result;
  } catch (err) {
    logger.emit(stepName, 'error', 'fail', { msg: String(err), durationMs: Date.now() - start });
    throw err;
  }
}
```

---

#### `bootstrap_argocd.py` → `src/bootstrap.ts`

**Effort: Low.** This is a sequential orchestration script. The Python step call sequence translates directly to a TypeScript `main()` with `await` calls.

---

#### `steps/*.py` → `src/steps/*.ts`

**Effort: High.** This is the bulk of the migration work. Key considerations:

| Step | Python-Specific Dependency | TypeScript Equivalent |
|------|---------------------------|----------------------|
| All steps | `subprocess.run` | `child_process.spawnSync` |
| `apps.py`, `auth.py` | `boto3.client("ssm")` | `@aws-sdk/client-ssm` |
| `apps.py`, `auth.py` | `boto3.client("secretsmanager")` | `@aws-sdk/client-secrets-manager` |
| `apps.py`, `auth.py` | `boto3.client("ecr")` | `@aws-sdk/client-ecr` |
| `apps.py` seed_prometheus | `kubernetes.client` | `@kubernetes/client-node` |
| `apps.py` seed_ecr | `kubernetes.client` | `@kubernetes/client-node` |
| `auth.py` set_admin_password | `bcrypt` library | `bcrypt` npm package |

The `@kubernetes/client-node` SDK is mature and well-maintained. AWS SDK v3 for JS is the preferred SDK. Both have TypeScript types built-in — unlike `boto3` which relies on `boto3-stubs`.

---

#### `routerFunction` Lambda (inline Python) → `infra/lib/lambda/router/index.ts`

**Effort: Low — Highest Impact.** This is the most impactful quick win. Migrating the inline Python to a TypeScript Lambda:

- Eliminates AP-1 (inline code) immediately.
- Enables unit testing with `jest`.
- Allows CDK to bundle with `esbuild` via `lambda.Code.fromAsset()`.
- The Lambda runtime is already available as `lambda.Runtime.NODEJS_22_X`.

---

### 6.3 Migration Blockers

| Blocker | Detail | Mitigation |
|---------|--------|------------|
| `bcrypt` on EC2 during bootstrap | The `bcrypt` npm package requires native compilation. On Amazon Linux 2023, `node-gyp` must be available. | Use `bcryptjs` (pure-JS port, no native compilation) — slightly slower but zero build dependencies. |
| `@kubernetes/client-node` load time | The K8s client library is heavier than boto3 at cold start. | Pre-install via `npm ci` in the SSM document (same as current `pip install`). |
| `ts-node` on the EC2 node | Running TypeScript directly on the node requires `ts-node` and `@types/*`. | Pre-compile to JS via `tsc` as a CI/CD step, bundle output to S3 rather than source. |
| Shared `install.yaml` (1.89 MB) | This is not Python-specific — it's the same regardless of language. | No change needed; `kubectl apply -f install.yaml` works the same in TS. |

---

### 6.4 Recommended Migration Path

**Phase 1 — Quick Wins (1–2 days)**
1. Extract the `routerFunction` inline Python → `infra/lib/lambda/router/index.ts` (AP-1).
2. Fix AP-5: Replace hardcoded ECR account ID with `cfg.awsAccountId` from CDK environment.
3. Fix AP-7: Replace `cfg.env[:3]` with a proper `ENV_SHORT_MAP` dictionary.
4. Fix A4: Move the Let's Encrypt email to SSM parameter `{ssm_prefix}/letsencrypt-email`.

**Phase 2 — Helpers Migration (1 day)**
5. Migrate `helpers/config.py` + `helpers/runner.py` + `helpers/logger.py` → `src/helpers/`.
6. Expose `BootstrapConfig` interface as a shared type in `infra/lib/types/bootstrap-config.ts`.

**Phase 3 — Step Modules (3–5 days)**
7. Migrate `steps/` one module at a time, running existing `pytest` suite against Python reference to verify equivalence.
8. Write `jest` unit tests for each TypeScript step using `jest.spyOn` for `child_process` and `aws-sdk` mocks.

**Phase 4 — Cleanup (1 day)**
9. Remove Python `requirements.txt`, `helpers/`, `steps/`.
10. Update the SSM document to execute `node /data/k8s-bootstrap/system/argocd/dist/bootstrap.js`.
11. Update CI/CD pipeline to run `tsc` and upload compiled JS to S3.

---

## 7. Prioritised Recommendations

### 🔴 Critical — Fix Immediately

| # | Action | File |
|---|--------|------|
| R1 | Remove hardcoded AWS account ID `771826808455` — inject from CDK env or SSM | `steps/apps.py:263` |
| R2 | Remove fragile `env[:3]` slicing — use an explicit `ENV_SHORT = { "development": "dev", "staging": "stg", "production": "prd" }` lookup table | `steps/apps.py:354` |
| R3 | Move Let's Encrypt email (`lamounierleao2025@outlook.com`) to SSM parameter `{ssm_prefix}/letsencrypt-email` | `steps/apps.py:648` |

### 🟡 High Priority — Address in Next Sprint

| # | Action | File |
|---|--------|------|
| R4 | Extract `routerFunction` inline Python → standalone Lambda asset | `bootstrap-orchestrator.ts` |
| R5 | Add `BootstrapAlarmConstruct` to SM-B | `config-orchestrator.ts` |
| R6 | Add DLQ to `routerFunction` Lambda | `bootstrap-orchestrator.ts` |
| R7 | Verify or delete `deploySecretsDocName` SSM document | `ssm-automation-stack.ts` |
| R8 | Verify or delete `BootstrapLogger.warn()` method | `helpers/logger.py:110` |
| R9 | Cache boto3 client in `BootstrapLogger._write_ssm_status` | `helpers/logger.py` |
| R10 | Move `get_ssm_client()` call outside the IP loop in `inject_monitoring_helm_params` | `steps/apps.py:90` |

### 🟢 Medium Priority — Roadmap Items

| # | Action |
|---|--------|
| R11 | Add SHA-256 checksum verification to ArgoCD CLI download |
| R12 | Replace EventBridge rule ARN-based SM-A dependency with a name-based reference |
| R13 | Add a CloudWatch metric filter + alarm for SSM State Manager drift enforcement failures |
| R14 | Replace Crossplane IAM user credentials with IRSA (pod identity) |
| R15 | Begin TypeScript migration Phase 1 (see §6.4) |
| R16 | Pin the vendored `install.yaml` version via a comment or hash, add a Renovate/Dependabot rule |

---

*Generated: 2026-04-21 — kubernetes-bootstrap repository audit*
