// @format
// Steps 8–11: ArgoCD CLI install, CI bot account, token generation, admin password, TLS/secret backups, summary.

import { existsSync } from 'node:fs';
import bcryptjs from 'bcryptjs';
import type { Config } from '../helpers/config.js';
import {
    hasSchedulableWorkers,
    log,
    run,
    sleep,
    ssmGet,
    ssmPut,
    secretsManagerPut,
} from '../helpers/runner.js';
import { backupCert } from '../helpers/tls-cert.js';

const ARGOCD_SERVER = 'deployment/argocd-server';
const ARGOCD_API_ENDPOINT = 'argocd-server.argocd.svc.cluster.local';

// Step 8 — installs ArgoCD CLI if not already present.
export const installArgocdCli = (cfg: Config): boolean => {
    log('=== Step 8: Installing ArgoCD CLI ===');

    if (cfg.dryRun) {
        log('  [DRY-RUN] installArgocdCli');
        return true;
    }

    if (existsSync('/usr/local/bin/argocd')) {
        const versionResult = run(
            ['argocd', 'version', '--client', '--short'],
            cfg,
            { check: false, capture: true },
        );
        const version = versionResult.stdout || cfg.argocdCliVersion;
        log(`  ✓ ArgoCD CLI already present: ${version}`);
        return true;
    }

    const archMap: Record<string, string> = { x64: 'amd64', arm64: 'arm64' };
    const arch = archMap[process.arch] ?? 'amd64';
    const url = `https://github.com/argoproj/argo-cd/releases/download/${cfg.argocdCliVersion}/argocd-linux-${arch}`;

    const installResult = run(
        ['bash', '-c', `curl -sSL -o /usr/local/bin/argocd "${url}" && chmod +x /usr/local/bin/argocd`],
        cfg,
        { check: false },
    );

    if (installResult.ok) {
        const versionResult = run(
            ['argocd', 'version', '--client', '--short'],
            cfg,
            { check: false, capture: true },
        );
        const version = versionResult.stdout || cfg.argocdCliVersion;
        log(`  ✓ ArgoCD CLI installed: ${version}`);
        return true;
    }

    log('  ⚠ ArgoCD CLI install failed');
    return false;
};

// Step 9 — creates CI bot account and RBAC policy in ArgoCD.
export const createCiBot = (cfg: Config): void => {
    log('=== Step 9: Creating CI bot account ===');

    if (cfg.dryRun) {
        log('  [DRY-RUN] createCiBot');
        return;
    }

    // Patch argocd-cm to add accounts.ci-bot
    const cmPatchResult = run(
        [
            'kubectl', 'patch', 'configmap', 'argocd-cm',
            '-n', 'argocd',
            '--type', 'merge',
            '-p', '{"data":{"accounts.ci-bot":"apiKey"}}',
        ],
        cfg,
        { check: false },
    );
    log(cmPatchResult.ok
        ? '  ✓ argocd-cm patched with accounts.ci-bot'
        : `  ⚠ Failed to patch argocd-cm: ${cmPatchResult.stderr}`);

    // Patch argocd-rbac-cm with CI readonly policy
    const rbacPolicy = [
        'p, role:ci-readonly, applications, get, */*, allow',
        'p, role:ci-readonly, applications, list, */*, allow',
        'g, ci-bot, role:ci-readonly',
    ].join('\n');
    const rbacPatch = JSON.stringify({ data: { 'policy.csv': rbacPolicy } });
    const rbacResult = run(
        [
            'kubectl', 'patch', 'configmap', 'argocd-rbac-cm',
            '-n', 'argocd',
            '--type', 'merge',
            '-p', rbacPatch,
        ],
        cfg,
        { check: false },
    );
    log(rbacResult.ok
        ? '  ✓ argocd-rbac-cm patched with ci-readonly policy'
        : `  ⚠ Failed to patch argocd-rbac-cm: ${rbacResult.stderr}`);

    // ConfigMap patches are persisted; the rolling restart only matters when
    // pods can actually schedule. On a control-plane-only cluster (workers not
    // joined yet) the rollout would block until SSM kills the bootstrap (exit
    // 143). ArgoCD reconciliation will pick up the configmap state once
    // workers join and pods become schedulable.
    if (!hasSchedulableWorkers(cfg)) {
        log('  ⚠ No worker nodes — skipping argocd-server rollout (ArgoCD will reconcile once workers join)');
        log('');
        return;
    }

    // Guard: check if argocd-server rollout is in progress before restart
    const quickStatusResult = run(
        ['kubectl', 'rollout', 'status', ARGOCD_SERVER, '-n', 'argocd', '--timeout=10s'],
        cfg,
        { check: false },
    );
    if (!quickStatusResult.ok) {
        log(`  ⚠ argocd-server rollout in progress — waiting up to ${cfg.argoTimeout}s...`);
        const settleResult = run(
            ['kubectl', 'rollout', 'status', ARGOCD_SERVER, '-n', 'argocd', `--timeout=${cfg.argoTimeout}s`],
            cfg,
            { check: false },
        );
        log(settleResult.ok ? '  ✓ Existing rollout settled' : `  ⚠ Rollout did not settle within ${cfg.argoTimeout}s`);
    }

    // Restart argocd-server to pick up config changes
    const restartResult = run(
        ['kubectl', 'rollout', 'restart', ARGOCD_SERVER, '-n', 'argocd'],
        cfg,
        { check: false },
    );
    log(restartResult.ok
        ? '  ✓ argocd-server restart triggered'
        : `  ⚠ Failed to restart argocd-server: ${restartResult.stderr}`);

    // Wait for rollout to complete
    const rolloutResult = run(
        ['kubectl', 'rollout', 'status', ARGOCD_SERVER, '-n', 'argocd', `--timeout=${cfg.argoTimeout}s`],
        cfg,
        { check: false },
    );
    log(rolloutResult.ok
        ? '  ✓ argocd-server rollout complete'
        : `  ⚠ argocd-server rollout did not complete in ${cfg.argoTimeout}s`);

    log('');
};

// Step 10 — logs into ArgoCD via CLI and generates a CI bot API token.
export const generateCiToken = async (cfg: Config): Promise<void> => {
    log('=== Step 10: Generating CI bot token ===');

    const secretName = `k8s/${cfg.env}/argocd-ci-token`;

    if (cfg.dryRun) {
        log('  [DRY-RUN] generateCiToken');
        return;
    }

    // Resolve admin password
    let adminPassword = await ssmGet(cfg, `${cfg.ssmPrefix}/argocd-admin-password`, true);

    if (adminPassword) {
        log(`  ✓ Admin password resolved from SSM: ${cfg.ssmPrefix}/argocd-admin-password`);
    } else {
        const secretResult = run(
            [
                'kubectl', '-n', 'argocd', 'get', 'secret', 'argocd-initial-admin-secret',
                '-o', 'jsonpath={.data.password}',
            ],
            cfg,
            { check: false, capture: true },
        );
        if (secretResult.ok && secretResult.stdout) {
            adminPassword = Buffer.from(secretResult.stdout, 'base64').toString('utf-8');
            log('  ✓ Admin password resolved from argocd-initial-admin-secret (Day-0)');
        }
    }

    if (!adminPassword) {
        log('  ⚠ Could not resolve ArgoCD admin password — skipping token generation');
        return;
    }

    const retryDelays = [15000, 30000, 60000];
    let ciToken = '';

    for (let attempt = 1; attempt <= 3; attempt++) {
        const loginResult = run(
            [
                'argocd', 'login', ARGOCD_API_ENDPOINT,
                '--username', 'admin',
                '--password', adminPassword,
                '--plaintext',
            ],
            cfg,
            { check: false, capture: true },
        );

        if (!loginResult.ok) {
            log(`  ⚠ ArgoCD login failed (attempt ${attempt}/3)${loginResult.stderr ? `: ${loginResult.stderr}` : ''}`);
            if (attempt < 3) await sleep(retryDelays[attempt - 1]!);
            continue;
        }

        const tokenResult = run(
            ['argocd', 'account', 'generate-token', '--account', 'ci-bot'],
            cfg,
            { check: false, capture: true },
        );

        if (!tokenResult.stdout) {
            log(`  ⚠ Token generation returned empty (attempt ${attempt}/3)`);
            if (attempt < 3) await sleep(retryDelays[attempt - 1]!);
            continue;
        }

        ciToken = tokenResult.stdout;
        break;
    }

    if (!ciToken) {
        log('  ✗ Failed to generate CI bot token after 3 attempts');
        return;
    }

    // Validate token
    const validateResult = run(
        [
            'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}',
            '--max-time', '10',
            '-H', `Authorization: Bearer ${ciToken}`,
            `http://${ARGOCD_API_ENDPOINT}/argocd/api/v1/applications`,
        ],
        cfg,
        { check: false, capture: true },
    );

    if (validateResult.stdout !== '200') {
        log(`  ✗ Token validation failed — HTTP ${validateResult.stdout}`);
        return;
    }

    log('  ✓ CI bot token validated (HTTP 200)');

    try {
        const action = await secretsManagerPut(
            cfg,
            secretName,
            ciToken,
            'ArgoCD CI bot API token for pipeline verification',
        );
        log(`  ✓ CI bot token ${action} in Secrets Manager: ${secretName}`);
    } catch (err) {
        log(`  ⚠ Failed to store CI bot token in Secrets Manager: ${(err as Error).message}`);
    }

    log('');
};

// Step 10b — reads admin password from SSM, bcrypt-hashes it, patches into argocd-secret.
export const setAdminPassword = async (cfg: Config): Promise<void> => {
    log('=== Step 10b: Setting ArgoCD admin password from SSM ===');

    if (cfg.dryRun) {
        log('  [DRY-RUN] setAdminPassword');
        return;
    }

    const password = await ssmGet(cfg, `${cfg.ssmPrefix}/argocd-admin-password`, true);
    if (password === null) {
        throw new Error(
            `ArgoCD admin password not found in SSM at '${cfg.ssmPrefix}/argocd-admin-password'. ` +
            'Store the desired password there first, then re-run the bootstrap.',
        );
    }

    const hash = bcryptjs.hashSync(password, bcryptjs.genSaltSync());
    log('  ✓ Password hashed with bcrypt');

    const mtime = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const patch = JSON.stringify({ stringData: { 'admin.password': hash, 'admin.passwordMtime': mtime } });

    const patchResult = run(
        ['kubectl', '-n', 'argocd', 'patch', 'secret', 'argocd-secret', '--type', 'merge', '-p', patch],
        cfg,
        { check: false },
    );
    if (!patchResult.ok) {
        log(`  ⚠ Failed to patch argocd-secret: ${patchResult.stderr}`);
        return;
    }
    log('  ✓ argocd-secret patched with new admin password hash');

    const restartResult = run(
        ['kubectl', 'rollout', 'restart', ARGOCD_SERVER, '-n', 'argocd'],
        cfg,
        { check: false },
    );
    log(restartResult.ok
        ? '  ✓ argocd-server restart triggered'
        : `  ⚠ Failed to restart argocd-server: ${restartResult.stderr}`);

    log('');
};

// Step 10c — backs up TLS cert and ACME key to SSM.
export const backupTlsCert = async (cfg: Config): Promise<void> => {
    log('=== Step 10c: Backing up TLS certificate + ACME key to SSM ===');

    // Wait up to 5 minutes (10 × 30 s) for cert-manager to issue ops-tls-cert
    let tlsReady = false;
    if (!cfg.dryRun) {
        for (let attempt = 1; attempt <= 10; attempt++) {
            const certResult = run(
                ['kubectl', 'get', 'secret', 'ops-tls-cert', '-n', 'kube-system',
                    '-o', 'jsonpath={.data.tls\\.crt}'],
                cfg,
                { check: false, capture: true },
            );
            if (certResult.ok && certResult.stdout) { tlsReady = true; break; }
            log(`  Waiting for ops-tls-cert Secret... (attempt ${attempt}/10)`);
            if (attempt < 10) await sleep(30_000);
        }
        if (!tlsReady) {
            log('  ⚠ ops-tls-cert not ready after 5 min — possibly rate-limited (non-fatal)');
        }
    }

    if (tlsReady) await backupCert(cfg, 'ops-tls-cert', 'kube-system');
    await backupCert(cfg, 'letsencrypt-account-key', 'cert-manager');
    log('');
};

// Step 10d — backs up ArgoCD JWT signing key to SSM.
export const backupArgocdSecretKey = async (cfg: Config): Promise<void> => {
    log('=== Step 10d: Backing up ArgoCD JWT signing key to SSM ===');

    if (cfg.dryRun) {
        log('  [DRY-RUN] backupArgocdSecretKey');
        return;
    }

    const result = run(
        [
            'kubectl', 'get', 'secret', 'argocd-secret',
            '-n', 'argocd',
            '-o', 'jsonpath={.data.server\\.secretkey}',
        ],
        cfg,
        { check: false, capture: true },
    );

    if (!result.ok || !result.stdout) {
        log('  ⚠ Could not read argocd-secret server.secretkey — skipping backup');
        return;
    }

    try {
        await ssmPut(
            cfg,
            `${cfg.ssmPrefix}/argocd/server-secret-key`,
            result.stdout.trim(),
            {
                type: 'SecureString',
                description: 'ArgoCD JWT signing key (base64) — preserved across bootstrap re-runs',
            },
        );
        log('  ✓ ArgoCD JWT signing key backed up to SSM');
    } catch (err) {
        log(`  ⚠ Failed to back up ArgoCD signing key to SSM: ${(err as Error).message}`);
    }

    log('');
};

// Step 11 — prints pods and applications summary.
export const printSummary = (cfg: Config): void => {
    log('=== ArgoCD Bootstrap Summary ===\n');

    if (cfg.dryRun) {
        log('  [DRY-RUN] printSummary');
        return;
    }

    run(['kubectl', 'get', 'pods', '-n', 'argocd', '-o', 'wide'], cfg, { check: false });
    log('');

    run(['kubectl', 'get', 'applications', '-n', 'argocd'], cfg, { check: false });
    log('');

    const eip = process.env['EIP'] ?? '<eip>';
    const timestamp = new Date().toISOString();

    log(`=== ArgoCD Admin Access ===
  URL:  https://${eip}/argocd
  User: admin
  Password source: SSM '${cfg.ssmPrefix}/argocd-admin-password'

  If SSM parameter is not set, retrieve the auto-generated password:
    kubectl -n argocd get secret argocd-initial-admin-secret \\
      -o jsonpath="{.data.password}" | base64 -d && echo

✓ ArgoCD bootstrap complete (${timestamp})`);
};
