/**
 * @format
 * Shared bootstrap utilities — used by control_plane.ts and worker.ts.
 *
 * Migrated from boot/steps/common.py (Python StepRunner, run_cmd, SSM helpers).
 * All AWS operations use SDK v3. Arrow functions throughout.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

// =============================================================================
// Types
// =============================================================================

export interface RunResult {
    readonly ok: boolean;
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number;
}

export interface StepRecord {
    readonly step: string;
    readonly status: 'success' | 'failed' | 'skipped';
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly elapsedMs: number;
    readonly error?: string;
}

// Minimal config shape required by runStep — both BootConfig and WorkerConfig satisfy this.
export interface BaseConfig {
    readonly ssmPrefix: string;
    readonly awsRegion: string;
}

// =============================================================================
// Constants
// =============================================================================

export const RUN_SUMMARY_FILE    = '/var/lib/k8s-bootstrap/run_summary.json';
export const ECR_PROVIDER_BIN    = '/usr/local/bin/ecr-credential-provider';
export const ECR_PROVIDER_CONFIG = '/etc/kubernetes/image-credential-provider-config.yaml';
export const ECR_PROVIDER_VERSION = 'v1.31.0';

export const ECR_PROVIDER_CONFIG_CONTENT = [
    'apiVersion: kubelet.config.k8s.io/v1',
    'kind: CredentialProviderConfig',
    'providers:',
    '  - name: ecr-credential-provider',
    '    matchImages:',
    '      - "*.dkr.ecr.*.amazonaws.com"',
    '    defaultCacheDuration: "12h"',
    '    apiVersion: credentialprovider.kubelet.k8s.io/v1',
    '',
].join('\n');

// =============================================================================
// Logging — JSON-structured to stdout (parsed by CloudWatch Logs)
// =============================================================================

export const log = (level: 'INFO' | 'WARN' | 'ERROR', message: string, extra?: Record<string, unknown>): void => {
    process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...extra }) + '\n');
};

export const info  = (msg: string, extra?: Record<string, unknown>): void => log('INFO',  msg, extra);
export const warn  = (msg: string, extra?: Record<string, unknown>): void => log('WARN',  msg, extra);
export const error = (msg: string, extra?: Record<string, unknown>): void => log('ERROR', msg, extra);

// =============================================================================
// Subprocess runner — spawnSync array form, never shell string interpolation
// =============================================================================

export const run = (
    cmd: string[],
    opts: {
        env?: Record<string, string>;
        input?: string | Buffer;
        check?: boolean;
        timeout?: number;
        capture?: boolean;
    } = {},
): RunResult => {
    const { env, input, check = true, timeout = 300_000, capture = true } = opts;
    const mergedEnv = env ? { ...process.env, ...env } as NodeJS.ProcessEnv : process.env;

    info(`Running: ${cmd.join(' ')}`);
    const t = Date.now();

    const result = spawnSync(cmd[0], cmd.slice(1), {
        env: mergedEnv,
        input,
        timeout,
        encoding: 'buffer',
        stdio: capture ? 'pipe' : ['pipe', 'inherit', 'inherit'],
    });

    const stdout = result.stdout ? result.stdout.toString('utf8') : '';
    const stderr = result.stderr ? result.stderr.toString('utf8') : '';
    const code   = result.status ?? -1;
    const ok     = code === 0;

    info('Command finished', { durationMs: Date.now() - t, ok });
    if (!ok && stderr) error('Command stderr', { command: cmd[0], stderr: stderr.slice(0, 500) });
    if (!ok && check) throw new Error(`Command failed (exit ${code}): ${cmd.join(' ')}\n${stderr.slice(0, 1000)}`);

    return { ok, stdout, stderr, code };
};

// =============================================================================
// IMDS v2
// =============================================================================

export const imds = (path: string): string => {
    const tokenRes = run(
        ['curl', '-sX', 'PUT', 'http://169.254.169.254/latest/api/token',
            '-H', 'X-aws-ec2-metadata-token-ttl-seconds: 21600'],
        { check: false },
    );
    if (!tokenRes.ok) return '';
    const token = tokenRes.stdout.trim();
    const res = run(
        ['curl', '-s', '-H', `X-aws-ec2-metadata-token: ${token}`,
            `http://169.254.169.254/latest/meta-data/${path}`],
        { check: false },
    );
    return res.ok ? res.stdout.trim() : '';
};

// =============================================================================
// AWS SDK SSM client — lazy-initialized once per process
// =============================================================================

let _ssm: SSMClient | undefined;

export const ssmClient  = (region: string): SSMClient => (_ssm ??= new SSMClient({ region }));

export const ssmPut = async (
    name: string,
    value: string,
    region: string,
    type: 'String' | 'SecureString' = 'String',
    tier?: 'Standard' | 'Advanced',
): Promise<void> => {
    await ssmClient(region).send(new PutParameterCommand({
        Name: name, Value: value, Type: type, Overwrite: true, Tier: tier,
    }));
};

export const ssmGet = async (name: string, region: string, decrypt = false): Promise<string> => {
    try {
        const r = await ssmClient(region).send(new GetParameterCommand({
            Name: name, WithDecryption: decrypt,
        }));
        return r.Parameter?.Value ?? '';
    } catch {
        return '';
    }
};

// =============================================================================
// Step runner infrastructure
// =============================================================================

export const classifyFailure = (step: string, errMsg: string): string => {
    const e = errMsg.toLowerCase();
    const s = step.toLowerCase();
    if (s.includes('ami')        || e.includes('golden'))      return 'AMI_MISMATCH';
    if (e.includes('403')        || e.includes('forbidden')
     || e.includes('accessdenied'))                             return 'S3_FORBIDDEN';
    if (s.includes('kubeadm')    || e.includes('kubeadm'))     return 'KUBEADM_FAIL';
    if (e.includes('calico')     || e.includes('tigera'))       return 'CALICO_TIMEOUT';
    if (e.includes('argocd')     || s.includes('argo'))         return 'ARGOCD_SYNC_FAIL';
    if (s.includes('cloudwatch') || s.includes('cw-agent'))     return 'CW_AGENT_FAIL';
    return 'UNKNOWN';
};

export const appendRunSummary = (record: StepRecord): void => {
    try {
        mkdirSync('/var/lib/k8s-bootstrap', { recursive: true });
        let summary: Record<string, unknown> = {};
        if (existsSync(RUN_SUMMARY_FILE)) {
            try { summary = JSON.parse(readFileSync(RUN_SUMMARY_FILE, 'utf8')); } catch { /* ignore */ }
        }
        const steps: StepRecord[] = (summary.steps as StepRecord[] | undefined) ?? [];
        steps.push(record);
        const failed = steps.filter(s => s.status === 'failed');
        writeFileSync(RUN_SUMMARY_FILE, JSON.stringify({
            updatedAt:     new Date().toISOString(),
            overallStatus: failed.length > 0 ? 'failed' : 'success',
            failureCode:   failed.length > 0 ? classifyFailure(failed[0].step, failed[0].error ?? '') : null,
            totalSteps:    steps.length,
            failedSteps:   failed.map(s => s.step),
            steps,
        }, null, 2));
    } catch (e) {
        warn(`Could not persist run_summary.json: ${e}`);
    }
};

// Factory: binds the scriptName into the SSM status payload.
// Usage: const runStep = makeRunStep('control_plane');
export const makeRunStep = (scriptName: string) =>
    async (
        name: string,
        fn: () => Promise<void>,
        cfg: BaseConfig,
        marker?: string,
    ): Promise<void> => {
        if (marker && existsSync(marker)) {
            info(`[${name}] skip — marker exists`, { marker });
            return;
        }

        const startedAt = new Date().toISOString();
        const t = Date.now();
        info(`=== Starting step: ${name} ===`);

        ssmPut(
            `${cfg.ssmPrefix}/bootstrap/status/boot/${name}`,
            JSON.stringify({ script: scriptName, step: name, status: 'running', startedAt }),
            cfg.awsRegion,
        ).catch(e => warn(`SSM status write failed for '${name}': ${e}`));

        try {
            await fn();
            const elapsedMs  = Date.now() - t;
            const finishedAt = new Date().toISOString();
            info(`Step '${name}' completed in ${elapsedMs}ms`);

            // Touch marker only if it doesn't already exist — never overwrite systemd unit files
            if (marker && !existsSync(marker)) writeFileSync(marker, '');

            ssmPut(
                `${cfg.ssmPrefix}/bootstrap/status/boot/${name}`,
                JSON.stringify({ script: scriptName, step: name, status: 'success', startedAt, finishedAt, elapsedMs }),
                cfg.awsRegion,
            ).catch(e => warn(`SSM status write failed for '${name}': ${e}`));

            appendRunSummary({ step: name, status: 'success', startedAt, finishedAt, elapsedMs });

        } catch (err) {
            const elapsedMs  = Date.now() - t;
            const finishedAt = new Date().toISOString();
            const errorMsg   = err instanceof Error ? err.message : String(err);
            error(`Step '${name}' FAILED in ${elapsedMs}ms`, { error: errorMsg });

            ssmPut(
                `${cfg.ssmPrefix}/bootstrap/status/boot/${name}`,
                JSON.stringify({
                    script: scriptName, step: name, status: 'failed',
                    startedAt, finishedAt, elapsedMs,
                    error: errorMsg.slice(0, 3000),
                }),
                cfg.awsRegion,
            ).catch(e => warn(`SSM status write failed for '${name}': ${e}`));

            appendRunSummary({ step: name, status: 'failed', startedAt, finishedAt, elapsedMs, error: errorMsg });
            throw err;
        }
    };

// =============================================================================
// Wait helpers
// =============================================================================

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export const waitUntil = async (
    check: () => boolean,
    opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> => {
    const { timeoutMs = 90_000, intervalMs = 1_000, label = 'condition' } = opts;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (check()) return;
        await sleep(intervalMs);
    }
    warn(`${label} not met after ${timeoutMs}ms — continuing`);
};

// =============================================================================
// kubeadm token validation
// =============================================================================

export const validateKubeadmToken = (token: string, source: string): string => {
    if (!token) throw new Error(`Empty kubeadm join token from ${source}`);
    const sanitised = token.trim().replace(/^\\+/, '').trim();
    if (!/^[a-z0-9]{6}\.[a-z0-9]{16}$/.test(sanitised)) {
        throw new Error(
            `Invalid kubeadm token from ${source}: '${sanitised.slice(0, 30)}' ` +
            `does not match expected format [a-z0-9]{6}.[a-z0-9]{16}`,
        );
    }
    return sanitised;
};

// =============================================================================
// ECR credential provider (baked into Golden AMI; download only as fallback)
// =============================================================================

export const ensureEcrCredentialProvider = (): void => {
    if (existsSync(ECR_PROVIDER_BIN)) {
        info(`ECR credential provider already installed at ${ECR_PROVIDER_BIN}`);
    } else {
        info(`Installing ECR credential provider ${ECR_PROVIDER_VERSION}...`);
        const archRes = run(['uname', '-m'], { check: false });
        const arch    = archRes.ok && archRes.stdout.trim() === 'aarch64' ? 'arm64' : 'amd64';
        const url     = [
            'https://storage.googleapis.com/k8s-artifacts-prod/binaries/cloud-provider-aws',
            `/${ECR_PROVIDER_VERSION}/linux/${arch}/ecr-credential-provider-linux-${arch}`,
        ].join('');
        run(['curl', '-fsSL', '-o', ECR_PROVIDER_BIN, url], { timeout: 60_000 });
        run(['chmod', '+x', ECR_PROVIDER_BIN]);
        info(`ECR credential provider installed: ${ECR_PROVIDER_BIN}`);
    }

    if (!existsSync(ECR_PROVIDER_CONFIG)) {
        mkdirSync('/etc/kubernetes', { recursive: true });
        writeFileSync(ECR_PROVIDER_CONFIG, ECR_PROVIDER_CONFIG_CONTENT);
        info(`ECR credential provider config created at ${ECR_PROVIDER_CONFIG}`);
    }
};
