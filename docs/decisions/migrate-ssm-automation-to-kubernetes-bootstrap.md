# Migrate SSM Automation Stack to kubernetes-bootstrap

Duplicate the SSM Automation CDK infrastructure into `kubernetes-bootstrap` so the repository stands alone as a complete bootstrap orchestration implementation — scripts, CDK infrastructure, CD tooling, and CI/CD pipelines.

## Context

The SSM Automation Stack (`ssm-automation-stack.ts`) creates:
- **SM-A**: Step Functions bootstrap orchestrator (control-plane + worker node provisioning)
- **SM-B**: Step Functions config orchestrator (deploy.py secret injection)
- SSM Automation documents, Run Command documents, CloudWatch alarms, node drift enforcement, and resource cleanup providers

Currently, these 2,766 lines of CDK constructs + 726-line stack live inside `cdk-monitoring`. The bootstrap scripts (Python) have already been extracted to `kubernetes-bootstrap`. Moving the CDK code alongside them creates a self-contained repository that proves the full orchestration lifecycle.

---

## User Review Required

> [!IMPORTANT]
> **Deployment Strategy**: The duplicated CDK stack in `kubernetes-bootstrap` will need its own deployment pipeline. Two options:
> 1. **Independent CDK deploy** — `kubernetes-bootstrap` has its own `cdk deploy` workflow with OIDC credentials. The production SSM stack is deployed from here.
> 2. **Cross-repo dispatch** — `kubernetes-bootstrap` dispatches to `cdk-monitoring` which still owns the actual `cdk deploy`. The CDK code in `kubernetes-bootstrap` exists as documentation/reference.
>
> **Recommendation**: Option 1 — full independence. The stack already uses SSM parameter lookups (no CloudFormation cross-stack exports), so it can deploy standalone.

> [!WARNING]
> **Dual Ownership Window**: During migration, both `cdk-monitoring` and `kubernetes-bootstrap` will have the SSM stack code. Once verified, the `cdk-monitoring` copy should be removed to avoid drift. The monorepo's `kubernetes` factory will need updating to remove the SSM stack instantiation.

> [!IMPORTANT]
> **`@repo/script-utils` Dependency**: The CD scripts (`sync-bootstrap-scripts.ts`, `trigger-bootstrap.ts`, etc.) depend on the monorepo's `@repo/script-utils` package. Options:
> 1. **Vendor a copy** into `kubernetes-bootstrap/scripts/lib/` (same as `deploy_helpers` pattern)
> 2. **Publish `script-utils` to npm** (private package) — overkill for a solo-dev repo
>
> **Recommendation**: Option 1 — vendor the subset of utilities used by the 5 CD scripts.

---

## Dependency Map

### CDK Files to Duplicate (from `cdk-monitoring/infra/lib/`)

| Source File | Lines | Dependencies |
|---|---|---|
| `stacks/kubernetes/ssm-automation-stack.ts` | 726 | Environment, K8sConfigs, all SSM constructs |
| `constructs/ssm/automation-document.ts` | 336 | CDK only |
| `constructs/ssm/bootstrap-alarm.ts` | 100 | CDK only |
| `constructs/ssm/bootstrap-orchestrator.ts` | 805 | CDK only |
| `constructs/ssm/config-orchestrator.ts` | 415 | CDK only |
| `constructs/ssm/node-drift-enforcement.ts` | 297 | Environment |
| `constructs/ssm/resource-cleanup-provider.ts` | 410 | CDK only |
| `constructs/ssm/ssm-parameter-store.ts` | 152 | CDK only |
| `constructs/ssm/ssm-run-command-document.ts` | 229 | CDK only |
| `constructs/ssm/index.ts` | 22 | Re-exports |
| **Total constructs** | **2,766** | |

### Config Files to Duplicate (from `cdk-monitoring/infra/lib/config/`)

| Source File | Lines | What to Copy |
|---|---|---|
| `environments.ts` | 261 | Full file — Environment enum, account IDs, helpers |
| `kubernetes/configurations.ts` | 779 | Full file — K8sConfigs, all interfaces, env configs |
| `kubernetes/index.ts` | ~10 | Re-export barrel |
| `ssm-paths.ts` | 769 | Only the `k8sSsmPaths()` section (~120 lines) |

### CD Scripts to Duplicate (from `cdk-monitoring/infra/scripts/cd/`)

| Source File | Lines | `@repo/script-utils` Usage |
|---|---|---|
| `sync-bootstrap-scripts.ts` | 312 | `parseArgs`, `buildAwsConfig`, `getSSMParameter`, `runCommand`, `writeSummary`, `emitAnnotation`, `logger` |
| `trigger-bootstrap.ts` | 615 | `parseArgs`, `buildAwsConfig`, `setOutput`, `writeSummary`, `emitAnnotation`, `logger` |
| `trigger-config.ts` | 282 | `parseArgs`, `buildAwsConfig`, `writeSummary`, `emitAnnotation`, `logger` |
| `observe-bootstrap.ts` | 446 | `parseArgs`, `buildAwsConfig`, `logger` |
| `verify-argocd-sync.ts` | 897 | `parseArgs`, `buildAwsConfig`, `logger` |
| **Total** | **2,552** | |

### Workflows to Migrate (from `cdk-monitoring/.github/workflows/`)

| Source File | Lines | Action |
|---|---|---|
| `deploy-ssm-automation.yml` | 68 | Move (trigger workflow) |
| `_deploy-ssm-automation.yml` | 499 | Move (reusable S3 sync + SM-A) |
| `_post-bootstrap-config.yml` | 535 | Move (reusable SM-B + verify) |
| `deploy-post-bootstrap.yml` | 109 | Move (standalone SM-B) |
| `build-ci-image.yml` | 141 | **Keep in both** (shared CI image) |

### Composite Actions to Duplicate (from `cdk-monitoring/.github/actions/`)

| Action | Purpose |
|---|---|
| `setup-node-yarn/` | Install Node.js + Yarn + cache |
| `configure-aws/` | OIDC → AWS credentials |

---

## Proposed Changes

### Phase 1: CDK Infrastructure Scaffolding

Set up `kubernetes-bootstrap` as a standalone CDK project with all SSM orchestration constructs.

---

#### [NEW] `infra/package.json`

New CDK package with `aws-cdk-lib`, `constructs`, `cdk-nag`, TypeScript tooling. Uses `yarn` per global standards.

#### [NEW] `infra/tsconfig.json`

Strict TypeScript config targeting ES2022/Node18, matching `cdk-monitoring` conventions.

#### [NEW] `infra/cdk.json`

CDK app configuration with context values for environment resolution.

#### [NEW] `infra/bin/app.ts`

CDK app entry point. Instantiates `K8sSsmAutomationStack` with environment-resolved config.

#### [NEW] `infra/lib/stacks/ssm-automation-stack.ts`

Duplicated from [ssm-automation-stack.ts](file:///Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring/infra/lib/stacks/kubernetes/ssm-automation-stack.ts). Import paths updated to local constructs.

#### [NEW] `infra/lib/constructs/ssm/` (9 files + index)

Duplicated from [ssm/](file:///Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring/infra/lib/constructs/ssm/). All 2,766 lines of constructs copied verbatim.

#### [NEW] `infra/lib/config/environments.ts`

Duplicated from [environments.ts](file:///Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring/infra/lib/config/environments.ts). Full file — Environment enum, account mappings, helpers.

#### [NEW] `infra/lib/config/kubernetes/configurations.ts`

Duplicated from [configurations.ts](file:///Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring/infra/lib/config/kubernetes/configurations.ts). Full K8sConfigs interface and all environment configs (779 lines).

#### [NEW] `infra/lib/config/ssm-paths.ts`

Subset of [ssm-paths.ts](file:///Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring/infra/lib/config/ssm-paths.ts). Only `k8sSsmPrefix()`, `K8sSsmPaths` interface, and `k8sSsmPaths()` function (~120 lines).

---

### Phase 2: CD Script Migration

Migrate the TypeScript CD scripts with vendored `script-utils`.

---

#### [NEW] `scripts/lib/` (vendored script-utils)

Subset of `@repo/script-utils` needed by the 5 CD scripts:
- `aws.ts` — `parseArgs()`, `buildAwsConfig()`, `getSSMParameter()`
- `exec.ts` — `runCommand()`
- `github.ts` — `writeSummary()`, `emitAnnotation()`, `setOutput()`
- `logger.ts` — Structured logger

#### [MODIFY] `scripts/sync-bootstrap-scripts.ts`

Update imports from `@repo/script-utils/*` → `./lib/*`. Update S3 source paths to reference local repo root instead of monorepo `kubernetes-app/k8s-bootstrap/`.

#### [MODIFY] `scripts/trigger-bootstrap.ts`, `trigger-config.ts`, `observe-bootstrap.ts`, `verify-argocd-sync.ts`

Same import path updates. These already exist at `scripts/` in the bootstrap repo but need the vendored lib.

#### [NEW] `scripts/package.json` + `scripts/tsconfig.json`

Standalone TypeScript project for the CD scripts. Dependencies: `@aws-sdk/client-ssm`, `@aws-sdk/client-sfn`, `@aws-sdk/client-s3`.

---

### Phase 3: Workflow Migration

Migrate CI/CD workflows to `kubernetes-bootstrap` with self-contained composite actions.

---

#### [NEW] `.github/actions/setup-node-yarn/action.yml`

Vendored copy of the composite action from `cdk-monitoring`.

#### [NEW] `.github/actions/configure-aws/action.yml`

Vendored copy of the OIDC credential action.

#### [NEW] `.github/workflows/deploy-ssm-automation.yml`

Trigger workflow — `workflow_dispatch` + path filters for `boot/`, `system/`, `deploy_helpers/`, `infra/`.

#### [NEW] `.github/workflows/_deploy-ssm-automation.yml`

Reusable workflow: CDK deploy + S3 sync + SM-A bootstrap trigger. Updated to:
- Use local composite actions
- Run `just build` from bootstrap repo root
- Reference local script paths

#### [NEW] `.github/workflows/_post-bootstrap-config.yml`

Reusable SM-B config injection + ArgoCD verify. Updated references.

#### [NEW] `.github/workflows/deploy-post-bootstrap.yml`

Standalone SM-B trigger. Updated references.

#### [NEW] `.github/workflows/deploy-cdk.yml`

New workflow: `cdk deploy` for the SSM automation stack. Triggered by changes to `infra/`.

---

### Phase 4: Monorepo Cleanup (cdk-monitoring)

Remove the SSM automation stack ownership from `cdk-monitoring`. **Execute only after Phase 1–3 are verified.**

---

#### [MODIFY] [factory.ts](file:///Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring/infra/lib/projects/kubernetes/factory.ts)

Remove `K8sSsmAutomationStack` instantiation from the Kubernetes project factory. Add a comment noting that SSM automation is now managed by `kubernetes-bootstrap`.

#### [MODIFY] [ci.yml](file:///Users/nelsonlamounier/Desktop/portfolio/cdk-monitoring/.github/workflows/ci.yml)

Remove `test-k8s-bootstrap` job and its path filter. Remove from `quality-gate` dependencies.

#### [DELETE] `deploy-ssm-automation.yml`, `_deploy-ssm-automation.yml`, `_post-bootstrap-config.yml`, `deploy-post-bootstrap.yml`

Remove migrated workflows (replaced by `kubernetes-bootstrap` repo).

#### [MODIFY] `deploy-api.yml`

Remove `PYTHONPATH: kubernetes-app/k8s-bootstrap` reference and `deploy_helpers` pip install — these now live in the bootstrap repo.

#### [MODIFY] `gitops-k8s.yml`

Remove all `kubernetes-app/k8s-bootstrap/` path references and comments.

#### [DELETE] `kubernetes-app/k8s-bootstrap/`

Remove the legacy bootstrap directory from the monorepo (already extracted to standalone repo).

---

## Open Questions

> [!IMPORTANT]
> **CI Docker Image**: The workflows currently reference `ghcr.io/nelson-lamounier/cdk-monitoring/ci:latest`. Should `kubernetes-bootstrap` build its own CI image, or continue referencing the `cdk-monitoring` one? Building a separate image provides full independence but adds maintenance overhead.

> [!IMPORTANT]
> **Justfile**: The monorepo `justfile` has recipes like `ci-sync-scripts`, `ci-trigger-bootstrap`. Should `kubernetes-bootstrap` have its own `justfile` with equivalent recipes?

---

## Verification Plan

### Automated Tests
1. `cd infra && npx cdk synth` — verify the standalone CDK synthesises without errors
2. `npx tsc --noEmit` — verify TypeScript compilation for both `infra/` and `scripts/`
3. `pytest` — existing 55 bootstrap tests pass
4. `shellcheck`, `yamllint`, `ruff` — existing linting passes

### Manual Verification
1. Push to GitHub and confirm CI workflow runs
2. Trigger `deploy-ssm-automation` workflow dispatch — verify S3 sync + SM-A execution
3. Trigger `deploy-post-bootstrap` — verify SM-B config injection
4. Confirm ArgoCD reconciliation is unaffected
5. Verify `cdk-monitoring` CI still passes after Phase 4 cleanup
