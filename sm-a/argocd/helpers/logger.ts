// @format

/**
 * @module logger
 * Structured JSON logger with SSM step-status markers for the ArgoCD bootstrap.
 *
 * Each step is wrapped by {@link BootstrapLogger.step}, which:
 * 1. Emits structured JSON lines to `stdout` (consumed by CloudWatch Logs Insights).
 * 2. Writes a status record to SSM Parameter Store so the Step Functions state
 *    machine (SM-B) can observe bootstrap progress without tailing logs.
 *
 * The SSM client is a **lazy singleton** — created on first use and reused for
 * all subsequent writes, avoiding repeated TLS handshake overhead.
 */

import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

// =============================================================================
// Internal helpers
// =============================================================================

/** Returns the current UTC timestamp as an ISO-8601 string. */
const ts = (): string => new Date().toISOString();

/**
 * Module-level SSM client singleton.
 * Initialised on first {@link writeStatus} call; reused thereafter.
 */
let _ssmClient: SSMClient | undefined;

/**
 * Returns the cached {@link SSMClient}, creating it on first access.
 *
 * @param region - AWS region string (e.g. `"eu-west-1"`).
 */
const getSsmClient = (region: string): SSMClient =>
    (_ssmClient ??= new SSMClient({ region }));

/**
 * Emits a structured JSON log event to `process.stdout`.
 *
 * @param step   - Step identifier used as the `step` field in the log record.
 * @param level  - Severity string (e.g. `"info"`, `"error"`).
 * @param status - Lifecycle marker (`"start"` | `"success"` | `"fail"` | `"skip"`).
 * @param extra  - Optional additional fields merged into the record.
 */
const emit = (
    step: string,
    level: string,
    status: string,
    extra?: Record<string, unknown>,
): void => {
    const event: Record<string, unknown> = { ts: ts(), step, level, status, ...extra };
    process.stdout.write(JSON.stringify(event) + '\n');
};

/**
 * Writes a step status record to SSM Parameter Store.
 *
 * @remarks
 * Failures are **non-fatal**: a warning is logged and execution continues.
 * The parameter path follows the convention:
 * `{ssmPrefix}/bootstrap/status/argocd/{step}`.
 *
 * Error messages are capped at 3 000 characters to stay within SSM's 8 KB
 * parameter value limit.
 *
 * @param ssmPrefix - SSM key prefix (e.g. `/k8s/development`). Skipped when `null`.
 * @param awsRegion - AWS region for the SSM client. Skipped when `null`.
 * @param step      - Step identifier matching the value passed to {@link emit}.
 * @param status    - Status string written to the SSM record.
 * @param extra     - Optional elapsed time and truncated error message.
 */
const writeStatus = async (
    ssmPrefix: string | null,
    awsRegion: string | null,
    step: string,
    status: string,
    extra?: { elapsed_s?: number; error?: string },
): Promise<void> => {
    if (!ssmPrefix || !awsRegion) return;

    const paramName = `${ssmPrefix}/bootstrap/status/argocd/${step}`;
    const payload: Record<string, unknown> = {
        script: 'bootstrap_argocd',
        step,
        status,
        updated_at: ts(),
        ...extra,
    };
    if (extra?.error) payload['error'] = extra.error.slice(0, 3_000);

    try {
        await getSsmClient(awsRegion).send(new PutParameterCommand({
            Name: paramName,
            Value: JSON.stringify(payload),
            Type: 'String',
            Overwrite: true,
        }));
    } catch (err) {
        process.stdout.write(JSON.stringify({
            ts: ts(), level: 'warn', step,
            msg: `SSM step-status write failed (non-fatal): ${err}`,
        }) + '\n');
    }
};

// =============================================================================
// BootstrapLogger
// =============================================================================

/**
 * Structured logger for the ArgoCD bootstrap pipeline.
 *
 * @remarks
 * Instantiate once in the orchestrator and pass the instance (or individual
 * methods) to step functions.  Providing `null` for `ssmPrefix` or `awsRegion`
 * disables SSM writes, which is useful for dry-run or local development.
 *
 * All log output is newline-delimited JSON on `stdout` so CloudWatch Logs
 * Insights can query it with `fields @timestamp, step, status, duration_ms`.
 *
 * @example
 * ```typescript
 * const logger = new BootstrapLogger('/k8s/development', 'eu-west-1');
 *
 * const deployKey = await logger.step('resolve-deploy-key', () => resolveDeployKey(cfg));
 * logger.skip('create-ci-bot', 'ArgoCD CLI not available');
 * ```
 */
export class BootstrapLogger {
    /**
     * @param ssmPrefix - SSM key prefix for status writes, or `null` to disable SSM.
     * @param awsRegion - AWS region for the SSM client, or `null` to disable SSM.
     */
    constructor(
        private readonly ssmPrefix: string | null,
        private readonly awsRegion: string | null,
    ) {}

    /**
     * Executes a bootstrap step, emitting structured logs and SSM status markers
     * for the step's full lifecycle (start → success | fail).
     *
     * @remarks
     * Lifecycle events emitted to `stdout`:
     * - `{ status: "start" }` — before `fn` is called.
     * - `{ status: "success", duration_ms }` — on successful resolution.
     * - `{ status: "fail", msg, duration_ms }` — on rejection; then re-throws.
     *
     * The generic type parameter `T` allows step return values to be threaded
     * through the orchestrator without unsafe casts.  For example, a step that
     * resolves an SSH deploy key can return `string` and the caller receives it:
     * ```typescript
     * const key: string = await logger.step('resolve-key', () => resolveDeployKey(cfg));
     * ```
     *
     * @template T - Return type of the step function.
     * @param name - Unique step identifier used in log output and SSM paths.
     * @param fn   - Zero-argument factory that performs the step's work.
     *               May be synchronous or async; the return value is forwarded.
     * @returns The resolved value of `fn`.
     * @throws Re-throws any error from `fn` after recording it.
     *
     * @example
     * ```typescript
     * const signingKey = await logger.step(
     *   'preserve-argocd-secret',
     *   () => preserveArgocdSecret(cfg),
     * );
     * // signingKey is string | null — forwarded transparently
     * ```
     */
    async step<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
        const start = Date.now();
        emit(name, 'info', 'start');
        await writeStatus(this.ssmPrefix, this.awsRegion, name, 'running');
        try {
            const result = await fn();
            const elapsedMs = Date.now() - start;
            emit(name, 'info', 'success', { duration_ms: elapsedMs });
            await writeStatus(this.ssmPrefix, this.awsRegion, name, 'success', {
                elapsed_s: elapsedMs / 1000,
            });
            return result;
        } catch (err) {
            const elapsedMs = Date.now() - start;
            const msg = err instanceof Error ? err.message : String(err);
            emit(name, 'error', 'fail', { msg, duration_ms: elapsedMs });
            await writeStatus(this.ssmPrefix, this.awsRegion, name, 'failed', {
                elapsed_s: elapsedMs / 1000,
                error: msg,
            });
            throw err;
        }
    }

    /**
     * Records a skipped step without executing any function.
     *
     * @remarks
     * Used when a conditional gate prevents a step from running (e.g. the
     * ArgoCD CLI binary was not installed).  Writes `"skipped"` to SSM so the
     * state machine can distinguish intentional skips from missing step records.
     *
     * The SSM write is fire-and-forget — errors are silently discarded.
     *
     * @param name - Step identifier.
     * @param msg  - Human-readable reason, included in the `stdout` log record.
     *
     * @example
     * ```typescript
     * if (!cliInstalled) {
     *   logger.skip('generate-ci-token', 'ArgoCD CLI not available');
     * }
     * ```
     */
    skip(name: string, msg: string): void {
        emit(name, 'info', 'skip', { msg });
        writeStatus(this.ssmPrefix, this.awsRegion, name, 'skipped').catch(() => {});
    }
}
