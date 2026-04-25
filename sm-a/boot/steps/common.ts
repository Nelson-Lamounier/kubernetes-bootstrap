/**
 * @format
 * @module common
 * Shared bootstrap utilities used by {@link control_plane} and {@link worker}.
 *
 * Provides three layers of abstraction:
 *
 * 1. **Logging** — structured JSON lines on `stdout` parsed by CloudWatch Logs Insights.
 * 2. **Subprocess runner** — array-form `spawnSync` wrapper that prevents shell injection.
 * 3. **Step runner** — {@link makeRunStep} factory that wraps every step with SSM status
 *    markers, timing, and idempotency via filesystem marker files.
 * 4. **Polling** — {@link poll} and {@link waitUntil} for deadline-bound async checks.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

// =============================================================================
// Types
// =============================================================================

/**
 * Result returned by every {@link run} call.
 *
 * `stdout` and `stderr` are always strings (never `null`).  When the process
 * is started with `capture: false` they will be empty strings because output
 * flows directly to the parent's file descriptors.
 */
export interface RunResult {
    /** `true` when the process exited with code 0 and no spawn error occurred. */
    readonly ok: boolean;
    /** Captured stdout string.  Empty when `capture` is `false`. */
    readonly stdout: string;
    /** Captured stderr string.  Empty when `capture` is `false`. */
    readonly stderr: string;
    /** Raw exit code, or `-1` when the process was killed / could not be spawned. */
    readonly code: number;
}

/**
 * Persisted record for a single bootstrap step, written to {@link RUN_SUMMARY_FILE}.
 *
 * The summary file accumulates one record per step so the SM-A (Bootstrap
 * Orchestrator) state machine can inspect the final outcome without streaming logs.
 */
export interface StepRecord {
    /** Step identifier, matching the name passed to {@link makeRunStep}. */
    readonly step: string;
    /** Terminal status of the step. */
    readonly status: 'success' | 'failed' | 'skipped';
    /** ISO-8601 timestamp at which the step began executing. */
    readonly startedAt: string;
    /** ISO-8601 timestamp at which the step completed (success or failure). */
    readonly finishedAt: string;
    /** Wall-clock duration in milliseconds. */
    readonly elapsedMs: number;
    /** Error message when `status` is `"failed"`. */
    readonly error?: string;
}

/**
 * Minimal config shape required by {@link makeRunStep}.
 *
 * Both `BootConfig` (control plane) and `WorkerConfig` (worker node) satisfy
 * this interface, so `makeRunStep` is generic across both bootstrap scripts.
 */
export interface BaseConfig {
    /** SSM key prefix, e.g. `/k8s/development`. */
    readonly ssmPrefix: string;
    /** AWS region for SSM API calls. */
    readonly awsRegion: string;
}

// =============================================================================
// Constants
// =============================================================================

/** Absolute path to the JSON file that accumulates per-step results. */
export const RUN_SUMMARY_FILE     = '/var/lib/k8s-bootstrap/run_summary.json';
/** Absolute path where the ECR credential provider binary must exist. */
export const ECR_PROVIDER_BIN     = '/usr/local/bin/ecr-credential-provider';
/** Absolute path to the ECR credential provider kubelet config. */
export const ECR_PROVIDER_CONFIG  = '/etc/kubernetes/image-credential-provider-config.yaml';
/** Version of the ECR credential provider to download when absent from the AMI. */
export const ECR_PROVIDER_VERSION = 'v1.31.0';

/**
 * Kubelet image credential provider config content.
 *
 * Written to {@link ECR_PROVIDER_CONFIG} when the file does not exist.
 * Instructs kubelet to delegate all ECR image pulls to the credential provider binary.
 */
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
// Logging — JSON-structured to stdout (parsed by CloudWatch Logs Insights)
// =============================================================================

/**
 * Emits a structured JSON log record to `process.stdout`.
 *
 * @param level   - Log severity: `"INFO"`, `"WARN"`, or `"ERROR"`.
 * @param message - Human-readable message.
 * @param extra   - Optional additional key/value pairs merged into the record.
 */
export const log = (level: 'INFO' | 'WARN' | 'ERROR', message: string, extra?: Record<string, unknown>): void => {
    process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...extra }) + '\n');
};

/**
 * Emits an `INFO`-level structured log record.
 *
 * @param msg   - Message string.
 * @param extra - Optional additional fields.
 */
export const info  = (msg: string, extra?: Record<string, unknown>): void => log('INFO',  msg, extra);

/**
 * Emits a `WARN`-level structured log record.
 *
 * @param msg   - Message string.
 * @param extra - Optional additional fields.
 */
export const warn  = (msg: string, extra?: Record<string, unknown>): void => log('WARN',  msg, extra);

/**
 * Emits an `ERROR`-level structured log record.
 *
 * @param msg   - Message string.
 * @param extra - Optional additional fields.
 */
export const error = (msg: string, extra?: Record<string, unknown>): void => log('ERROR', msg, extra);

// =============================================================================
// Subprocess runner — spawnSync array form, never shell string interpolation
// =============================================================================

/**
 * Runs a subprocess synchronously using the array form of `spawnSync`.
 *
 * @remarks
 * The command is always passed as a string array — never interpolated into a
 * shell command string — which prevents shell injection vulnerabilities.
 *
 * Output behaviour:
 * - `capture: false` (default) → child inherits parent `stdout`/`stderr`;
 *   output is visible in real-time but `RunResult.stdout`/`stderr` are empty.
 * - `capture: true` → stdout and stderr are captured and returned in the result.
 *
 * @param cmd  - Command and arguments (e.g. `['kubectl', 'get', 'pods', '-n', 'argocd']`).
 * @param opts - Execution options.
 * @param opts.env     - Additional environment variables merged with `process.env`.
 * @param opts.input   - Optional stdin data (string or Buffer).
 * @param opts.check   - When `true` (default), throws `Error` on non-zero exit.
 * @param opts.timeout - Subprocess timeout in milliseconds. Defaults to `300_000` (5 min).
 * @param opts.capture - When `true`, captures stdout/stderr. Defaults to `true`.
 * @returns {@link RunResult}.
 * @throws {Error} When `check` is `true` and the process exits non-zero.
 *
 * @example
 * ```typescript
 * const r = run(['kubectl', 'get', 'nodes', '--no-headers'], { capture: true, check: false });
 * if (r.ok) info(`Nodes:\n${r.stdout}`);
 * ```
 */
export const run = (
    cmd: string[],
    opts: {
        env?: Record<string, string>;
        input?: string | Buffer;
        check?: boolean;
        timeout?: number;
        capture?: boolean;
        /** Suppress ERROR-level stderr log when ok=false (for probe commands). */
        quiet?: boolean;
    } = {},
): RunResult => {
    const { env, input, check = true, timeout = 300_000, capture = true, quiet = false } = opts;
    const mergedEnv = env ? { ...process.env, ...env } as NodeJS.ProcessEnv : process.env;

    info(`Running: ${cmd.join(' ')}`);
    const t = Date.now();

    // Convert string input to Buffer so spawnSync's encoding:'buffer' (output
    // encoding) doesn't also try to encode the stdin via Buffer.from(str,'buffer'),
    // which throws "Unknown encoding: buffer".
    const stdinInput = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;

    const result = spawnSync(cmd[0]!, cmd.slice(1), {
        env: mergedEnv,
        input: stdinInput,
        timeout,
        encoding: 'buffer',
        stdio: capture ? 'pipe' : ['pipe', 'inherit', 'inherit'],
    });

    const stdout = result.stdout ? result.stdout.toString('utf8') : '';
    const stderr = result.stderr ? result.stderr.toString('utf8') : '';
    const code   = result.status ?? -1;
    const ok     = code === 0;

    info('Command finished', { durationMs: Date.now() - t, ok });
    if (!ok && stderr && !quiet) error('Command stderr', { command: cmd[0], stderr: stderr.slice(0, 500) });
    if (!ok && check) throw new Error(`Command failed (exit ${code}): ${cmd.join(' ')}\n${stderr.slice(0, 1000)}`);

    return { ok, stdout, stderr, code };
};

// =============================================================================
// IMDS v2
// =============================================================================

/**
 * Fetches a value from the EC2 Instance Metadata Service (IMDSv2).
 *
 * @remarks
 * Uses the two-step IMDSv2 protocol:
 * 1. PUT to `/latest/api/token` to obtain a session token (TTL 6 h).
 * 2. GET the requested metadata path with the session token header.
 *
 * Returns an empty string on any failure — callers should treat an empty
 * return as "metadata unavailable" and handle accordingly.
 *
 * @param path - Metadata path relative to `/latest/meta-data/`
 *               (e.g. `"instance-id"`, `"local-ipv4"`, `"placement/availability-zone"`).
 * @returns The raw metadata string, or `""` on failure.
 *
 * @example
 * ```typescript
 * const instanceId = imds('instance-id');
 * if (!instanceId) throw new Error('Cannot read instance-id from IMDS');
 * ```
 */
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
// AWS SDK SSM client — lazy-initialised once per process
// =============================================================================

/**
 * Module-level SSM client singleton.
 * Lazy-initialised on first call to {@link ssmClient}.
 */
let _ssm: SSMClient | undefined;

/**
 * Returns the cached {@link SSMClient}, creating it on first access.
 *
 * @remarks
 * A single client is reused for the process lifetime so TLS connections are
 * not re-established on every SSM API call.
 *
 * @param region - AWS region string (e.g. `"eu-west-1"`).
 * @returns The cached `SSMClient` instance.
 */
export const ssmClient = (region: string): SSMClient => (_ssm ??= new SSMClient({ region }));

/**
 * Writes or overwrites a parameter in SSM Parameter Store.
 *
 * @param name   - Full parameter name (e.g. `/k8s/development/join-token`).
 * @param value  - String value to store.
 * @param region - AWS region for the SSM client.
 * @param type   - Parameter type. Defaults to `"String"`.
 * @param tier   - SSM storage tier. Omit for Standard (default).
 * @throws {Error} On AWS API errors (network, permissions, etc.).
 */
export const ssmPut = async (
    name: string,
    value: string,
    region: string,
    type: 'String' | 'SecureString' = 'String',
    tier?: 'Standard' | 'Advanced',
): Promise<void> => {
    await ssmClient(region).send(new PutParameterCommand({
        Name: name, Value: value, Type: type, Overwrite: true,
        ...(tier !== undefined && { Tier: tier }),
    }));
};

/**
 * Reads a parameter from SSM Parameter Store.
 *
 * @param name    - Full parameter name.
 * @param region  - AWS region for the SSM client.
 * @param decrypt - When `true`, decrypts `SecureString` parameters. Defaults to `false`.
 * @returns The parameter value, or `""` if the parameter does not exist or the request fails.
 *
 * @example
 * ```typescript
 * const endpoint = await ssmGet('/k8s/dev/control-plane-endpoint', 'eu-west-1');
 * if (!endpoint) throw new Error('Endpoint not in SSM');
 * ```
 */
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

/**
 * Classifies a step failure into a short error code for the run summary.
 *
 * @remarks
 * The classification is keyword-based: both the step name and the error message
 * are checked (lowercased) against known failure signatures.  The first match
 * wins.  Used by {@link appendRunSummary} to populate `failureCode` in the
 * summary JSON so downstream tooling can filter without parsing log lines.
 *
 * @param step   - Step identifier (e.g. `"install-calico"`).
 * @param errMsg - Error message string from the thrown `Error`.
 * @returns A short all-caps error code, or `"UNKNOWN"` when no pattern matches.
 */
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

/**
 * Appends a {@link StepRecord} to the JSON run summary file at {@link RUN_SUMMARY_FILE}.
 *
 * @remarks
 * The file accumulates step records across the run.  On each call the file is
 * read, the new record appended, and the file rewritten atomically.
 * Failures are non-fatal (a warning is logged) so a filesystem issue cannot
 * prevent the bootstrap from completing.
 *
 * The `overallStatus` field reflects the aggregate: `"failed"` as soon as any
 * step fails; `"success"` if all steps have succeeded so far.
 *
 * @param record - The completed step record to append.
 */
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
            failureCode:   failed.length > 0 ? classifyFailure(failed[0]!.step, failed[0]!.error ?? '') : null,
            totalSteps:    steps.length,
            failedSteps:   failed.map(s => s.step),
            steps,
        }, null, 2));
    } catch (e) {
        warn(`Could not persist run_summary.json: ${e}`);
    }
};

/**
 * Factory that returns a `runStep` function bound to a specific script name.
 *
 * @remarks
 * The returned function wraps an async step with:
 * - **Idempotency**: skips execution when a filesystem marker file exists.
 * - **SSM status**: writes `running` / `success` / `failed` to
 *   `{ssmPrefix}/bootstrap/status/boot/{name}` (fire-and-forget, non-fatal).
 * - **Run summary**: appends a {@link StepRecord} to {@link RUN_SUMMARY_FILE}.
 * - **Marker creation**: touches the marker file on success (never overwrites
 *   an existing file so systemd unit files are preserved).
 *
 * @param scriptName - Short identifier embedded in SSM status payloads
 *                     (e.g. `"control_plane"`, `"worker"`).
 * @returns An async `runStep(name, fn, cfg, marker?)` function.
 *
 * @example
 * ```typescript
 * const runStep = makeRunStep('control_plane');
 * await runStep('install-calico', () => installCalico(cfg), cfg, CALICO_MARKER);
 * ```
 */
export const makeRunStep = (scriptName: string) =>
    /**
     * Executes a single bootstrap step with SSM status tracking and idempotency.
     *
     * @param name   - Unique step name used in logs, SSM paths, and the run summary.
     * @param fn     - Async step implementation.
     * @param cfg    - Config supplying `ssmPrefix` and `awsRegion`.
     * @param marker - Optional filesystem path.  When the path exists the step is
     *                 skipped; when absent it is touched on success.
     * @throws Re-throws any error from `fn` after recording failure in SSM and the summary.
     */
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

            // Touch marker only if absent — never overwrite systemd unit files
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
// Wait / polling helpers
// =============================================================================

/**
 * Suspends execution for the specified number of milliseconds.
 *
 * @param ms - Sleep duration in milliseconds.
 *
 * @example
 * ```typescript
 * warn('Retrying in 30s...');
 * await sleep(30_000);
 * ```
 */
export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/**
 * Polls an async probe function until it returns a non-null/undefined value
 * or the wall-clock deadline expires.
 *
 * @remarks
 * This is the single polling primitive used throughout both bootstrap scripts.
 * All three previously duplicated polling loops (`resolveControlPlaneEndpoint`,
 * `waitForApiServerReachable`, `waitForKubelet`) are built on this function.
 *
 * The probe function signals "not yet ready" by returning `null` or `undefined`.
 * Any other value (including `false`) is treated as a valid resolved result and
 * terminates the loop.
 *
 * The interval can be a fixed number or a function of the attempt index, which
 * enables exponential back-off:
 * ```typescript
 * intervalMs: (attempt) => Math.min(1_000 * 2 ** attempt, 30_000)
 * ```
 *
 * @template T - Type of the resolved value returned by `fn`.
 * @param fn   - Async probe. Return `null` / `undefined` to signal "not ready".
 * @param opts - Polling options.
 * @param opts.timeoutMs       - Total deadline in milliseconds.
 * @param opts.intervalMs      - Fixed delay between probes (ms), or a function
 *                               `(attempt: number) => number` for back-off strategies.
 * @param opts.label           - Human-readable label used in log and error messages.
 * @param opts.throwOnTimeout  - When `true`, throws on deadline expiry.
 *                               When `false` (default), warns and returns `null`.
 * @returns The first non-null value returned by `fn`, or `null` on timeout when
 *          `throwOnTimeout` is `false`.
 * @throws {Error} When `throwOnTimeout` is `true` and the deadline expires.
 *
 * @example
 * ```typescript
 * // Wait up to 5 minutes for an SSM parameter to appear
 * const endpoint = await poll(
 *   () => ssmGet('/k8s/dev/cp-endpoint', 'eu-west-1').then(v => v || null),
 *   { timeoutMs: 300_000, intervalMs: 10_000, label: 'control-plane-endpoint', throwOnTimeout: true },
 * );
 * ```
 *
 * @example
 * ```typescript
 * // Exponential back-off (1s, 2s, 4s, … capped at 30s)
 * await poll(fn, {
 *   timeoutMs: 300_000,
 *   intervalMs: (attempt) => Math.min(1_000 * 2 ** attempt, 30_000),
 *   label: 'kubeadm join',
 * });
 * ```
 */
export const poll = async <T>(
    fn: () => Promise<T | null | undefined>,
    opts: {
        timeoutMs: number;
        intervalMs: number | ((attempt: number) => number);
        label: string;
        throwOnTimeout?: boolean;
    },
): Promise<T | null> => {
    const { timeoutMs, intervalMs, label, throwOnTimeout = false } = opts;
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;

    while (Date.now() < deadline) {
        const result = await fn();
        if (result != null) return result;
        const delay = typeof intervalMs === 'function' ? intervalMs(attempt) : intervalMs;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await sleep(Math.min(delay, remaining));
        attempt++;
    }

    if (throwOnTimeout) {
        throw new Error(`${label} not satisfied after ${timeoutMs / 1000}s`);
    }
    warn(`${label} not met after ${timeoutMs / 1000}s — continuing`);
    return null;
};

/**
 * Polls a synchronous boolean predicate until it returns `true` or the deadline
 * expires.
 *
 * @remarks
 * Thin wrapper over {@link poll} for callers that have a synchronous check.
 * On deadline expiry a warning is logged and the function returns without throwing.
 *
 * @param check - Synchronous predicate.  Called repeatedly until it returns `true`.
 * @param opts  - Polling options.
 * @param opts.timeoutMs  - Total deadline in milliseconds. Defaults to `90_000`.
 * @param opts.intervalMs - Delay between checks in milliseconds. Defaults to `1_000`.
 * @param opts.label      - Label for the timeout warning. Defaults to `"condition"`.
 *
 * @example
 * ```typescript
 * await waitUntil(
 *   () => run(['kubectl', 'get', '--raw', '/healthz'], { check: false }).stdout.includes('ok'),
 *   { timeoutMs: 90_000, label: 'API server /healthz' },
 * );
 * ```
 */
export const waitUntil = async (
    check: () => boolean,
    opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> => {
    const { timeoutMs = 90_000, intervalMs = 1_000, label = 'condition' } = opts;
    await poll(
        () => Promise.resolve(check() ? (true as const) : null),
        { timeoutMs, intervalMs, label, throwOnTimeout: false },
    );
};

// =============================================================================
// kubeadm token validation
// =============================================================================

/**
 * Validates a raw kubeadm join token string against the expected format.
 *
 * @remarks
 * The kubeadm token format is `[a-z0-9]{6}.[a-z0-9]{16}`.
 * Leading backslashes introduced by shell escaping are stripped before
 * validation — this is a known issue with tokens captured via `spawnSync`
 * from some shell wrappers.
 *
 * @param token  - Raw token string to validate.
 * @param source - Human-readable source label used in the error message
 *                 (e.g. `"SSM"`, `"KUBEADM_JOIN_TOKEN env var"`).
 * @returns The sanitised, validated token string.
 * @throws {Error} When the token is empty or does not match the expected format.
 *
 * @example
 * ```typescript
 * const token = validateKubeadmToken(rawToken, 'SSM');
 * run(['kubeadm', 'join', endpoint, '--token', token, ...]);
 * ```
 */
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

/**
 * Ensures the ECR credential provider binary and config are present on disk.
 *
 * @remarks
 * The binary should be pre-baked into the Golden AMI at {@link ECR_PROVIDER_BIN}.
 * This function downloads it from the upstream release bucket only as a fallback
 * (e.g. during development against a non-production AMI).
 *
 * The kubelet config at {@link ECR_PROVIDER_CONFIG} is always written if absent —
 * it is a static file that does not change between runs.
 *
 * @throws {Error} When the download or `chmod` command fails.
 */
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
