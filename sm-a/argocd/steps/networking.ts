// @format
// Steps 6–7c: ArgoCD readiness, ingress, IP allowlist, and GitHub webhook secret.

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Config } from '../helpers/config.js';
import { kubectlApplyStdin, log, run, sleep, ssmGet, ssmPut } from '../helpers/runner.js';

// Step 6 — waits for ArgoCD core deployments to be ready.
export const waitForArgocd = (cfg: Config): void => {
    log('=== Step 6: Waiting for ArgoCD server ===');

    if (cfg.dryRun) {
        log('  [DRY-RUN] waitForArgocd');
        return;
    }

    // Check worker nodes are present
    const nodesResult = run(
        ['kubectl', 'get', 'nodes', '-l', '!node-role.kubernetes.io/control-plane', '-o', 'name'],
        cfg,
        { check: false, capture: true },
    );
    if (!nodesResult.ok || nodesResult.stdout.split('\n').filter(l => l.trim() !== '').length === 0) {
        log('  No worker nodes — pods remain Pending');
        return;
    }

    // Check if all pods Pending and none Running (control-plane-only cluster)
    const pendingResult = run(
        ['kubectl', 'get', 'pods', '-n', 'argocd', '--field-selector=status.phase=Pending', '-o', 'name'],
        cfg,
        { check: false, capture: true },
    );
    const runningResult = run(
        ['kubectl', 'get', 'pods', '-n', 'argocd', '--field-selector=status.phase=Running', '-o', 'name'],
        cfg,
        { check: false, capture: true },
    );
    const pendingCount = pendingResult.stdout.split('\n').filter(l => l.trim() !== '').length;
    const runningCount = runningResult.stdout.split('\n').filter(l => l.trim() !== '').length;
    if (pendingCount > 0 && runningCount === 0) {
        log('  ⚠ All ArgoCD pods are Pending and none Running — control-plane only, cannot schedule');
        return;
    }

    const targets = [
        ['deployment', 'argocd-server'],
        ['deployment', 'argocd-repo-server'],
        ['statefulset', 'argocd-application-controller'],
    ] as const;

    const overallDeadline = Date.now() + targets.length * cfg.argoTimeout * 1000;
    const notReady: string[] = [];

    for (const [kind, name] of targets) {
        const remaining = Math.max(0, Math.floor((overallDeadline - Date.now()) / 1000));
        if (remaining === 0) {
            log(`  Overall deadline reached — skipping wait for ${name}`);
            notReady.push(name);
            continue;
        }
        const timeout = Math.min(cfg.argoTimeout, remaining);
        const result = run(
            ['kubectl', 'rollout', 'status', `${kind}/${name}`, '-n', 'argocd', `--timeout=${timeout}s`],
            cfg,
            { check: false },
        );
        if (result.ok) {
            log(`  ✓ ${name} ready`);
        } else {
            log(`  ⚠ ${name} did not become ready in time`);
            notReady.push(name);
        }
    }

    if (notReady.length > 0) {
        log(`  ⚠ Not ready: ${notReady.join(', ')}`);
    }

    log('');
};

// Step 7 — applies ArgoCD ingress manifests (depends on Traefik CRDs being ready).
export const applyIngress = async (cfg: Config): Promise<void> => {
    log('=== Step 7: Applying ArgoCD ingress ===');

    if (cfg.dryRun) {
        log('  [DRY-RUN] applyIngress');
        return;
    }

    // Check ArgoCD pods running before waiting for Traefik
    const argoRunningResult = run(
        ['kubectl', 'get', 'pods', '-n', 'argocd', '--field-selector=status.phase=Running', '-o', 'name'],
        cfg,
        { check: false, capture: true },
    );
    if (!argoRunningResult.ok || argoRunningResult.stdout.split('\n').filter(l => l.trim() !== '').length === 0) {
        throw new Error('No ArgoCD pods are Running — cannot apply ingress yet (SM-B will retry)');
    }

    const candidates = [
        ['rate-limit-middleware.yaml', 'ArgoCD rate-limit middleware'],
        ['ingress.yaml', 'Main ArgoCD ingress'],
        ['webhook-ingress.yaml', 'GitHub webhook ingress'],
    ] as const;

    const existingFiles = candidates.filter(([file]) => existsSync(`${cfg.argocdDir}/${file}`));

    if (existingFiles.length === 0) {
        log('  ⚠ No ingress files found in argocdDir — skipping');
        return;
    }

    // Wait for Traefik CRD ingressroutes.traefik.io (60 × 5s = 300s)
    let traefikReady = false;
    for (let attempt = 1; attempt <= 60; attempt++) {
        const crdResult = run(
            ['kubectl', 'get', 'crd', 'ingressroutes.traefik.io'],
            cfg,
            { check: false, capture: true },
        );
        if (crdResult.ok) {
            log(`  ✓ Traefik CRD ready (attempt ${attempt}/60)`);
            traefikReady = true;
            break;
        }
        if (attempt < 60) {
            if (attempt % 12 === 0) {
                log(`  Waiting for Traefik CRD... (attempt ${attempt}/60)`);
            }
            await sleep(5000);
        }
    }
    if (!traefikReady) {
        throw new Error('Traefik CRD ingressroutes.traefik.io not found after 300s — cannot apply ingress');
    }

    // Apply each existing file
    for (const [file, label] of existingFiles) {
        const path = `${cfg.argocdDir}/${file}`;
        const applyResult = run(
            ['kubectl', 'apply', '-f', path],
            cfg,
            { check: false, capture: true },
        );
        if (applyResult.ok) {
            log(`  ✓ Applied ${label} (${file})`);
        } else {
            log(`  ⚠ Failed to apply ${label} (${file}): ${applyResult.stderr}`);
        }
    }

    // Post-apply verification for argocd-ingress IngressRoute (3 attempts × 5s)
    const ingressYamlPath = `${cfg.argocdDir}/ingress.yaml`;
    for (let attempt = 1; attempt <= 3; attempt++) {
        const verifyResult = run(
            ['kubectl', 'get', 'ingressroute', 'argocd-ingress', '-n', 'argocd', '-o', 'name'],
            cfg,
            { check: false, capture: true },
        );
        if (verifyResult.ok && verifyResult.stdout.trim() !== '') {
            log('  ✓ argocd-ingress IngressRoute verified');
            log('');
            return;
        }
        if (attempt < 3) {
            log(`  Verification attempt ${attempt}/3 — not found, re-applying in 5s...`);
            await sleep(5000);
            run(['kubectl', 'apply', '-f', ingressYamlPath], cfg, { check: false });
        } else {
            log('  ⚠ argocd-ingress IngressRoute not found after 3 verification attempts');
        }
    }

    log('');
};

// Step 7b — creates the Traefik IP allowlist middleware from SSM IPs.
export const createArgocdIpAllowlist = async (cfg: Config): Promise<void> => {
    log('=== Step 7b: Creating ArgoCD IP Allowlist Middleware ===');

    if (cfg.dryRun) {
        log('  [DRY-RUN] createArgocdIpAllowlist');
        return;
    }

    const ssmPaths = [
        `${cfg.ssmPrefix}/monitoring/allow-ipv4`,
        `${cfg.ssmPrefix}/monitoring/allow-ipv6`,
    ] as const;

    const sourceRanges: string[] = [];
    for (const path of ssmPaths) {
        const ip = await ssmGet(cfg, path);
        if (ip !== null) {
            log(`  ✓ ${path}: ${ip}`);
            sourceRanges.push(ip);
        } else {
            log(`  ⚠ IP not found in SSM (${path})`);
        }
    }

    if (sourceRanges.length === 0) {
        throw new Error('No IPs found in SSM for ArgoCD IP allowlist — SM-B will retry');
    }

    const ipEntries = sourceRanges.map(ip => `      - "${ip}"`).join('\n');
    const yaml = `apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: admin-ip-allowlist
  namespace: argocd
  labels:
    app.kubernetes.io/part-of: argocd
spec:
  ipAllowList:
    sourceRange:
${ipEntries}
`;

    const applyResult = kubectlApplyStdin(yaml, cfg, { check: false });
    if (applyResult.ok) {
        log('  ✓ admin-ip-allowlist Middleware applied');
        log(`  ✓ ArgoCD IP allowlist middleware created with ${sourceRanges.length} IP(s)\n`);
    } else {
        log(`  ⚠ Failed to apply admin-ip-allowlist Middleware: ${applyResult.stderr}`);
    }
};

// Step 7c — generates or reuses a GitHub webhook secret and patches it into argocd-secret.
export const configureWebhookSecret = async (cfg: Config): Promise<void> => {
    log('=== Step 7c: Configuring ArgoCD GitHub webhook secret ===');

    const ssmPath = `${cfg.ssmPrefix}/argocd-webhook-secret`;

    if (cfg.dryRun) {
        log(`  [DRY-RUN] configureWebhookSecret (SSM path: ${ssmPath})`);
        return;
    }

    let webhookSecret: string;

    const existing = await ssmGet(cfg, ssmPath, true);
    if (existing !== null) {
        log('  ✓ Webhook secret already exists in SSM — reusing');
        webhookSecret = existing;
    } else {
        webhookSecret = randomBytes(32).toString('hex');
        log('  ✓ Generated new webhook secret (64 hex chars)');
        try {
            await ssmPut(cfg, ssmPath, webhookSecret, {
                type: 'SecureString',
                description: 'ArgoCD GitHub webhook secret for HMAC validation',
            });
            log('  ✓ Webhook secret stored in SSM');
        } catch (err) {
            log(`  ⚠ Failed to store webhook secret in SSM: ${(err as Error).message}`);
        }
    }

    // Patch argocd-secret
    const patchJson = JSON.stringify({ stringData: { 'webhook.github.secret': webhookSecret } });
    const patchResult = run(
        ['kubectl', '-n', 'argocd', 'patch', 'secret', 'argocd-secret', '--type', 'merge', '-p', patchJson],
        cfg,
        { check: false },
    );
    if (patchResult.ok) {
        log('  ✓ argocd-secret patched with GitHub webhook secret');
    } else {
        log(`  ⚠ Failed to patch argocd-secret: ${patchResult.stderr}`);
    }

    log('');
};
