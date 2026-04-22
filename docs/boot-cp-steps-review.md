# boot/steps/cp/ — Architecture Review & Migration Assessment

**Reviewed:** 2026-04-21  
**Scope:** `boot/steps/cp/` (10 step files + `__init__.py`) + `boot/steps/common.py`  
**AWS MCP consulted:** Yes — AWS SDK for JavaScript v3 documentation  

---

## 1. Current State: What's Wrong

### 1.1 File explosion for no isolation benefit

| File | Lines | Purpose |
|---|---|---|
| `kubeadm_init.py` | 788 | First-run + second-run + DNS + SSM + cert backup + reconstruction |
| `verify.py` | 318 | Cluster health checks |
| `calico.py` | 185 | Calico CNI install |
| `ebs_volume.py` | 220 | Format + mount data volume |
| `dr_restore.py` | 164 | S3 restore for etcd + certs |
| `ccm.py` | 118 | AWS CCM Helm install |
| `kubectl_access.py` | 124 | kubeconfig setup |
| `token_rotator.py` | 108 | systemd timer install |
| `etcd_backup.py` | 55 | systemd timer install |
| `argocd.py` | 62 | ArgoCD bootstrap |
| `__init__.py` | 59 | Step orchestration |

**Total: ~2200 lines across 11 files.**  
None of these files is tested in isolation. None is imported by anything other than `__init__.py`. The module boundary adds no value — every step runs in a single sequential process on one machine.

### 1.2 Constant duplication — 6 declarations of the same value

`ADMIN_CONF = "/etc/kubernetes/admin.conf"` and `KUBECONFIG_ENV = {"KUBECONFIG": "/etc/kubernetes/admin.conf"}` are redeclared in every file that touches kubectl:

```
kubeadm_init.py   ← declares both
calico.py         ← declares both
ccm.py            ← declares both
verify.py         ← declares KUBECONFIG_ENV
kubectl_access.py ← declares ADMIN_CONF
argocd.py         ← declares ADMIN_CONF
```

A rename or path change requires editing 6 files.

### 1.3 kubeconfig setup is duplicated across two steps

`kubeadm_init.py` (`init_cluster`, `handle_second_run`) and `kubectl_access.py` (`step_configure_kubectl`) both copy `admin.conf` to `/root/.kube/config`, `/home/ssm-user/.kube/config`, and set permissions. The logic is not shared — it is copy-pasted.

### 1.4 Step numbering is meaningless

Steps are numbered: **0, 2, 3, 4, 4b, 5, 6, 8, 10, 11**. Numbers 1, 7, 9 don't exist. Number 4b is a string not a number. This is the result of steps being added and removed over time without renumbering. The numbers communicate nothing to a reader.

### 1.5 Every AWS API call goes through a subprocess

All 15 AWS operations are shell command invocations:

| Operation | Current | Could be SDK |
|---|---|---|
| SSM PutParameter | `aws ssm put-parameter` (×5) | ✓ |
| SSM GetParameter | `aws ssm get-parameter` (×3) | ✓ |
| Route53 UPSERT | `aws route53 change-resource-record-sets` | ✓ |
| S3 object exists | `aws s3 ls` (×2) | ✓ |
| S3 download | `aws s3 cp` (×4) | ✓ |
| S3 upload | `aws s3 cp` (×2) | ✓ |

Each CLI invocation spawns a new process, prints unstructured output to stdout, requires return code parsing, has no type safety, and requires the AWS CLI to be on PATH. The structured logging in `common.py` is completely bypassed by CLI output on stdout/stderr.

### 1.6 kubeadm_init.py is doing 6 things

This single file handles: first-run kubeadm init, second-run ASG replacement reconstruction, DNS update, SSM credential publishing, PKI certificate backup, and post-DR addon repair (CoreDNS, kube-proxy, bootstrap tokens, RBAC). These are distinct concerns that happen to be sequential.

---

## 2. TypeScript Migration: Benefits and Costs

### 2.1 What genuinely improves

**AWS SDK v3 replaces 15 subprocess AWS calls.**

Instead of:
```python
run_cmd(["aws", "ssm", "put-parameter",
         "--name", f"{cfg.ssm_prefix}/join-token",
         "--value", join_token,
         "--type", "SecureString",
         "--overwrite",
         "--region", cfg.aws_region])
```

You get:
```typescript
await ssmClient.send(new PutParameterCommand({
    Name: `${cfg.ssmPrefix}/join-token`,
    Value: joinToken,
    Type: 'SecureString',
    Overwrite: true,
}));
```

Benefits: type-safe parameters, structured error objects (no return code parsing), no subprocess overhead, SDK handles retries and exponential backoff natively, SDK errors are catchable with `instanceof`.

**Single toolchain — zero new runtime dependencies.**

`tsx` is already installed in the baked AMI (it is in the project root `package.json`, synced via `aws s3 sync`). `@aws-sdk` packages are already installed. No pip, no venv, no Python version management. Every script in `scripts/` already runs with `tsx`. Bootstrap follows the same pattern.

**Shared types with CDK infra.**

`BootConfig` in Python is a dataclass that mirrors the CDK config. In TypeScript, `BootConfig` can import directly from `infra/lib/config/` — SSM path construction, environment names, and Kubernetes versions are defined once and used everywhere: CDK stack, justfile scripts, and bootstrap.

**Async/await is cleaner than polling loops.**

The current code has 5+ polling loops:
```python
for i in range(1, 91):
    result = run_cmd(["kubectl", "get", "nodes"], ...)
    if result.returncode == 0:
        break
    time.sleep(1)
```

In TypeScript with a shared `waitUntil` helper:
```typescript
await waitUntil(() => kubectl(['get', 'nodes']).ok, { timeoutMs: 90_000, label: 'control-plane ready' });
```

### 2.2 What stays subprocess regardless of language

These system operations have no SDK equivalent — they remain `spawnSync` calls in TypeScript just as they are `run_cmd` calls in Python:

| Operation | Why subprocess |
|---|---|
| `kubeadm init / phase` | CLI tool, no API |
| `kubectl apply / get / wait` | CLI tool (K8s API client adds 40MB+ dep) |
| `helm upgrade --install` | CLI tool |
| `systemctl start/restart/enable` | systemd, host OS |
| `mkfs -t ext4` | Block device formatting |
| `mount` | Kernel syscall wrapper |
| `tar czf / xzf` | Archive operations |
| `etcdctl snapshot restore` | CLI tool |
| `openssl x509 / dgst` | Crypto operations |

Roughly 60% of operations remain subprocess calls in TypeScript. The win is the 40% that are AWS API calls.

**Note on subprocess safety:** All subprocess calls should use `spawnSync(binary, [args])` (array form) rather than shell string interpolation to prevent command injection. The `binary` and `args` in this bootstrap context are constants or values sourced from SSM/IMDS — not user input — but the array form is still the correct pattern.

### 2.3 Cost of migration

| Item | Effort |
|---|---|
| Rewrite 11 Python files → 1 TypeScript file | ~2 days |
| Port `StepRunner` context manager → `runStep()` function | 1 hour |
| Port `BootConfig` dataclass → TypeScript interface | 30 min |
| Port `run_cmd` wrapper → typed `spawnSync` helper | 1 hour |
| Replace 15 AWS CLI calls with SDK | ~3 hours |
| Update `orchestrator.py` entry point | ~1 hour |
| Update AMI bake (already syncs `.ts` files) | No change needed |
| SSM Automation document command update | 30 min |

Total: **~3 days for a complete, tested migration.**

---

## 3. DRY Consolidation: The Concrete Proposal

Whether you migrate to TypeScript or stay in Python, the same structural fix applies: **one file, one step list, no module boundaries**.

### 3.1 Target structure

**Current:** 11 files, ~2200 lines, 15 AWS CLI subprocess calls

**Target (TypeScript):** 1 file, ~700 lines, 0 AWS CLI subprocess calls for AWS operations

```
boot/
  steps/
    common.py           ← keep (shared with worker steps until worker migrated)
    orchestrator.py     ← minimal entry point, calls tsx control_plane.ts
    control_plane.ts    ← ALL 10 CP steps, single file
    worker.ts           ← worker steps (separate review)
```

### 3.2 DRY step pattern

```typescript
// Shared constants — declared once
const ADMIN_CONF = '/etc/kubernetes/admin.conf';
const KUBECONFIG = { KUBECONFIG: ADMIN_CONF };

// Generic step runner — replaces StepRunner context manager
async function runStep(
    name: string,
    fn: () => Promise<void>,
    marker?: string,
): Promise<void> {
    if (marker && existsSync(marker)) {
        log.info(`[${name}] skip — marker exists`);
        return;
    }
    log.info(`[${name}] start`);
    const t = Date.now();
    await fn();
    log.info(`[${name}] done in ${Date.now() - t}ms`);
}

// Generic poll helper — replaces 5 copy-pasted for/sleep loops
async function waitUntil(
    check: () => boolean,
    opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
    const { timeoutMs = 90_000, intervalMs = 1_000, label = 'condition' } = opts;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (check()) return;
        await new Promise(r => setTimeout(r, intervalMs));
    }
    log.warn(`${label} not met after ${timeoutMs}ms — continuing`);
}

// All 10 steps sequentially in main()
async function main(): Promise<void> {
    const cfg = BootConfig.fromEnv();
    await runStep('mount-data-volume',  () => mountDataVolume(cfg),   '/etc/kubernetes/.data-mounted');
    await runStep('dr-restore',         () => drRestore(cfg),          '/etc/kubernetes/.dr-restored');
    await runStep('kubeadm-init',       () => initOrReconstruct(cfg),  ADMIN_CONF);
    await runStep('calico',             () => installCalico(cfg),       '/etc/kubernetes/.calico-installed');
    await runStep('ccm',                () => installCcm(cfg),          '/etc/kubernetes/.ccm-installed');
    await runStep('kubectl-access',     () => configureKubectl(cfg));
    await runStep('argocd',             () => bootstrapArgocd(cfg));
    await runStep('verify',             () => verifyCluster(cfg));
    await runStep('etcd-backup',        () => installEtcdBackup(cfg),  '/etc/systemd/system/etcd-backup.timer');
    await runStep('token-rotator',      () => installTokenRotator(cfg),'/etc/systemd/system/kubeadm-token-rotator.timer');
}
```

### 3.3 AWS SDK replaces CLI calls for every AWS operation

```typescript
const ssmClient = new SSMClient({ region: cfg.awsRegion });
const r53Client = new Route53Client({ region: cfg.awsRegion });
const s3Client  = new S3Client({ region: cfg.awsRegion });

// SSM
async function ssmPut(name: string, value: string, type: 'String' | 'SecureString' = 'String'): Promise<void> {
    await ssmClient.send(new PutParameterCommand({ Name: name, Value: value, Type: type, Overwrite: true }));
}

// Route53 — DNS update
async function updateDnsRecord(privateIp: string, cfg: BootConfig): Promise<void> {
    if (!cfg.hostedZoneId) return;
    await r53Client.send(new ChangeResourceRecordSetsCommand({
        HostedZoneId: cfg.hostedZoneId,
        ChangeBatch: { Changes: [{ Action: 'UPSERT', ResourceRecordSet: {
            Name: cfg.apiDnsName, Type: 'A', TTL: 30,
            ResourceRecords: [{ Value: privateIp }],
        }}]},
    }));
}

// S3 — existence check (replaces `aws s3 ls`)
async function s3ObjectExists(bucket: string, key: string): Promise<boolean> {
    try {
        await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
    } catch {
        return false;
    }
}
```

### 3.4 What gets removed by consolidation

| Current | After consolidation |
|---|---|
| 11 Python files | 1 TypeScript file |
| 6 `ADMIN_CONF` declarations | 1 |
| 6 `KUBECONFIG_ENV` declarations | 1 |
| 5 polling loops (for/sleep) | 1 `waitUntil()` helper |
| kubeconfig setup in 2 places | 1 `configureKubectl()` function |
| 15 AWS CLI subprocess calls | 0 (SDK) |
| Non-sequential step numbers | Named steps, sequential order |

---

## 4. Recommendation

**Migrate to TypeScript. Consolidate into one file.**

1. **Toolchain is already there.** `tsx` runs in the baked AMI. `@aws-sdk` packages are already installed. No new dependencies needed.

2. **SDK eliminates the most fragile code.** The AWS CLI subprocess calls are where failures are least visible: CLI version mismatches, output parsing fragility, no retry logic, error messages mixed into stdout. SDK throws typed errors, handles retries internally, and logs via the standard logger.

3. **One file is enough for 10 steps.** Steps are sequential, run once, on one machine. There is no testing, no parallel execution, no independent deployment. Module boundaries add boilerplate without benefit.

4. **Shared types prevent drift.** The Python `BootConfig` dataclass has drifted from the CDK config (different field names, different SSM path construction). A shared TypeScript type prevents this.

5. **AWS MCP confirms SDK v3 is the AWS-recommended path** for SSM, S3, Route 53, and EC2 operations in Node.js — AWS code examples and documentation all use SDK v3, not CLI subprocess calls.

**What to keep in Python until worker migration:**  
`common.py` is shared with the worker steps and contains `StepRunner`, `run_cmd`, and structured logging. Keep it in place and update `orchestrator.py` to call `npx tsx control_plane.ts` as the entry point once the TypeScript migration is done. Delete `boot/steps/cp/` once both control plane and worker are migrated.
