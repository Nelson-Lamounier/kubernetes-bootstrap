# TypeScript ArgoCD Bootstrap Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `system/argocd/bootstrap_argocd.py` and its five step modules in TypeScript so the ARC runner pod (which has Node.js baked in) can execute the ArgoCD bootstrap without requiring Python on the runner.

**Architecture:** Three TypeScript helpers already exist (`config.ts`, `logger.ts`, `runner.ts`). This plan adds a `package.json` + `tsconfig.json` for the `system/argocd` workspace, five step files mirroring the Python layout, and a slim orchestrator entry point. All K8s secret creation uses `kubectlApplyStdin()` instead of the Python `kubernetes` client — `kubectl apply` is idempotent, eliminating the create/409-replace pattern. Polling loops use `async/await` + `sleep()` because `logger.step()` is already async.

**Tech Stack:** TypeScript 5.5, `@aws-sdk/client-ssm`, `@aws-sdk/client-secrets-manager`, `bcryptjs`, `tsx` (direct execution), Yarn 4 workspaces

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `system/argocd/package.json` | Create | Workspace deps: AWS SDKs, bcryptjs, tsx |
| `system/argocd/tsconfig.json` | Create | NodeNext module resolution |
| `system/argocd/helpers/runner.ts` | Modify | Add `sleep()` helper |
| `system/argocd/steps/namespace.ts` | Create | Steps 1–3b: namespace, deploy key, repo secret, JWT key preservation |
| `system/argocd/steps/install.ts` | Create | Steps 4–4d: ArgoCD install, default project, server config, health checks |
| `system/argocd/steps/apps.ts` | Create | Steps 5–5e: root apps, monitoring params, Prometheus auth, ECR creds, Crossplane, TLS restore, cert-manager issuer, notifications |
| `system/argocd/steps/networking.ts` | Create | Steps 6–7c: ArgoCD readiness wait, ingress, IP allowlist, webhook secret |
| `system/argocd/steps/auth.ts` | Create | Steps 8–11: CLI install, CI bot, token generation, admin password, TLS backup, signing key backup, summary |
| `system/argocd/bootstrap_argocd.ts` | Create | Slim async orchestrator — imports all step functions, runs them in sequence |
| `package.json` (root) | Modify | Add `"system/argocd"` to workspaces array |

---

## Task 1: Package Setup

**Files:**
- Create: `system/argocd/package.json`
- Create: `system/argocd/tsconfig.json`
- Modify: `package.json` (root) — add workspace
- Modify: `system/argocd/helpers/runner.ts` — add `sleep()`

- [ ] **Step 1: Create `system/argocd/package.json`**

```json
{
  "name": "k8s-argocd-bootstrap",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "packageManager": "yarn@4.14.0",
  "scripts": {
    "bootstrap": "tsx bootstrap_argocd.ts",
    "bootstrap:dry-run": "tsx bootstrap_argocd.ts --dry-run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@aws-sdk/client-secrets-manager": "^3.0.0",
    "@aws-sdk/client-ssm": "^3.0.0",
    "bcryptjs": "^2.4.3"
  },
  "devDependencies": {
    "@types/bcryptjs": "^2.4.6",
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 2: Create `system/argocd/tsconfig.json`**

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["./**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Add `system/argocd` to root workspace**

In `package.json` (root), change:
```json
"workspaces": [
  "infra",
  "scripts"
]
```
to:
```json
"workspaces": [
  "infra",
  "scripts",
  "system/argocd"
]
```

- [ ] **Step 4: Add `sleep()` to `system/argocd/helpers/runner.ts`**

Append at the end of the file (before the final export or as a new export):

```typescript
export const sleep = (ms: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, ms));
```

- [ ] **Step 5: Install dependencies**

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/kubernetes-bootstrap
yarn install
```

Expected: `system/argocd` workspace resolved, `node_modules` populated under `system/argocd/`.

- [ ] **Step 6: Verify typecheck passes on existing helpers**

```bash
cd system/argocd && yarn typecheck
```

Expected: exits 0 (no errors on the three existing helper files).

- [ ] **Step 7: Commit**

```bash
git add system/argocd/package.json system/argocd/tsconfig.json system/argocd/helpers/runner.ts package.json yarn.lock .yarn/install-state.gz
git commit -m "feat(argocd): add TypeScript workspace for argocd bootstrap runner"
```

---

## Task 2: `steps/namespace.ts` (Steps 1–3b)

**Files:**
- Create: `system/argocd/steps/namespace.ts`

Steps 1–3b: create argocd namespace, resolve SSH deploy key from SSM, create repo credentials secret, preserve JWT signing key before re-install.

Key differences from Python:
- `create_repo_secret`: uses `kubectlApplyStdin()` with YAML instead of `kubernetes` client (no base64 encode/decode dance needed — `stringData` handles encoding)
- `preserve_argocd_secret`: returns `Promise<string | null>` (async SSM fallback)
- `resolve_deploy_key`: returns `Promise<string>` (async SSM read)

- [ ] **Step 1: Create `system/argocd/steps/namespace.ts`**

```typescript
// @format
// Steps 1–3b: Namespace, deploy key, repo secret, JWT signing key preservation.

import { kubectlApplyStdin, log, run, sleep, ssmGet } from '../helpers/runner.js';
import type { Config } from '../helpers/config.js';

export const createNamespace = (cfg: Config): void => {
    log('=== Step 1: Creating argocd namespace ===');
    run(['kubectl', 'apply', '-f', `${cfg.argocdDir}/namespace.yaml`], cfg);
    log('✓ argocd namespace ready\n');
};

export const resolveDeployKey = async (cfg: Config): Promise<string> => {
    log('=== Step 2: Resolving SSH Deploy Key from SSM ===');
    const envKey = process.env['DEPLOY_KEY'];
    if (envKey) {
        log('  ✓ Using environment override\n');
        return envKey;
    }
    const ssmPath = `${cfg.ssmPrefix}/deploy-key`;
    log(`  → Resolving from SSM: ${ssmPath}`);
    if (cfg.dryRun) {
        log('  [DRY-RUN] Would resolve deploy key from SSM\n');
        return '';
    }
    const key = await ssmGet(cfg, ssmPath, true);
    if (key) {
        log('  ✓ SSH Deploy Key resolved from SSM\n');
        return key;
    }
    log(`  ⚠ Deploy Key not found in SSM — store at: ${ssmPath}\n`);
    return '';
};

export const createRepoSecret = (cfg: Config, deployKey: string): void => {
    log('=== Step 3: Creating repo credentials (SSH Deploy Key) ===');
    if (!deployKey) {
        log('  ⚠ Skipping — no Deploy Key available\n');
        return;
    }
    if (cfg.dryRun) {
        log('  [DRY-RUN] Would create repo-cdk-monitoring secret in argocd namespace\n');
        return;
    }
    // kubectl apply with stringData — the API server handles base64 encoding.
    // Using stringData avoids the manual base64 encoding the Python k8s client required.
    const yaml = `\
apiVersion: v1
kind: Secret
metadata:
  name: repo-cdk-monitoring
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repository
type: Opaque
stringData:
  type: git
  url: git@github.com:Nelson-Lamounier/cdk-monitoring.git
  sshPrivateKey: |
${deployKey.split('\n').map(l => `    ${l}`).join('\n')}
`;
    kubectlApplyStdin(yaml, cfg);
    log('  ✓ SSH Deploy Key repo credentials applied\n');
};

export const preserveArgocdSecret = async (cfg: Config): Promise<string | null> => {
    log('=== Step 3b: Preserving ArgoCD JWT signing key ===');
    if (cfg.dryRun) {
        log('  [DRY-RUN] Would extract server.secretkey from argocd-secret\n');
        return null;
    }
    // Source 1: in-cluster argocd-secret (normal re-bootstrap)
    const result = run(
        ['kubectl', 'get', 'secret', 'argocd-secret', '-n', 'argocd',
         '-o', 'jsonpath={.data.server\\.secretkey}'],
        cfg, { check: false, capture: true },
    );
    if (result.ok && result.stdout) {
        log('  ✓ JWT signing key preserved from in-cluster secret\n');
        return result.stdout;
    }
    // Source 2: SSM backup (DR — fresh cluster)
    log('  ℹ No in-cluster argocd-secret — attempting SSM fallback (DR recovery)');
    const ssmPath = `${cfg.ssmPrefix}/argocd/server-secret-key`;
    const key = await ssmGet(cfg, ssmPath, true);
    if (key) {
        log(`  ✓ JWT signing key recovered from SSM: ${ssmPath}`);
        log('    Existing CI bot tokens will remain valid after install\n');
        return key;
    }
    log(`  ℹ SSM fallback not available (${ssmPath}) — first install\n`);
    return null;
};
```

- [ ] **Step 2: Typecheck**

```bash
cd system/argocd && yarn typecheck
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add system/argocd/steps/namespace.ts
git commit -m "feat(argocd): add TypeScript Steps 1–3b (namespace, deploy key, repo secret, JWT key)"
```

---

## Task 3: `steps/install.ts` (Steps 4–4d)

**Files:**
- Create: `system/argocd/steps/install.ts`

Steps: restore JWT signing key, install ArgoCD, create default AppProject, configure server (rootpath + insecure), configure custom health checks.

Key differences from Python:
- `create_default_project`: uses `kubectlApplyStdin()` for the inline fallback instead of `subprocess.run(['kubectl', 'apply', '-f', '-'])` directly
- `configure_health_checks`: uses `JSON.stringify` for the patch payload; Lua multiline strings use template literals

- [ ] **Step 1: Create `system/argocd/steps/install.ts`**

```typescript
// @format
// Steps 4–4d: ArgoCD install, default project, server config, and health checks.

import { log, run } from '../helpers/runner.js';
import type { Config } from '../helpers/config.js';

const ARGOCD_SERVER = 'deployment/argocd-server';

export const restoreArgocdSecret = (cfg: Config, signingKey: string | null): void => {
    log('=== Step 3b-restore: Restoring ArgoCD JWT signing key ===');
    if (signingKey === null) {
        log('  ℹ No signing key to restore — first install or dry-run\n');
        return;
    }
    if (cfg.dryRun) {
        log('  [DRY-RUN] Would patch server.secretkey into argocd-secret\n');
        return;
    }
    const patch = JSON.stringify({ data: { 'server.secretkey': signingKey } });
    const patchResult = run(
        ['kubectl', 'patch', 'secret', 'argocd-secret', '-n', 'argocd',
         '--type', 'merge', '-p', patch],
        cfg, { check: false },
    );
    if (!patchResult.ok) {
        log(`  ✗ Failed to restore signing key — ${patchResult.stderr}`);
        log('    CI bot tokens WILL be invalidated on next verification\n');
        return;
    }
    log('  ✓ JWT signing key patched');
    // Verify patch stuck
    const verify = run(
        ['kubectl', 'get', 'secret', 'argocd-secret', '-n', 'argocd',
         '-o', 'jsonpath={.data.server\\.secretkey}'],
        cfg, { check: false, capture: true },
    );
    if (!verify.ok || verify.stdout !== signingKey) {
        const actual = verify.ok ? verify.stdout.slice(0, 20) : '(read failed)';
        log(`  ✗ Post-patch verification FAILED — got: ${actual}...\n`);
        return;
    }
    log('  ✓ Post-patch verification passed — key matches');
    run(['kubectl', 'rollout', 'restart', ARGOCD_SERVER, '-n', 'argocd'], cfg, { check: false });
    const rollout = run(
        ['kubectl', 'rollout', 'status', ARGOCD_SERVER,
         '-n', 'argocd', `--timeout=${cfg.argoTimeout}s`],
        cfg, { check: false },
    );
    if (rollout.ok) {
        log('  ✓ argocd-server rollout complete — restored key is active\n');
    } else {
        log(`  ⚠ Rollout not ready within ${cfg.argoTimeout}s — server may still be starting\n`);
    }
};

export const installArgocd = (cfg: Config): void => {
    log('=== Step 4: Installing ArgoCD ===');
    // --server-side: CRDs exceed the 262KB client-side annotation limit.
    // --force-conflicts: takes ownership of fields previously managed by client-side apply.
    run(
        ['kubectl', 'apply', '-n', 'argocd', '-f', `${cfg.argocdDir}/install.yaml`,
         '--server-side', '--force-conflicts'],
        cfg,
    );
    log('✓ ArgoCD core installed\n');
};

export const createDefaultProject = (cfg: Config): void => {
    log('=== Step 4b: Creating default AppProject ===');
    const { existsSync } = await import('node:fs').then(m => m);
    const projectPath = `${cfg.argocdDir}/default-project.yaml`;
    if (existsSync(projectPath)) {
        run(['kubectl', 'apply', '-f', projectPath], cfg);
        log('✓ default AppProject created\n');
        return;
    }
    log(`  ⚠ default-project.yaml not found at ${projectPath} — creating inline...`);
    const { kubectlApplyStdin } = await import('../helpers/runner.js');
    kubectlApplyStdin(`\
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: default
  namespace: argocd
spec:
  description: Default project for all applications
  sourceRepos:
    - "*"
  destinations:
    - namespace: "*"
      server: https://kubernetes.default.svc
  clusterResourceWhitelist:
    - group: "*"
      kind: "*"
`, cfg);
    log('✓ default AppProject created (inline)\n');
};

export const configureArgocdServer = (cfg: Config): void => {
    log('=== Step 4c: Configuring ArgoCD Server (rootpath + insecure) ===');
    if (cfg.dryRun) {
        log('  [DRY-RUN] Would patch argocd-cmd-params-cm and restart argocd-server\n');
        return;
    }
    const patch = JSON.stringify({ data: { 'server.rootpath': '/argocd', 'server.insecure': 'true' } });
    const cm = run(
        ['kubectl', 'patch', 'configmap', 'argocd-cmd-params-cm',
         '-n', 'argocd', '--type', 'merge', '-p', patch],
        cfg, { check: false },
    );
    log(cm.ok
        ? '  ✓ argocd-cmd-params-cm patched (rootpath=/argocd, insecure=true)'
        : '  ⚠ Failed to patch argocd-cmd-params-cm');
    const restart = run(
        ['kubectl', 'rollout', 'restart', ARGOCD_SERVER, '-n', 'argocd'],
        cfg, { check: false },
    );
    log(restart.ok ? '  ✓ argocd-server deployment restarted' : '  ⚠ Failed to restart argocd-server');
    log('');
};

export const configureHealthChecks = (cfg: Config): void => {
    log('=== Step 4d: Configuring custom resource health checks ===');
    if (cfg.dryRun) {
        log('  [DRY-RUN] Would patch argocd-cm with custom health checks\n');
        return;
    }
    const deploymentLua = `hs = {}
if obj.status ~= nil then
  if obj.status.availableReplicas ~= nil and obj.spec.replicas ~= nil then
    if obj.status.availableReplicas == obj.spec.replicas then
      if obj.status.conditions ~= nil then
        for _, condition in ipairs(obj.status.conditions) do
          if condition.type == "Progressing" and condition.reason == "NewReplicaSetAvailable" then
            hs.status = "Healthy"
            hs.message = "All replicas available and rollout complete"
            return hs
          end
        end
      end
      hs.status = "Progressing"
      hs.message = "Waiting for rollout to complete"
      return hs
    end
  end
  hs.status = "Progressing"
  hs.message = "Waiting for all replicas to be available"
  return hs
end
hs.status = "Progressing"
hs.message = "Waiting for status"
return hs`;
    const configmapLua = `hs = {}\nhs.status = "Healthy"\nhs.message = ""\nreturn hs`;
    const rolloutLua = `hs = {}
if obj.status ~= nil then
  if obj.status.phase == "Healthy" then
    hs.status = "Healthy"
    hs.message = "Rollout is fully promoted"
    return hs
  end
  if obj.status.phase == "Paused" then
    hs.status = "Suspended"
    hs.message = obj.status.message or "Rollout is paused"
    return hs
  end
  if obj.status.phase == "Degraded" or obj.status.phase == "Abort" then
    hs.status = "Degraded"
    hs.message = obj.status.message or "Rollout failed"
    return hs
  end
  hs.status = "Progressing"
  hs.message = obj.status.message or "Rollout in progress"
  return hs
end
hs.status = "Progressing"
hs.message = "Waiting for rollout status"
return hs`;
    const patch = JSON.stringify({
        data: {
            'resource.customizations.health.apps_Deployment': deploymentLua,
            'resource.customizations.health._ConfigMap': configmapLua,
            'resource.customizations.health.argoproj.io_Rollout': rolloutLua,
            'timeout.session': '24h',
        },
    });
    const result = run(
        ['kubectl', 'patch', 'configmap', 'argocd-cm', '-n', 'argocd',
         '--type', 'merge', '-p', patch],
        cfg, { check: false },
    );
    if (result.ok) {
        log('  ✓ Custom health checks added to argocd-cm:');
        log('    - apps/Deployment: requires ALL replicas available + rollout complete');
        log('    - ConfigMap: always Healthy');
        log('    - argoproj.io/Rollout: maps phase to ArgoCD health status');
    } else {
        log('  ⚠ Failed to patch argocd-cm with health checks');
    }
    log('');
};
```

Note: `createDefaultProject` uses a dynamic import to get `existsSync` and `kubectlApplyStdin` — this avoids circular imports while keeping the function self-contained. If the TypeScript compiler flags dynamic imports in a sync function, make it `async` and update the orchestrator call to `await`.

- [ ] **Step 2: Typecheck**

```bash
cd system/argocd && yarn typecheck
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add system/argocd/steps/install.ts
git commit -m "feat(argocd): add TypeScript Steps 4–4d (install, project, server config, health checks)"
```

---

## Task 4: `steps/apps.ts` (Steps 5–5e)

**Files:**
- Create: `system/argocd/steps/apps.ts`

This is the largest step file. Key translation notes:
- All K8s secret creation (Prometheus basic auth, ECR creds, Crossplane creds, notifications) uses `kubectlApplyStdin()` with `stringData` — no manual base64
- `restore_tls_cert` / `backup_tls_cert`: call the Python `persist-tls-cert.py` via `run(['python3', ...], cfg)` — Python is available in the runner Dockerfile
- Polling loops use `await sleep(5000)` (async step functions return `Promise<void>`)
- `inject_monitoring_helm_params`: needs async due to polling — declare `async`

- [ ] **Step 1: Create `system/argocd/steps/apps.ts`**

```typescript
// @format
// Steps 5–5e: Root apps, monitoring params, Prometheus auth, ECR creds,
//             Crossplane, TLS restore, cert-manager issuer, notifications.

import { log, run, kubectlApplyStdin, ssmGet, secretsManagerGet, sleep } from '../helpers/runner.js';
import type { Config } from '../helpers/config.js';

export const applyRootApp = (cfg: Config): void => {
    log('=== Step 5: Applying App-of-Apps roots (platform + workloads) ===');
    for (const name of ['platform-root-app.yaml', 'workloads-root-app.yaml']) {
        log(`  → Applying ${name}`);
        run(['kubectl', 'apply', '-f', `${cfg.argocdDir}/${name}`], cfg, { check: false });
    }
    log('✓ App-of-Apps roots applied\n');
};

export const injectMonitoringHelmParams = async (cfg: Config): Promise<void> => {
    log('=== Step 5b: Injecting Monitoring Helm Parameters ===');
    const parameters: Array<{ name: string; value: string }> = [];

    if (!cfg.dryRun) {
        // SNS topic ARN — try pool path first, then legacy
        const poolPath = `${cfg.ssmPrefix}/monitoring/alerts-topic-arn-pool`;
        const legacyPath = `${cfg.ssmPrefix}/monitoring/alerts-topic-arn`;
        const topicArn = await ssmGet(cfg, poolPath) ?? await ssmGet(cfg, legacyPath);
        if (topicArn) {
            log(`  ✓ SNS Topic ARN: ${topicArn}`);
            parameters.push({ name: 'grafana.alerting.snsTopicArn', value: topicArn });
        } else {
            log(`  ⚠ SNS topic ARN not found in SSM (tried pool and legacy)`);
        }
        // Admin IP allowlist
        for (const [ssmPath, paramName] of [
            [`${cfg.ssmPrefix}/monitoring/allow-ipv4`, 'adminAccess.allowedIps[0]'],
            [`${cfg.ssmPrefix}/monitoring/allow-ipv6`, 'adminAccess.allowedIps[1]'],
        ] as const) {
            const ip = await ssmGet(cfg, ssmPath);
            if (ip) {
                log(`  ✓ ${paramName}: ${ip}`);
                parameters.push({ name: paramName, value: ip });
            } else {
                log(`  ⚠ IP not found in SSM (${ssmPath})`);
            }
        }
    }

    if (cfg.dryRun) {
        log('  [DRY-RUN] Would patch monitoring Application with Helm parameters\n');
        return;
    }
    if (parameters.length === 0) {
        log('  ⚠ No parameters to inject — skipping patch\n');
        return;
    }

    // Wait up to 120s for the monitoring Application to be created by ArgoCD
    const maxAttempts = 24;
    log('  → Waiting for monitoring Application to be created by ArgoCD...');
    let appReady = false;
    for (let i = 1; i <= maxAttempts; i++) {
        const check = run(
            ['kubectl', 'get', 'application', 'monitoring', '-n', 'argocd'],
            cfg, { check: false, capture: true },
        );
        if (check.ok) {
            log(`  ✓ monitoring Application exists (attempt ${i}/${maxAttempts})`);
            appReady = true;
            break;
        }
        if (i < maxAttempts) {
            if (i % 6 === 0) log(`    Attempt ${i}/${maxAttempts} — not found, still waiting...`);
            await sleep(5000);
        }
    }
    if (!appReady) {
        log('  ⚠ monitoring Application not found after 120s — SM-B will need to re-run\n');
        return;
    }

    const patch = JSON.stringify({ spec: { source: { helm: { parameters } } } });
    const result = run(
        ['kubectl', 'patch', 'application', 'monitoring', '-n', 'argocd',
         '--type', 'merge', '-p', patch],
        cfg, { check: false },
    );
    log(result.ok
        ? `  ✓ Monitoring Application patched with ${parameters.length} Helm parameters`
        : '  ⚠ Failed to patch monitoring Application');
    log('');
};

export const seedPrometheusBasicAuth = async (cfg: Config): Promise<void> => {
    log('=== Step 5b-auth: Seeding Prometheus Basic Auth Secret ===');
    const ssmPath = `${cfg.ssmPrefix}/monitoring/prometheus-basic-auth`;
    log(`  → Reading htpasswd from SSM: ${ssmPath}`);
    if (cfg.dryRun) {
        log(`  [DRY-RUN] Would patch prometheus-basic-auth-secret from ${ssmPath}\n`);
        return;
    }
    const htpasswdLine = await ssmGet(cfg, ssmPath, true);
    if (!htpasswdLine || !htpasswdLine.includes(':')) {
        log(`  ⚠ SSM parameter not found or invalid (${ssmPath})`);
        log(`    Store with: aws ssm put-parameter --name '${ssmPath}' --type SecureString --value "$(htpasswd -nbB admin <password>)"\n`);
        return;
    }
    log('  ✓ htpasswd entry retrieved from SSM');
    kubectlApplyStdin(`\
apiVersion: v1
kind: Secret
metadata:
  name: prometheus-basic-auth-secret
  namespace: monitoring
  labels:
    app.kubernetes.io/managed-by: bootstrap
    app.kubernetes.io/part-of: monitoring
type: Opaque
stringData:
  users: |
    ${htpasswdLine}
`, cfg);
    log('  ✓ prometheus-basic-auth-secret applied\n');
};

export const seedEcrCredentials = (cfg: Config): void => {
    log('=== Step 5c: Seeding ECR Credentials (Day-1) ===');
    const ecrRegistry = `771826808455.dkr.ecr.${cfg.awsRegion}.amazonaws.com`;
    if (cfg.dryRun) {
        log(`  [DRY-RUN] Would seed ecr-credentials secret for ${ecrRegistry}\n`);
        return;
    }
    const tokenResult = run(
        ['aws', 'ecr', 'get-login-password', '--region', cfg.awsRegion],
        cfg, { check: false, capture: true },
    );
    const ecrToken = tokenResult.ok ? tokenResult.stdout : '';
    if (!ecrToken) {
        log('  ⚠ Failed to get ECR token — Image Updater will 401 until CronJob fires\n');
        return;
    }
    log('  ✓ ECR authorization token obtained');
    const authStr = Buffer.from(`AWS:${ecrToken}`).toString('base64');
    const dockerConfig = JSON.stringify({ auths: { [ecrRegistry]: { auth: authStr } } });
    const configB64 = Buffer.from(dockerConfig).toString('base64');
    kubectlApplyStdin(`\
apiVersion: v1
kind: Secret
metadata:
  name: ecr-credentials
  namespace: argocd
  labels:
    app.kubernetes.io/managed-by: ecr-token-refresh
    app.kubernetes.io/part-of: argocd
type: kubernetes.io/dockerconfigjson
data:
  .dockerconfigjson: ${configB64}
`, cfg);
    log(`  ✓ ecr-credentials secret applied — Image Updater can authenticate to ${ecrRegistry}\n`);
};

export const provisionCrossplaneCredentials = async (cfg: Config): Promise<void> => {
    log('=== Step 5c-cp: Provisioning Crossplane AWS Credentials ===');
    const envShort = cfg.env.slice(0, 3);
    const secretName = `shared-${envShort}/crossplane/aws-credentials`;
    if (cfg.dryRun) {
        log(`  [DRY-RUN] Would provision crossplane-aws-creds from ${secretName}\n`);
        return;
    }
    const secretStr = await secretsManagerGet(cfg, secretName);
    if (!secretStr) {
        log(`  ⚠ Secrets Manager secret '${secretName}' not found — Crossplane will fail auth\n`);
        return;
    }
    const creds = JSON.parse(secretStr) as Record<string, string>;
    const { aws_access_key_id: keyId, aws_secret_access_key: secretKey } = creds;
    if (!keyId || !secretKey) {
        log(`  ⚠ Empty credentials in '${secretName}'\n`);
        return;
    }
    log(`  ✓ Retrieved credentials from Secrets Manager (${secretName})`);
    // Ensure crossplane-system namespace exists
    run(['kubectl', 'create', 'namespace', 'crossplane-system',
         '--dry-run=client', '-o', 'yaml'], cfg, { check: false });
    run(['kubectl', 'apply', '-f', '-'], cfg, { check: false });
    const credsIni = `[default]\naws_access_key_id = ${keyId}\naws_secret_access_key = ${secretKey}\n`;
    const credsB64 = Buffer.from(credsIni).toString('base64');
    kubectlApplyStdin(`\
apiVersion: v1
kind: Secret
metadata:
  name: crossplane-aws-creds
  namespace: crossplane-system
  labels:
    app.kubernetes.io/managed-by: bootstrap
    app.kubernetes.io/part-of: crossplane
    platform.engineering/component: infrastructure-abstraction
type: Opaque
data:
  credentials: ${credsB64}
`, cfg);
    log('  ✓ crossplane-aws-creds secret applied\n');
};

export const restoreTlsCert = (cfg: Config): void => {
    log('=== Step 5d-pre: Restoring TLS certificate + ACME key from SSM ===');
    const { join } = require('node:path') as typeof import('node:path');
    const { existsSync } = require('node:fs') as typeof import('node:fs');
    const persistScript = join(cfg.argocdDir, '..', 'cert-manager', 'persist-tls-cert.py');
    if (!existsSync(persistScript)) {
        log(`  ⚠ ${persistScript} not found — cert-manager will request a new certificate\n`);
        return;
    }
    const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        KUBECONFIG: cfg.kubeconfig,
        SSM_PREFIX: cfg.ssmPrefix,
        AWS_REGION: cfg.awsRegion,
    };
    for (const [secret, ns] of [['ops-tls-cert', 'kube-system'], ['letsencrypt-account-key', 'cert-manager']] as const) {
        log(`  → Restoring ${ns}/${secret}...`);
        const args = ['python3', persistScript, '--restore', '--secret', secret, '--namespace', ns];
        if (cfg.dryRun) args.push('--dry-run');
        const result = run(args, cfg, { check: false });
        log(result.ok ? `  ✓ ${secret} restore completed` : `  ⚠ ${secret} restore failed`);
    }
    log('');
};

export const applyCertManagerIssuer = async (cfg: Config): Promise<void> => {
    log('=== Step 5d: Applying cert-manager ClusterIssuer (DNS-01) ===');
    if (cfg.dryRun) {
        log('  [DRY-RUN] Would read SSM params and apply ClusterIssuer with DNS-01\n');
        return;
    }
    const [publicHzId, dnsRoleArn] = await Promise.all([
        ssmGet(cfg, `${cfg.ssmPrefix}/public-hosted-zone-id`),
        ssmGet(cfg, `${cfg.ssmPrefix}/cross-account-dns-role-arn`),
    ]);
    if (!publicHzId) log(`  ⚠ Public Hosted Zone ID not found in SSM`);
    if (!dnsRoleArn) log(`  ⚠ Cross-Account DNS Role ARN not found in SSM`);
    if (!publicHzId || !dnsRoleArn) {
        const missing = [
            ...(!publicHzId ? [`${cfg.ssmPrefix}/public-hosted-zone-id`] : []),
            ...(!dnsRoleArn ? [`${cfg.ssmPrefix}/cross-account-dns-role-arn`] : []),
        ];
        throw new Error(`Missing DNS-01 SSM params: ${missing.join(', ')}. SM-B will retry.`);
    }
    log(`  ✓ Public Hosted Zone ID: ${publicHzId}`);
    log(`  ✓ Cross-Account DNS Role: ${dnsRoleArn}`);

    // Wait for cert-manager CRDs (12 × 5s = 60s)
    const argoRunning = run(
        ['kubectl', 'get', 'pods', '-n', 'argocd',
         '--field-selector=status.phase=Running', '-o', 'name'],
        cfg, { check: false, capture: true },
    );
    if (!argoRunning.ok || !argoRunning.stdout.trim()) {
        throw new Error('No ArgoCD pods Running — cert-manager will not sync yet. SM-B will retry.');
    }
    const crdName = 'clusterissuers.cert-manager.io';
    log(`  → Waiting for CRD '${crdName}' (timeout: 60s)...`);
    let crdReady = false;
    for (let i = 1; i <= 12; i++) {
        const check = run(['kubectl', 'get', 'crd', crdName], cfg, { check: false, capture: true });
        if (check.ok) { log(`  ✓ CRD ready (attempt ${i}/12)`); crdReady = true; break; }
        if (i < 12) await sleep(5000);
    }
    if (!crdReady) throw new Error(`CRD '${crdName}' not available after 60s. SM-B will retry.`);

    kubectlApplyStdin(`\
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt
  annotations:
    kubernetes.io/description: "Let's Encrypt production issuer via DNS-01 challenge (Route 53)"
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: lamounierleao2025@outlook.com
    privateKeySecretRef:
      name: letsencrypt-account-key
    solvers:
      - dns01:
          route53:
            region: ${cfg.awsRegion}
            hostedZoneID: ${publicHzId}
            role: ${dnsRoleArn}
`, cfg);
    log("  ✓ ClusterIssuer 'letsencrypt' applied with DNS-01 solver");

    // Remove ArgoCD tracking annotation so selfHeal doesn't overwrite
    run(
        ['kubectl', 'annotate', 'clusterissuer', 'letsencrypt',
         'argocd.argoproj.io/tracking-id-', '--overwrite'],
        cfg, { check: false },
    );

    // Check if TLS secret already exists — skip cleanup to avoid rate-limit exhaustion
    const secretExists = run(
        ['kubectl', 'get', 'secret', 'ops-tls-cert', '-n', 'kube-system'],
        cfg, { check: false, capture: true },
    );
    if (secretExists.ok) {
        log("  ✓ TLS Secret 'ops-tls-cert' exists — skipping stale resource cleanup");
        run(
            ['kubectl', 'annotate', 'secret', 'ops-tls-cert', '-n', 'kube-system',
             'cert-manager.io/issuer-name=letsencrypt',
             'cert-manager.io/issuer-kind=ClusterIssuer',
             'cert-manager.io/issuer-group=cert-manager.io',
             '--overwrite'],
            cfg, { check: false },
        );
        log('  ✓ TLS Secret annotated — cert-manager will accept existing cert\n');
        return;
    }

    log('  → TLS Secret missing — cleaning up stale cert-manager resources...');
    for (const resource of ['challenge', 'order', 'certificaterequest'] as const) {
        const list = run(
            ['kubectl', 'get', resource, '-n', 'kube-system',
             '-o', 'jsonpath={.items[*].metadata.name}'],
            cfg, { check: false, capture: true },
        );
        if (list.ok && list.stdout.trim()) {
            for (const name of list.stdout.trim().split(' ')) {
                run(['kubectl', 'patch', resource, name, '-n', 'kube-system',
                     '--type', 'merge', '-p', '{"metadata":{"finalizers":null}}'],
                    cfg, { check: false });
            }
            run(['kubectl', 'delete', resource, '--all', '-n', 'kube-system', '--timeout=30s'],
                cfg, { check: false });
            log(`    ✓ Cleaned up stale ${resource}(s)`);
        }
    }
    log('');
};

export const provisionArgocdNotificationsSecret = async (cfg: Config): Promise<void> => {
    log('=== Step 5e: Provisioning ArgoCD Notifications Secret ===');
    const ssmMap: Record<string, string> = {
        'github-appID':          `${cfg.ssmPrefix}/argocd/github-app-id`,
        'github-installationID': `${cfg.ssmPrefix}/argocd/github-installation-id`,
        'github-privateKey':     `${cfg.ssmPrefix}/argocd/github-private-key`,
    };
    if (cfg.dryRun) {
        for (const [key, path] of Object.entries(ssmMap)) {
            log(`  [DRY-RUN] Would read ${path} → secret key '${key}'`);
        }
        log('  [DRY-RUN] Would create/update argocd-notifications-secret\n');
        return;
    }
    const secretData: Record<string, string> = {};
    const missing: string[] = [];
    for (const [key, ssmPath] of Object.entries(ssmMap)) {
        log(`  → Reading from SSM: ${ssmPath}`);
        const value = await ssmGet(cfg, ssmPath, true);
        if (value) {
            secretData[key] = value;
            log(`  ✓ Retrieved '${key}'`);
        } else {
            log(`  ⚠ SSM parameter not found (${ssmPath})`);
            missing.push(ssmPath);
        }
    }
    if (missing.length > 0) {
        log(`  ⚠ ${missing.length} SSM parameter(s) missing — ArgoCD Notifications will not post GitHub statuses`);
        for (const path of missing) log(`      aws ssm put-parameter --name '${path}' --type SecureString --value '<value>'`);
        log('');
        return;
    }
    const stringDataEntries = Object.entries(secretData)
        .map(([k, v]) => `  ${k}: |\n    ${v.replace(/\n/g, '\n    ')}`)
        .join('\n');
    kubectlApplyStdin(`\
apiVersion: v1
kind: Secret
metadata:
  name: argocd-notifications-secret
  namespace: argocd
  labels:
    app.kubernetes.io/managed-by: bootstrap
    app.kubernetes.io/part-of: argocd
type: Opaque
stringData:
${stringDataEntries}
`, cfg);
    log('  ✓ argocd-notifications-secret applied');
    log('    Restart the controller if already running:');
    log('    kubectl rollout restart deployment argocd-notifications-controller -n argocd\n');
};
```

Note for `restoreTlsCert` and `provisionCrossplaneCredentials`: the `require()` calls for `node:path` and `node:fs` in an ESM module must be replaced with top-level `import` statements. Move these imports to the file header:

```typescript
import { join } from 'node:path';
import { existsSync } from 'node:fs';
```

And refactor `restoreTlsCert` to reference `join` and `existsSync` directly.

Similarly, `provisionCrossplaneCredentials` uses `kubectl create namespace` followed by `kubectl apply -f -` — this won't work as written. Fix to use `kubectlApplyStdin` with a Namespace manifest:

```typescript
kubectlApplyStdin(`\
apiVersion: v1
kind: Namespace
metadata:
  name: crossplane-system
`, cfg, { check: false });
```

- [ ] **Step 2: Fix import statements** — add to top of `apps.ts`:

```typescript
import { join } from 'node:path';
import { existsSync } from 'node:fs';
```

Remove `require()` calls from function bodies. Update `restoreTlsCert`:
```typescript
const persistScript = join(cfg.argocdDir, '..', 'cert-manager', 'persist-tls-cert.py');
if (!existsSync(persistScript)) { ... }
```

Update `provisionCrossplaneCredentials` namespace creation to:
```typescript
kubectlApplyStdin(`apiVersion: v1\nkind: Namespace\nmetadata:\n  name: crossplane-system\n`, cfg, { check: false });
```

- [ ] **Step 3: Typecheck**

```bash
cd system/argocd && yarn typecheck
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add system/argocd/steps/apps.ts
git commit -m "feat(argocd): add TypeScript Steps 5–5e (apps, ECR, Crossplane, TLS, cert-manager, notifications)"
```

---

## Task 5: `steps/networking.ts` (Steps 6–7c)

**Files:**
- Create: `system/argocd/steps/networking.ts`

Steps: wait for ArgoCD server readiness, apply ingress (after Traefik CRDs), create IP allowlist middleware, configure GitHub webhook secret.

Key differences:
- `configure_webhook_secret`: `crypto.randomBytes(32).toString('hex')` instead of Python `secrets.token_hex(32)`
- `wait_for_argocd`: `async` due to no-workers early return being determined synchronously, but can remain sync

- [ ] **Step 1: Create `system/argocd/steps/networking.ts`**

```typescript
// @format
// Steps 6–7c: ArgoCD readiness wait, ingress, IP allowlist, webhook secret.

import { randomBytes } from 'node:crypto';
import { log, run, kubectlApplyStdin, ssmGet, ssmPut, sleep } from '../helpers/runner.js';
import type { Config } from '../helpers/config.js';

const hasWorkerNodes = (cfg: Config): boolean => {
    const result = run(
        ['kubectl', 'get', 'nodes', '-l', '!node-role.kubernetes.io/control-plane', '-o', 'name'],
        cfg, { check: false, capture: true },
    );
    return result.ok && result.stdout.trim().split('\n').filter(Boolean).length > 0;
};

const argocdPodsPending = (cfg: Config): boolean => {
    const pending = run(
        ['kubectl', 'get', 'pods', '-n', 'argocd',
         '--field-selector=status.phase=Pending', '-o', 'name'],
        cfg, { check: false, capture: true },
    );
    const running = run(
        ['kubectl', 'get', 'pods', '-n', 'argocd',
         '--field-selector=status.phase=Running', '-o', 'name'],
        cfg, { check: false, capture: true },
    );
    const pendingCount = pending.ok ? pending.stdout.trim().split('\n').filter(Boolean).length : 0;
    const runningCount = running.ok ? running.stdout.trim().split('\n').filter(Boolean).length : 0;
    return pendingCount > 0 && runningCount === 0;
};

export const waitForArgocd = (cfg: Config): void => {
    log('=== Step 6: Waiting for ArgoCD server ===');
    if (cfg.dryRun) {
        log('  [DRY-RUN] Would wait for argocd-server, repo-server, application-controller\n');
        return;
    }
    if (!hasWorkerNodes(cfg)) {
        log('  ℹ No worker nodes — pods remain Pending until workers join');
        log('  → Skipping readiness wait (control plane has NoSchedule taint)\n');
        return;
    }
    if (argocdPodsPending(cfg)) {
        log('  ⚠ All ArgoCD pods Pending — check taints, resource limits, image pull');
        log('  → Skipping rollout wait — re-run bootstrap once pods are Running\n');
        return;
    }
    const targets: Array<[string, string]> = [
        ['deployment', 'argocd-server'],
        ['deployment', 'argocd-repo-server'],
        ['statefulset', 'argocd-application-controller'],
    ];
    const overallDeadline = Date.now() + targets.length * cfg.argoTimeout * 1000;
    const notReady: string[] = [];
    for (const [kind, name] of targets) {
        const remaining = Math.max(0, Math.floor((overallDeadline - Date.now()) / 1000));
        if (remaining === 0) {
            log(`  ⚠ Overall deadline reached — skipping wait for ${name}`);
            notReady.push(name);
            continue;
        }
        const timeout = Math.min(cfg.argoTimeout, remaining);
        log(`  → Waiting for ${name} (timeout: ${timeout}s)...`);
        const result = run(
            ['kubectl', 'rollout', 'status', `${kind}/${name}`,
             '-n', 'argocd', `--timeout=${timeout}s`],
            cfg, { check: false },
        );
        if (result.ok) { log(`  ✓ ${name} ready`); }
        else { log(`  ⚠ ${name} not ready within ${timeout}s`); notReady.push(name); }
    }
    if (notReady.length > 0) log(`  ⚠ Not ready: ${notReady.join(', ')}`);
    log('');
};

export const applyIngress = async (cfg: Config): Promise<void> => {
    log('=== Step 7: Applying ArgoCD ingress ===');
    if (cfg.dryRun) {
        log('  [DRY-RUN] Would apply ingress manifests\n');
        return;
    }
    const argocdPath = cfg.argocdDir;
    const { existsSync } = await import('node:fs');
    const ingress = [
        ['rate-limit-middleware.yaml', 'ArgoCD rate-limit middleware'],
        ['ingress.yaml', 'Main ArgoCD ingress'],
        ['webhook-ingress.yaml', 'GitHub webhook ingress'],
    ] as const;
    const toApply = ingress.filter(([f]) => existsSync(`${argocdPath}/${f}`));
    if (toApply.length === 0) { log('  ⚠ No ingress manifests found\n'); return; }

    const traefik = 'ingressroutes.traefik.io';
    const argoRunning = run(
        ['kubectl', 'get', 'pods', '-n', 'argocd',
         '--field-selector=status.phase=Running', '-o', 'name'],
        cfg, { check: false, capture: true },
    );
    if (!argoRunning.ok || !argoRunning.stdout.trim()) {
        throw new Error('No ArgoCD pods Running — Traefik will not sync yet. SM-B will retry.');
    }
    log(`  → Waiting for Traefik CRD '${traefik}' (timeout: 300s)...`);
    let crdReady = false;
    for (let i = 1; i <= 60; i++) {
        const check = run(['kubectl', 'get', 'crd', traefik], cfg, { check: false, capture: true });
        if (check.ok) { log(`  ✓ Traefik CRD ready (attempt ${i}/60)`); crdReady = true; break; }
        if (i < 60) { if (i % 12 === 0) log(`    Attempt ${i}/60 — still waiting...`); await sleep(5000); }
    }
    if (!crdReady) throw new Error(`Traefik CRD '${traefik}' not available after 300s. SM-B will retry.`);

    for (const [file, label] of toApply) {
        const result = run(['kubectl', 'apply', '-f', `${argocdPath}/${file}`], cfg, { check: false });
        log(result.ok ? `  ✓ ${label} applied` : `  ⚠ Failed to apply ${label}`);
    }

    // Post-apply verification — re-apply if IngressRoute disappeared (race condition)
    for (let i = 1; i <= 3; i++) {
        const verify = run(
            ['kubectl', 'get', 'ingressroute', 'argocd-ingress', '-n', 'argocd', '-o', 'name'],
            cfg, { check: false, capture: true },
        );
        if (verify.ok && verify.stdout.trim()) {
            log('  ✓ IngressRoute verified — argocd-ingress exists in cluster\n');
            return;
        }
        if (i < 3) {
            log(`    Verification attempt ${i}/3 — not found, re-applying in 5s...`);
            await sleep(5000);
            run(['kubectl', 'apply', '-f', `${argocdPath}/ingress.yaml`], cfg, { check: false });
        } else {
            log('  ⚠ IngressRoute verification failed after 3 attempts');
        }
    }
    log('');
};

export const createArgocdIpAllowlist = async (cfg: Config): Promise<void> => {
    log('=== Step 7b: Creating ArgoCD IP Allowlist Middleware ===');
    if (cfg.dryRun) {
        log('  [DRY-RUN] Would read IPs from SSM and create middleware\n');
        return;
    }
    const sourceRanges: string[] = [];
    for (const ssmPath of [
        `${cfg.ssmPrefix}/monitoring/allow-ipv4`,
        `${cfg.ssmPrefix}/monitoring/allow-ipv6`,
    ]) {
        const ip = await ssmGet(cfg, ssmPath);
        if (ip) { sourceRanges.push(ip); log(`  ✓ ${ssmPath}: ${ip}`); }
        else     { log(`  ⚠ IP not found in SSM (${ssmPath})`); }
    }
    if (sourceRanges.length === 0) {
        throw new Error('No admin IPs found in SSM — middleware not created. SM-B will retry.');
    }
    const rangeYaml = sourceRanges.map(ip => `      - "${ip}"`).join('\n');
    kubectlApplyStdin(`\
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: admin-ip-allowlist
  namespace: argocd
  labels:
    app.kubernetes.io/part-of: argocd
spec:
  ipAllowList:
    sourceRange:
${rangeYaml}
`, cfg);
    log(`  ✓ ArgoCD IP allowlist middleware created with ${sourceRanges.length} IP(s)\n`);
};

export const configureWebhookSecret = async (cfg: Config): Promise<void> => {
    log('=== Step 7c: Configuring ArgoCD GitHub webhook secret ===');
    const ssmPath = `${cfg.ssmPrefix}/argocd-webhook-secret`;
    if (cfg.dryRun) {
        log(`  [DRY-RUN] Would generate webhook secret and store at: ${ssmPath}\n`);
        return;
    }
    // Reuse existing secret if present (idempotent)
    let webhookSecret = await ssmGet(cfg, ssmPath, true);
    if (webhookSecret) {
        log('  ✓ Webhook secret already exists in SSM — reusing');
    } else {
        webhookSecret = randomBytes(32).toString('hex');
        log('  ✓ Generated new webhook secret (64 hex chars)');
        try {
            await ssmPut(cfg, ssmPath, webhookSecret, {
                type: 'SecureString',
                description: 'ArgoCD GitHub webhook secret for HMAC validation',
            });
            log(`  ✓ Webhook secret stored in SSM: ${ssmPath}`);
        } catch (e) {
            log(`  ⚠ Failed to store webhook secret in SSM: ${e}`);
        }
    }
    const patch = JSON.stringify({ stringData: { 'webhook.github.secret': webhookSecret } });
    const result = run(
        ['kubectl', '-n', 'argocd', 'patch', 'secret', 'argocd-secret',
         '--type', 'merge', '-p', patch],
        cfg, { check: false },
    );
    log(result.ok
        ? '  ✓ argocd-secret patched with webhook.github.secret'
        : '  ⚠ Failed to patch argocd-secret');
    log('');
};
```

Note: `applyIngress` uses `await import('node:fs')` inside the function. Move the import to the file header:
```typescript
import { existsSync } from 'node:fs';
```

- [ ] **Step 2: Fix import** — add `import { existsSync } from 'node:fs';` at the top; remove the dynamic import inside `applyIngress`.

- [ ] **Step 3: Typecheck**

```bash
cd system/argocd && yarn typecheck
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add system/argocd/steps/networking.ts
git commit -m "feat(argocd): add TypeScript Steps 6–7c (ArgoCD readiness, ingress, IP allowlist, webhook)"
```

---

## Task 6: `steps/auth.ts` (Steps 8–11)

**Files:**
- Create: `system/argocd/steps/auth.ts`

Steps: install ArgoCD CLI, create CI bot account, generate API token → Secrets Manager, set admin password (bcrypt), back up TLS cert, back up JWT signing key, print summary.

Key difference: `set_admin_password` uses `bcryptjs.hashSync(password, bcryptjs.genSaltSync())` instead of Python's `bcrypt.hashpw(password.encode(), bcrypt.gensalt())`.

- [ ] **Step 1: Create `system/argocd/steps/auth.ts`**

```typescript
// @format
// Steps 8–11: CLI install, CI bot, token generation, admin password,
//             TLS backup, signing key backup, summary.

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import bcryptjs from 'bcryptjs';
import { log, run, ssmGet, ssmPut, secretsManagerGet, secretsManagerPut, sleep } from '../helpers/runner.js';
import type { Config } from '../helpers/config.js';

const ARGOCD_SERVER = 'deployment/argocd-server';
const ARGOCD_API_ENDPOINT = 'argocd-server.argocd.svc.cluster.local';

export const installArgocdCli = (cfg: Config): boolean => {
    log('=== Step 8: Installing ArgoCD CLI ===');
    if (cfg.dryRun) {
        log(`  [DRY-RUN] Would install ArgoCD CLI ${cfg.argocdCliVersion}\n`);
        return true;
    }
    if (existsSync('/usr/local/bin/argocd')) {
        const v = run(['argocd', 'version', '--client', '--short'], cfg, { check: false, capture: true });
        log(`  ✓ ArgoCD CLI already present (baked in AMI): ${v.ok ? v.stdout : '(unknown)'}\n`);
        return true;
    }
    const archMap: Record<string, string> = { x64: 'amd64', arm64: 'arm64' };
    const arch = archMap[process.arch] ?? 'amd64';
    const url = `https://github.com/argoproj/argo-cd/releases/download/${cfg.argocdCliVersion}/argocd-linux-${arch}`;
    log(`  → Downloading ArgoCD CLI ${cfg.argocdCliVersion} (${arch})...`);
    const result = run(
        ['bash', '-c', `curl -sSL -o /usr/local/bin/argocd "${url}" && chmod +x /usr/local/bin/argocd`],
        cfg, { check: false },
    );
    if (result.ok) {
        const v = run(['argocd', 'version', '--client', '--short'], cfg, { check: false, capture: true });
        log(`  ✓ ArgoCD CLI installed: ${v.ok ? v.stdout : cfg.argocdCliVersion}\n`);
        return true;
    }
    log('  ⚠ ArgoCD CLI install failed — skipping CI bot token generation\n');
    return false;
};

export const createCiBot = (cfg: Config): void => {
    log('=== Step 9: Creating CI bot account ===');
    if (cfg.dryRun) {
        log('  [DRY-RUN] Would patch argocd-cm and argocd-rbac-cm\n');
        return;
    }
    const cmResult = run(
        ['kubectl', 'patch', 'configmap', 'argocd-cm', '-n', 'argocd',
         '--type', 'merge', '-p', JSON.stringify({ data: { 'accounts.ci-bot': 'apiKey' } })],
        cfg, { check: false },
    );
    log(cmResult.ok ? '  ✓ ci-bot account registered in argocd-cm' : '  ⚠ Failed to patch argocd-cm');
    const rbacCsv = 'p, role:ci-readonly, applications, get, */*, allow\np, role:ci-readonly, applications, list, */*, allow\ng, ci-bot, role:ci-readonly';
    const rbacResult = run(
        ['kubectl', 'patch', 'configmap', 'argocd-rbac-cm', '-n', 'argocd',
         '--type', 'merge', '-p', JSON.stringify({ data: { 'policy.csv': rbacCsv } })],
        cfg, { check: false },
    );
    log(rbacResult.ok ? '  ✓ ci-bot RBAC policy applied (read-only)' : '  ⚠ Failed to patch argocd-rbac-cm');

    // Guard: wait for existing rollout before triggering another restart
    log('  → Checking argocd-server rollout state before restart...');
    const preCheck = run(
        ['kubectl', 'rollout', 'status', ARGOCD_SERVER, '-n', 'argocd', '--timeout=10s'],
        cfg, { check: false },
    );
    if (!preCheck.ok) {
        log(`  ⚠ argocd-server rollout in progress — waiting up to ${cfg.argoTimeout}s...`);
        const settle = run(
            ['kubectl', 'rollout', 'status', ARGOCD_SERVER, '-n', 'argocd', `--timeout=${cfg.argoTimeout}s`],
            cfg, { check: false },
        );
        log(settle.ok ? '  ✓ Existing rollout settled' : `  ⚠ Rollout did not settle within ${cfg.argoTimeout}s`);
    } else {
        log('  ✓ argocd-server fully ready — proceeding with restart');
    }
    log('  → Restarting argocd-server to load ci-bot account...');
    const restart = run(
        ['kubectl', 'rollout', 'restart', ARGOCD_SERVER, '-n', 'argocd'],
        cfg, { check: false },
    );
    if (restart.ok) {
        const wait = run(
            ['kubectl', 'rollout', 'status', ARGOCD_SERVER, '-n', 'argocd', `--timeout=${cfg.argoTimeout}s`],
            cfg, { check: false },
        );
        log(wait.ok ? '  ✓ argocd-server rollout complete — ci-bot loaded' : `  ⚠ Rollout not ready within ${cfg.argoTimeout}s`);
    } else {
        log('  ⚠ Failed to restart argocd-server');
    }
    log('');
};

const resolveAdminPassword = async (cfg: Config): Promise<string> => {
    const ssmPath = `${cfg.ssmPrefix}/argocd-admin-password`;
    const fromSsm = await ssmGet(cfg, ssmPath, true);
    if (fromSsm) {
        log(`  ✓ Admin password resolved from SSM: ${ssmPath}`);
        return fromSsm;
    }
    log(`  ⚠ SSM parameter ${ssmPath} not found — trying initial-admin-secret`);
    const result = run(
        ['kubectl', '-n', 'argocd', 'get', 'secret', 'argocd-initial-admin-secret',
         '-o', 'jsonpath={.data.password}'],
        cfg, { check: false, capture: true },
    );
    if (result.ok && result.stdout) {
        const password = Buffer.from(result.stdout, 'base64').toString('utf-8');
        log('  ✓ Admin password resolved from argocd-initial-admin-secret (Day-0)');
        return password;
    }
    log('  ⚠ No admin password available from SSM or initial-admin-secret');
    return '';
};

export const generateCiToken = async (cfg: Config): Promise<void> => {
    log('=== Step 10: Generating CI bot token ===');
    const secretName = `k8s/${cfg.env}/argocd-ci-token`;
    if (cfg.dryRun) {
        log(`  [DRY-RUN] Would generate token and store at: ${secretName}\n`);
        return;
    }
    log('  → Resolving ArgoCD admin password...');
    const adminPassword = await resolveAdminPassword(cfg);
    if (!adminPassword) {
        log('  ⚠ Cannot generate CI bot token without admin credentials\n');
        return;
    }
    const retryDelays = [15000, 30000, 60000];
    let ciToken = '';
    for (let attempt = 1; attempt <= retryDelays.length; attempt++) {
        log(`  → Attempt ${attempt}/${retryDelays.length}: login + token generation...`);
        const login = run(
            ['argocd', 'login', ARGOCD_API_ENDPOINT,
             '--username', 'admin', '--password', adminPassword, '--plaintext'],
            cfg, { check: false },
        );
        if (!login.ok) {
            log(`    ⚠ ArgoCD API login failed (attempt ${attempt})`);
            if (attempt < retryDelays.length) {
                log(`    → Retrying in ${retryDelays[attempt - 1]! / 1000}s...`);
                await sleep(retryDelays[attempt - 1]!);
            }
            continue;
        }
        log('    ✓ ArgoCD API login successful');
        const token = run(
            ['argocd', 'account', 'generate-token', '--account', 'ci-bot'],
            cfg, { check: false, capture: true },
        );
        ciToken = token.ok ? token.stdout.trim() : '';
        if (ciToken) { log('    ✓ API token generated'); break; }
        log(`    ⚠ Token generation failed (attempt ${attempt})`);
        if (attempt < retryDelays.length) {
            log(`    → Retrying in ${retryDelays[attempt - 1]! / 1000}s...`);
            await sleep(retryDelays[attempt - 1]!);
        }
    }
    if (!ciToken) {
        log('  ✗ Token generation failed after all attempts\n');
        return;
    }
    // Validate token against ArgoCD API
    log('  → Validating token against ArgoCD API...');
    const validate = run(
        ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10',
         '-H', `Authorization: Bearer ${ciToken}`,
         `http://${ARGOCD_API_ENDPOINT}/argocd/api/v1/applications`],
        cfg, { check: false, capture: true },
    );
    const httpCode = validate.ok ? validate.stdout.trim() : '000';
    if (httpCode !== '200') {
        log(`  ✗ Token validation failed (HTTP ${httpCode}) — NOT overwriting Secrets Manager\n`);
        return;
    }
    log('  ✓ Token validated (HTTP 200)');
    log(`  → Pushing token to Secrets Manager: ${secretName}`);
    try {
        await secretsManagerPut(cfg, secretName, ciToken,
            'ArgoCD CI bot API token for pipeline verification');
        log('  ✓ Token stored in Secrets Manager');
    } catch (e) {
        log(`  ⚠ Failed to store token in Secrets Manager: ${e}`);
    }
    log('');
};

export const setAdminPassword = async (cfg: Config): Promise<void> => {
    log('=== Step 10b: Setting ArgoCD admin password from SSM ===');
    if (cfg.dryRun) {
        log(`  [DRY-RUN] Would read ${cfg.ssmPrefix}/argocd-admin-password from SSM and bcrypt hash it\n`);
        return;
    }
    const ssmPath = `${cfg.ssmPrefix}/argocd-admin-password`;
    log(`  → Reading admin password from SSM: ${ssmPath}`);
    const password = await ssmGet(cfg, ssmPath, true);
    if (!password) {
        throw new Error(
            `ArgoCD admin password not found in SSM at '${ssmPath}'. ` +
            `Store it first: aws ssm put-parameter --name '${ssmPath}' --type SecureString --value '<password>'`,
        );
    }
    log('  ✓ Admin password resolved from SSM');
    const hashed = bcryptjs.hashSync(password, bcryptjs.genSaltSync());
    log('  ✓ Password hashed with bcrypt');
    const mtime = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const patch = JSON.stringify({
        stringData: { 'admin.password': hashed, 'admin.passwordMtime': mtime },
    });
    const patchResult = run(
        ['kubectl', '-n', 'argocd', 'patch', 'secret', 'argocd-secret',
         '--type', 'merge', '-p', patch],
        cfg, { check: false },
    );
    if (!patchResult.ok) {
        log('  ⚠ Failed to patch argocd-secret\n');
        return;
    }
    log('  ✓ argocd-secret patched with SSM-managed password');
    const restart = run(
        ['kubectl', 'rollout', 'restart', ARGOCD_SERVER, '-n', 'argocd'],
        cfg, { check: false },
    );
    log(restart.ok ? '  ✓ argocd-server restarted to load new password' : '  ⚠ Failed to restart argocd-server');
    log('');
};

export const backupTlsCert = async (cfg: Config): Promise<void> => {
    log('=== Step 10c: Backing up TLS certificate + ACME key to SSM ===');
    const persistScript = join(cfg.argocdDir, '..', 'cert-manager', 'persist-tls-cert.py');
    if (!existsSync(persistScript)) {
        log(`  ⚠ ${persistScript} not found — skipping TLS backup\n`);
        return;
    }
    const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        KUBECONFIG: cfg.kubeconfig,
        SSM_PREFIX: cfg.ssmPrefix,
        AWS_REGION: cfg.awsRegion,
    };
    // Wait for TLS Secret (cert-manager may still be issuing)
    let tlsReady = false;
    if (!cfg.dryRun) {
        log('  → Waiting for ops-tls-cert Secret to be ready (up to 5 min)...');
        for (let i = 1; i <= 10; i++) {
            const check = run(
                ['kubectl', 'get', 'secret', 'ops-tls-cert', '-n', 'kube-system',
                 '-o', 'jsonpath={.data.tls\\.crt}'],
                cfg, { check: false, capture: true },
            );
            if (check.ok && check.stdout.trim()) {
                log(`  ✓ TLS Secret ready (attempt ${i}/10)`);
                tlsReady = true;
                break;
            }
            if (i < 10) {
                log(`    Attempt ${i}/10 — not ready, waiting 30s...`);
                await sleep(30000);
            }
        }
        if (!tlsReady) log('  ⚠ TLS Secret not ready after 5 min — skipping TLS backup (expected if rate-limited)');
    }
    const toBackup = [
        ...(tlsReady ? [['ops-tls-cert', 'kube-system'] as const] : []),
        ['letsencrypt-account-key', 'cert-manager'] as const,
    ];
    for (const [secret, ns] of toBackup) {
        log(`  → Backing up ${ns}/${secret}...`);
        const args = ['python3', persistScript, '--backup', '--secret', secret, '--namespace', ns];
        if (cfg.dryRun) args.push('--dry-run');
        // Override env for subprocess — runner.ts run() sets KUBECONFIG but we need SSM_PREFIX too
        const { spawnSync } = await import('node:child_process');
        const result = spawnSync(args[0]!, args.slice(1), { env, encoding: 'utf-8', stdio: 'inherit' });
        log(result.status === 0 ? `  ✓ ${secret} backup completed` : `  ⚠ ${secret} backup failed`);
    }
    log('');
};

export const backupArgocdSecretKey = async (cfg: Config): Promise<void> => {
    log('=== Step 10d: Backing up ArgoCD JWT signing key to SSM ===');
    if (cfg.dryRun) {
        log('  [DRY-RUN] Would read server.secretkey and store in SSM\n');
        return;
    }
    const result = run(
        ['kubectl', 'get', 'secret', 'argocd-secret', '-n', 'argocd',
         '-o', 'jsonpath={.data.server\\.secretkey}'],
        cfg, { check: false, capture: true },
    );
    if (!result.ok || !result.stdout.trim()) {
        log('  ⚠ Could not read server.secretkey — skipping SSM backup\n');
        return;
    }
    const paramName = `${cfg.ssmPrefix}/argocd/server-secret-key`;
    try {
        await ssmPut(cfg, paramName, result.stdout.trim(), {
            type: 'SecureString',
            description: 'ArgoCD JWT signing key (base64) — preserved across bootstrap re-runs',
        });
        log(`  ✓ Signing key backed up to SSM: ${paramName}\n`);
    } catch (e) {
        log(`  ⚠ Failed to back up signing key to SSM — ${e}\n`);
    }
};

export const printSummary = (cfg: Config): void => {
    log('=== ArgoCD Bootstrap Summary ===\n');
    if (cfg.dryRun) { log('  [DRY-RUN] Would show pods and applications\n'); return; }
    run(['kubectl', 'get', 'pods', '-n', 'argocd', '-o', 'wide'], cfg, { check: false });
    log('');
    run(['kubectl', 'get', 'applications', '-n', 'argocd'], cfg, { check: false });
    log('');
    log('=== ArgoCD Admin Access ===');
    log('  URL:  https://<eip>/argocd');
    log('  User: admin');
    log(`  Password source: SSM '${cfg.ssmPrefix}/argocd-admin-password'`);
    log('');
    log('  If SSM parameter is not set, retrieve the auto-generated password:');
    log('    kubectl -n argocd get secret argocd-initial-admin-secret \\');
    log('      -o jsonpath="{.data.password}" | base64 -d && echo');
    log(`\n✓ ArgoCD bootstrap complete (${new Date().toISOString()})`);
};
```

Note: `backupTlsCert` uses `await import('node:child_process')` for `spawnSync`. Move to a top-level import:
```typescript
import { spawnSync } from 'node:child_process';
```
Then remove the dynamic import from the function body.

- [ ] **Step 2: Fix import** — add `import { spawnSync } from 'node:child_process';` at the top; remove dynamic import inside `backupTlsCert`.

- [ ] **Step 3: Typecheck**

```bash
cd system/argocd && yarn typecheck
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add system/argocd/steps/auth.ts
git commit -m "feat(argocd): add TypeScript Steps 8–11 (CLI, CI bot, token, admin password, backups, summary)"
```

---

## Task 7: `bootstrap_argocd.ts` (Main Orchestrator)

**Files:**
- Create: `system/argocd/bootstrap_argocd.ts`

Slim async orchestrator matching the Python `main()` exactly — same non-fatal step wrapping, same conditional logic for `cli_installed`.

- [ ] **Step 1: Create `system/argocd/bootstrap_argocd.ts`**

```typescript
#!/usr/bin/env tsx
// @format
// bootstrap_argocd.ts — Bootstrap ArgoCD on Kubernetes (TypeScript rewrite).
//
// Equivalent to bootstrap_argocd.py — runs on the ARC runner pod (Node.js present)
// or any environment where tsx + kubectl + aws CLI are available.
//
// Run: tsx bootstrap_argocd.ts [--dry-run]
// Or:  yarn workspace k8s-argocd-bootstrap bootstrap

import { parseArgs } from './helpers/config.js';
import { BootstrapLogger } from './helpers/logger.js';
import { log } from './helpers/runner.js';

import { createNamespace, resolveDeployKey, createRepoSecret, preserveArgocdSecret } from './steps/namespace.js';
import { restoreArgocdSecret, installArgocd, createDefaultProject, configureArgocdServer, configureHealthChecks } from './steps/install.js';
import {
    applyRootApp,
    injectMonitoringHelmParams,
    seedPrometheusBasicAuth,
    seedEcrCredentials,
    provisionCrossplaneCredentials,
    restoreTlsCert,
    applyCertManagerIssuer,
    provisionArgocdNotificationsSecret,
} from './steps/apps.js';
import { waitForArgocd, applyIngress, createArgocdIpAllowlist, configureWebhookSecret } from './steps/networking.js';
import {
    installArgocdCli,
    createCiBot,
    generateCiToken,
    setAdminPassword,
    backupTlsCert,
    backupArgocdSecretKey,
    printSummary,
} from './steps/auth.js';

const main = async (): Promise<void> => {
    const cfg = parseArgs();

    log('=== ArgoCD Bootstrap ===');
    log(`SSM prefix: ${cfg.ssmPrefix}`);
    log(`Region:     ${cfg.awsRegion}`);
    log(`ArgoCD dir: ${cfg.argocdDir}`);
    log(`Triggered:  ${new Date().toISOString()}`);
    log('');

    if (cfg.dryRun) {
        log('=== DRY RUN — no changes will be made ===');
        log(`  kubeconfig:   ${cfg.kubeconfig}`);
        log(`  argocd_dir:   ${cfg.argocdDir}`);
        log(`  cli_version:  ${cfg.argocdCliVersion}`);
        log(`  argo_timeout: ${cfg.argoTimeout}s`);
        log(`  environment:  ${cfg.env}`);
        log('');
    }

    const logger = new BootstrapLogger(cfg.ssmPrefix, cfg.awsRegion);

    await logger.step('create_namespace',         () => createNamespace(cfg));
    const deployKey   = await logger.step('resolve_deploy_key',    () => resolveDeployKey(cfg));
    await logger.step('create_repo_secret',        () => createRepoSecret(cfg, deployKey));
    const signingKey  = await logger.step('preserve_argocd_secret', () => preserveArgocdSecret(cfg));
    await logger.step('install_argocd',            () => installArgocd(cfg));
    await logger.step('restore_argocd_secret',     () => restoreArgocdSecret(cfg, signingKey));
    await logger.step('create_default_project',    () => createDefaultProject(cfg));
    await logger.step('configure_argocd_server',   () => configureArgocdServer(cfg));
    await logger.step('configure_health_checks',   () => configureHealthChecks(cfg));
    await logger.step('apply_root_app',            () => applyRootApp(cfg));
    await logger.step('inject_monitoring_helm_params', () => injectMonitoringHelmParams(cfg));
    await logger.step('seed_prometheus_basic_auth', () => seedPrometheusBasicAuth(cfg));
    await logger.step('seed_ecr_credentials',      () => seedEcrCredentials(cfg));
    await logger.step('provision_crossplane_credentials', () => provisionCrossplaneCredentials(cfg));
    await logger.step('restore_tls_cert',          () => restoreTlsCert(cfg));

    // Non-fatal: cert-manager CRD may not be ready — SM-B retries
    try {
        await logger.step('apply_cert_manager_issuer', () => applyCertManagerIssuer(cfg));
    } catch (e) {
        log(`  ⚠ apply_cert_manager_issuer failed (non-fatal) — SM-B will retry: ${e}\n`);
    }

    await logger.step('wait_for_argocd', () => waitForArgocd(cfg));

    // Non-fatal: Traefik CRDs may not be ready — SM-B retries
    try {
        await logger.step('apply_ingress', () => applyIngress(cfg));
    } catch (e) {
        log(`  ⚠ apply_ingress failed (non-fatal) — SM-B will retry: ${e}\n`);
    }

    // Non-fatal: same Traefik timing issue — SM-B retries
    try {
        await logger.step('create_argocd_ip_allowlist', () => createArgocdIpAllowlist(cfg));
    } catch (e) {
        log(`  ⚠ create_argocd_ip_allowlist failed (non-fatal) — SM-B will retry: ${e}\n`);
    }

    await logger.step('configure_webhook_secret', () => configureWebhookSecret(cfg));

    // Non-fatal: GitHub App credentials may not exist on first bootstrap
    try {
        await logger.step('provision_argocd_notifications_secret', () => provisionArgocdNotificationsSecret(cfg));
    } catch (e) {
        log(`  ⚠ provision_argocd_notifications_secret failed (non-fatal) — ${e}\n`);
    }

    const cliInstalled = await logger.step('install_argocd_cli', () => installArgocdCli(cfg));

    if (cliInstalled) {
        try {
            await logger.step('create_ci_bot', () => createCiBot(cfg));
        } catch (e) {
            log(`  ⚠ create_ci_bot failed — non-fatal, will retry: ${e}`);
        }
        try {
            await logger.step('generate_ci_token', () => generateCiToken(cfg));
        } catch (e) {
            log(`  ⚠ generate_ci_token failed — non-fatal, will retry: ${e}`);
        }
    } else {
        logger.skip('create_ci_bot', 'ArgoCD CLI not available');
        logger.skip('generate_ci_token', 'ArgoCD CLI not available');
        log('=== Step 9-10: Skipping — ArgoCD CLI not available ===\n');
    }

    await logger.step('set_admin_password',       () => setAdminPassword(cfg));
    await logger.step('backup_tls_cert',          () => backupTlsCert(cfg));
    await logger.step('backup_argocd_secret_key', () => backupArgocdSecretKey(cfg));
    await logger.step('print_summary',            () => printSummary(cfg));
};

main().catch(err => {
    console.error('Bootstrap failed:', err);
    process.exit(1);
});
```

- [ ] **Step 2: Typecheck the entire workspace**

```bash
cd system/argocd && yarn typecheck
```

Expected: exits 0. All 8 TypeScript files (3 helpers + 5 steps + 1 orchestrator) type-check clean.

- [ ] **Step 3: Dry-run smoke test**

```bash
cd system/argocd && DRY_RUN=true yarn bootstrap:dry-run
```

Expected output (first few lines):
```
=== ArgoCD Bootstrap ===
SSM prefix: /k8s/development
Region:     eu-west-1
ArgoCD dir: /data/k8s-bootstrap/system/argocd
Triggered:  <timestamp>

=== DRY RUN — no changes will be made ===
  kubeconfig:   /etc/kubernetes/admin.conf
  ...
```

Expected: no unhandled exceptions, all steps log `[DRY-RUN]` lines, exits 0.

Note: `yarn bootstrap:dry-run` sets `--dry-run` via the script. The `parseArgs()` in `config.ts` checks `process.argv.includes('--dry-run')` — confirm this is the case before running.

- [ ] **Step 4: Commit**

```bash
git add system/argocd/bootstrap_argocd.ts
git commit -m "feat(argocd): add TypeScript ArgoCD bootstrap orchestrator (tsx entry point)"
```

---

## Task 8: CI Integration and Cleanup

**Files:**
- Modify: `.github/workflows/ci.yml` — add TypeScript typecheck job for `system/argocd`
- Modify: `system/argocd/helpers/runner.ts` — review and fix any remaining type issues surfaced by full typecheck

- [ ] **Step 1: Add `ts-argocd-typecheck` job to `ci.yml`**

Add after the existing `ts-lint` job (line ~87):

```yaml
  # ---------------------------------------------------------------------------
  # TypeScript: type-check (system/argocd bootstrap runner)
  # ---------------------------------------------------------------------------
  ts-argocd-typecheck:
    name: TypeScript Typecheck (argocd bootstrap)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js and install dependencies
        uses: ./.github/actions/setup-node-yarn
        with:
          node-version: "22"

      - name: Typecheck argocd bootstrap
        run: yarn workspace k8s-argocd-bootstrap typecheck
```

- [ ] **Step 2: Add `ts-argocd-typecheck` to any CI gate job**

In `ci.yml`, if there is a `quality-gate` or `all-checks` job that waits on other jobs, add `ts-argocd-typecheck` to its `needs:` array. If no gate job exists, skip this step.

- [ ] **Step 3: Run full CI typecheck locally to confirm**

```bash
yarn workspace k8s-argocd-bootstrap typecheck
```

Expected: exits 0.

- [ ] **Step 4: Commit CI integration**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add TypeScript typecheck job for argocd bootstrap runner"
```

---

## Verification Checklist

After all tasks are complete:

- [ ] `cd system/argocd && yarn typecheck` exits 0
- [ ] `yarn workspace k8s-argocd-bootstrap bootstrap:dry-run` exits 0 with `[DRY-RUN]` output for every step
- [ ] `yarn install` from repo root installs `system/argocd` deps without error
- [ ] CI `ts-argocd-typecheck` job passes on push
- [ ] Python `bootstrap_argocd.py` still exists and is functional (TypeScript version is additive — both coexist until the runner migration is fully validated)
