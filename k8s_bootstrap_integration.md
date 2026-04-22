# `k8s-bootstrap` Integration Audit

## What It Is

`k8s-bootstrap/` is the **on-node Python package** that runs on each EC2 instance
during its first boot. It is code that executes _inside_ EC2, not inside CI/CD or CDK.

```
kubernetes-bootstrap/
└── k8s-bootstrap/         ← on-node Python package (this review)
    ├── boot/              ← step-sequenced bootstrap runners
    │   └── steps/
    │       ├── orchestrator.py   ← entrypoint: delegates to cp or wk
    │       ├── common.py         ← shared helpers (StepRunner, run_cmd)
    │       ├── control_plane.py  ← DEAD: replaced by cp/__init__.py
    │       ├── worker.py         ← DEAD: replaced by wk/__init__.py
    │       ├── cp/               ← modular control-plane steps
    │       └── wk/               ← modular worker steps
    ├── deploy_helpers/    ← helpers used by SM-B (app-config deploy scripts)
    ├── system/            ← Kubernetes manifests (ArgoCD, Traefik, Calico, cert-manager)
    ├── scripts/           ← CI typescript utilities (fetch-boot-logs, ssm-deploy)
    └── pyproject.toml     ← Python project definition
```

---

## Integration Architecture (Current State)

The flow from repository to running EC2 is:

```
GitHub Push to main
        │
        ▼
CI: sync-bootstrap-scripts.ts
  → aws s3 sync k8s-bootstrap/ → s3://<bucket>/k8s-bootstrap/
        │
        ▼
Step Functions SM-A (BootstrapOrchestratorConstruct)
  → SSM RunCommand (bootstrap-runner document)
  → EC2 runs:
      aws s3 sync s3://<bucket>/k8s-bootstrap/boot/steps/  →  /data/k8s-bootstrap/
      python3 /data/k8s-bootstrap/boot/steps/control_plane.py   (or worker.py)
        │
        ├── Step 6: s3_sync.py → downloads system/ manifests
        ├── Step 7: argocd.py  → runs system/argocd/bootstrap-argocd.sh
        └── ...
```

> [!IMPORTANT]
> The SSM Runner (`bootstrap-runner` document) in `ssm-automation-stack.ts`
> **line 288** still hard-codes the path `boot/steps/` from S3:
> ```bash
> aws s3 sync "s3://{{S3Bucket}}/k8s-bootstrap/boot/steps/" "$STEPS_DIR/" ...
> ```
> This is the **live integration point** — S3 is the bridge between CI and EC2.

---

## Integration Gaps — What Is Missing

### Gap 1: `sync-bootstrap-scripts.ts` does not exist in this repo

The `_deploy-ssm-automation.yml` workflow (Phase 2) calls:
```bash
npx --prefix scripts tsx scripts/cd/sync-bootstrap-scripts.ts \
  --environment "$DEPLOY_ENVIRONMENT" --region "$AWS_REGION"
```

This script **does not exist** in `kubernetes-bootstrap/scripts/`:
```
scripts/
├── fetch-boot-logs.ts   ✅ exists
├── ssm-deploy.ts        ✅ exists
└── tsconfig.json        ✅ exists
```

`sync-bootstrap-scripts.ts` is **absent** — meaning the S3 sync step currently
breaks or relies on a version from `cdk-monitoring`.

---

### Gap 2: `trigger-bootstrap.ts` is not here either

Phase 4 of the same workflow calls:
```bash
npx --prefix scripts tsx scripts/cd/trigger-bootstrap.ts \
  --environment "$DEPLOY_ENVIRONMENT" --region "$AWS_REGION"
```

There is no `scripts/cd/` subdirectory in this repo. This script triggers the
Step Functions state machine and polls for completion.

---

### Gap 3: Calico PDB path is hard-coded to the old repo layout

In `boot/steps/cp/calico.py` line 25:
```python
CALICO_PDB_MANIFEST = "/opt/bootstrap/kubernetes-app/k8s-bootstrap/system/calico-pdbs.yaml"
```

This path assumes the old `kubernetes-app/k8s-bootstrap/` layout from `cdk-monitoring`.
In this repo the file is at `k8s-bootstrap/system/calico-pdbs.yaml`.

With the AMI-First model, the correct baked path should be `/opt/bootstrap/system/calico-pdbs.yaml`.

---

### Gap 4: `control_plane.py` and `worker.py` are dead code

The **modular step packages already exist** (`cp/` and `wk/`).
`orchestrator.py` dispatches to `importlib.import_module("control_plane")` /
`importlib.import_module("worker")` — but `cp/__init__.py` defines `main()` directly.

The SSM runner also still points to the monolithic files:
```typescript
// ssm-automation-stack.ts line 76
scriptPath: 'boot/steps/control_plane.py',
// line 85
scriptPath: 'boot/steps/worker.py',
```

These monolithic files should be replaced by the orchestrator:
```bash
python3 boot/steps/orchestrator.py --mode control-plane
python3 boot/steps/orchestrator.py --mode worker
```

---

### Gap 5: AMI-First integration is incomplete

The Golden AMI bake step (from `build-golden-ami-component.ts`) installs:
- Calico manifests at `/opt/calico/`
- Python venv at `/opt/k8s-venv/`
- All binaries (kubeadm, kubectl, containerd, etc.)

But the `k8s-bootstrap/` Python code itself is **not baked into the AMI**.
It is still synced from S3 at runtime. The AMI-First architecture requires
that the `boot/` and `system/` trees are baked into the image at `/opt/bootstrap/`.

---

### Gap 6: `system/` manifest paths are inconsistent across steps

| Step | Path it reads from |
|---|---|
| `calico.py` | `/opt/bootstrap/kubernetes-app/k8s-bootstrap/system/calico-pdbs.yaml` (wrong) |
| `argocd.py` step 7 | `/data/k8s-bootstrap/system/argocd/bootstrap-argocd.sh` (S3 runtime sync) |
| `calico.py` operator | `/opt/calico/tigera-operator.yaml` (AMI baked ✅) |

The `system/` directory needs a **single canonical location** and all steps must
agree on it.

---

## Integration Plan

### Phase A — Fix the Script Sync (Immediate, unblocks current deploy)

Create the missing CI scripts so the existing S3-based flow works end-to-end
from _this_ repository.

#### A1. Create `scripts/cd/sync-bootstrap-scripts.ts`

```typescript
// Syncs k8s-bootstrap/ to s3://<bucket>/k8s-bootstrap/
// Reads bucket name from SSM: /k8s/{env}/scripts-bucket
```

Responsibilities:
1. Read `SCRIPTS_BUCKET` from SSM `/k8s/{env}/scripts-bucket`
2. Run `aws s3 sync k8s-bootstrap/ s3://<bucket>/k8s-bootstrap/ --delete`
3. Print a summary of uploaded objects

#### A2. Create `scripts/cd/trigger-bootstrap.ts`

```typescript
// Triggers SM-A for control-plane and all worker pools
// Polls Step Functions until all executions complete (SUCCESS or FAILED)
```

Responsibilities:
1. Read state machine ARN from SSM `/k8s/{env}/bootstrap/state-machine-arn`
2. Start executions for control-plane and worker pools
3. Poll `describeExecution` every 15s until completed
4. Exit non-zero if any execution FAILED

> [!NOTE]
> Both scripts should live in `scripts/cd/` and use `tsx` for direct TypeScript
> execution — consistent with the existing `fetch-boot-logs.ts` and `ssm-deploy.ts` patterns.

---

### Phase B — Fix Dead Code in the SSM Runner (Quick Win)

Update `ssm-automation-stack.ts` to call the orchestrator instead of the
monolithic files:

```diff
- scriptPath: 'boot/steps/control_plane.py',
+ scriptPath: 'boot/steps/orchestrator.py',
```

And update the RunCommand `commands` array:
```diff
- 'python3 "$SCRIPT" 2>&1'
+ 'python3 "$SCRIPT" --mode control-plane 2>&1'   # or --mode worker
```

Then delete `control_plane.py` and `worker.py` from `boot/steps/`.

---

### Phase C — Fix the Calico PDB Path

Update `boot/steps/cp/calico.py`:

```diff
- CALICO_PDB_MANIFEST = "/opt/bootstrap/kubernetes-app/k8s-bootstrap/system/calico-pdbs.yaml"
+ CALICO_PDB_MANIFEST = "/opt/bootstrap/system/calico-pdbs.yaml"
```

This assumes Phase D (AMI bake of `system/`) is complete.
Until then, use the S3-synced path: `/data/k8s-bootstrap/system/calico-pdbs.yaml`.

---

### Phase D — AMI-First: Bake `k8s-bootstrap/` into the Golden AMI

Add a step to `build-golden-ami-component.ts` that copies the `boot/` and `system/`
trees into the AMI at `/opt/bootstrap/`:

```yaml
# In the Image Builder component YAML (build phase):
- name: BakeBootstrapScripts
  action: ExecuteBash
  inputs:
    commands:
      - |
        # At AMI build time, the bootstrap files are available locally
        # (the CI job uploads them to S3 first, then the Image Builder
        # instance pulls them from there).
        S3_BUCKET="{{S3Bucket}}"
        aws s3 sync "s3://${S3_BUCKET}/k8s-bootstrap/" /opt/bootstrap/ --region {{Region}}
        chmod -R 755 /opt/bootstrap/boot/
        chmod -R 755 /opt/bootstrap/system/
        find /opt/bootstrap -name "*.sh" -exec chmod +x {} \;
        echo "Bootstrap scripts baked into AMI at /opt/bootstrap/"
```

Then update `argocd.py` step 7 to prefer the baked path:

```python
# Resolution order: baked AMI → S3 runtime sync
BAKED_BOOTSTRAP   = "/opt/bootstrap"
RUNTIME_BOOTSTRAP = f"{cfg.mount_point}/k8s-bootstrap"

bootstrap_dir = (
    Path(BAKED_BOOTSTRAP) if Path(BAKED_BOOTSTRAP).exists()
    else Path(RUNTIME_BOOTSTRAP)
)
```

This gives **backwards compatibility**: if the AMI doesn't have the baked scripts
(older AMI), it falls back to S3 sync.

---

### Phase E — Standardise Path Convention Across All Steps

Once Phase D is done, establish a single constant in `boot_helpers/config.py`:

```python
# boot_helpers/config.py (add)
@property
def bootstrap_dir(self) -> Path:
    """Canonical bootstrap directory.

    Prefers the AMI-baked path. Falls back to the S3-synced runtime path.
    This supports both AMI-First deployments and older AMI rollbacks.
    """
    from pathlib import Path
    baked = Path("/opt/bootstrap")
    if baked.exists():
        return baked
    return Path(self.mount_point) / "k8s-bootstrap"
```

Then update every step that uses a hardcoded path to use `cfg.bootstrap_dir`.

---

## Summary of Actions by Priority

| Priority | Gap | Action | Files |
|---|---|---|---|
| 🔴 P0 | Missing `sync-bootstrap-scripts.ts` | Create | `scripts/cd/sync-bootstrap-scripts.ts` |
| 🔴 P0 | Missing `trigger-bootstrap.ts` | Create | `scripts/cd/trigger-bootstrap.ts` |
| 🟠 P1 | Calico PDB path wrong | Fix constant | `boot/steps/cp/calico.py` |
| 🟠 P1 | SSM runner uses dead monoliths | Update step paths | `infra/lib/stacks/ssm-automation-stack.ts` |
| 🟡 P2 | `control_plane.py`, `worker.py` dead | Delete | `boot/steps/control_plane.py`, `boot/steps/worker.py` |
| 🟡 P2 | AMI-First bake of bootstrap scripts | New component step | `infra/lib/constructs/compute/build-golden-ami-component.ts` |
| 🟢 P3 | Inconsistent bootstrap paths | Centralise | `boot_helpers/config.py` + all steps |

---

## Deployment Flow After Integration

```
Push to main (k8s-bootstrap/ changed)
        │
        ▼
CI: sync-bootstrap-scripts.ts
  → s3 sync: k8s-bootstrap/ → s3://<bucket>/k8s-bootstrap/
        │
        ▼ (if AMI-First Phase D is done)
CI: deploy-golden-ami.yml
  → CDK deploys GoldenAmiStack
  → Image Builder: downloads from S3, bakes into /opt/bootstrap/
  → Writes AMI ID to SSM: /k8s/{env}/golden-ami/latest
        │
        ▼ (new EC2 launch uses baked AMI)
EC2 User-data → trigger SM-A
  → SSM RunCommand executes python3 orchestrator.py --mode control-plane
  → Steps read from /opt/bootstrap/ (baked) or /data/k8s-bootstrap/ (fallback)
```
