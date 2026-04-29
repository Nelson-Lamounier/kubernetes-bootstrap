// @format

/**
 * @module runner
 * Shared runtime helpers: subprocess runner, AWS client factories, SSM /
 * Secrets Manager accessors, and `sleep`.
 *
 * Design decisions:
 * - AWS SDK clients are **lazy singletons** at module level.  One client per
 *   service per process avoids repeated TLS handshake overhead on every API call.
 * - All subprocess invocations use the **array form** of `spawnSync` — never a
 *   shell-interpolated string — which prevents shell injection vulnerabilities.
 * - `KUBECONFIG` and `HOME` are always injected via {@link buildEnv} so the
 *   caller never has to remember to set them.
 */

import { spawnSync } from 'node:child_process';
import {
    GetParameterCommand,
    PutParameterCommand,
    SSMClient,
} from '@aws-sdk/client-ssm';
import {
    CreateSecretCommand,
    GetSecretValueCommand,
    SecretsManagerClient,
    UpdateSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import type { Config } from './config.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Result returned by every {@link run} and {@link kubectlApplyStdin} call.
 *
 * `stdout` and `stderr` are always strings — never `null` — and are trimmed of
 * leading/trailing whitespace.  When `capture` is `false` the subprocess inherits
 * the parent's stdio and both fields will be empty strings.
 */
export interface RunResult {
    /** `true` when the process exited with code 0 and produced no spawn error. */
    readonly ok: boolean;
    /** Captured stdout, trimmed.  Empty string when `capture` is `false`. */
    readonly stdout: string;
    /** Captured stderr, trimmed.  Empty string when `capture` is `false`. */
    readonly stderr: string;
    /** Raw exit code.  `1` when the process was killed or could not be spawned. */
    readonly code: number;
}

// =============================================================================
// AWS client singletons
// =============================================================================

/**
 * Module-level SSM client singleton.
 * Initialised on first call to the internal accessor.
 */
let _ssmClient: SSMClient | undefined;

/**
 * Module-level Secrets Manager client singleton.
 * Initialised on first call to the internal accessor.
 */
let _secretsClient: SecretsManagerClient | undefined;

/**
 * Returns the cached {@link SSMClient}, creating it on first access.
 *
 * @param region - AWS region string (e.g. `"eu-west-1"`).
 */
const getSsmClient = (region: string): SSMClient =>
    (_ssmClient ??= new SSMClient({ region }));

/**
 * Returns the cached {@link SecretsManagerClient}, creating it on first access.
 *
 * @param region - AWS region string (e.g. `"eu-west-1"`).
 */
const getSecretsClient = (region: string): SecretsManagerClient =>
    (_secretsClient ??= new SecretsManagerClient({ region }));

// =============================================================================
// Logging
// =============================================================================

/**
 * Writes `msg` followed by a newline to `process.stdout`.
 *
 * @remarks
 * Uses `process.stdout.write` directly rather than `console.log` to avoid
 * buffering and ensure synchronous output — critical when a step throws and
 * the process exits shortly after.
 *
 * @param msg - Message string to emit.
 */
export const log = (msg: string): void => {
    process.stdout.write(msg + '\n');
};

// =============================================================================
// Subprocess environment
// =============================================================================

/**
 * Builds the subprocess environment by merging `process.env` with
 * `KUBECONFIG` and `HOME` overrides sourced from the bootstrap config.
 *
 * @remarks
 * Centralising this prevents the env-construction block from being
 * duplicated between {@link run} and {@link kubectlApplyStdin}.
 *
 * @param cfg - Bootstrap config supplying `kubeconfig`.
 * @returns A plain `Record<string, string>` safe to pass to `spawnSync`.
 */
const buildEnv = (cfg: Config): Record<string, string> => ({
    ...process.env as Record<string, string>,
    KUBECONFIG: cfg.kubeconfig,
    HOME: process.env['HOME'] ?? '/root',
});

// =============================================================================
// Subprocess runner
// =============================================================================

/**
 * Runs a subprocess synchronously using the array form of `spawnSync`.
 *
 * @remarks
 * The command is passed as a string array — never interpolated into a shell
 * command string — which prevents shell injection.
 *
 * **Dry-run mode**: when `cfg.dryRun` is `true` the command is logged and a
 * synthetic `{ ok: true }` result is returned without executing anything.
 *
 * **Output capture**:
 * - `capture: false` (default) → child inherits parent `stdout`/`stderr`;
 *   output is visible in real-time but `RunResult.stdout`/`stderr` are `""`.
 * - `capture: true` → output is captured and available in `RunResult`.
 *
 * @param cmd  - Command and argument array (e.g. `['kubectl', 'get', 'pods', '-n', 'argocd']`).
 * @param cfg  - Bootstrap config supplying `kubeconfig`, `HOME`, and `dryRun`.
 * @param opts - Execution options.
 * @param opts.check   - When `true` (default), throws `Error` on non-zero exit.
 *                       Set `false` to inspect failures manually via `result.ok`.
 * @param opts.capture - When `true`, captures stdout/stderr instead of inheriting.
 *                       Defaults to `false`.
 * @returns {@link RunResult}.
 * @throws {Error} When `check` is `true` and the process exits non-zero.
 *
 * @example
 * ```typescript
 * const r = run(['kubectl', 'get', 'pods', '-n', 'argocd'], cfg, { check: false, capture: true });
 * if (r.ok) log(`Pods:\n${r.stdout}`);
 * ```
 */
export const run = (
    cmd: string[],
    cfg: Config,
    opts: { check?: boolean; capture?: boolean } = {},
): RunResult => {
    const { check = true, capture = false } = opts;

    if (cfg.dryRun) {
        log(`  [DRY-RUN] ${cmd.join(' ')}`);
        return { ok: true, stdout: '', stderr: '', code: 0 };
    }

    const result = spawnSync(cmd[0]!, cmd.slice(1), {
        env: buildEnv(cfg),
        encoding: 'utf-8',
        stdio: capture ? 'pipe' : 'inherit',
    });

    const ok = result.status === 0 && result.error == null;

    if (check && !ok) {
        const detail = result.error?.message ?? result.stderr ?? '';
        throw new Error(`Command failed: ${cmd.join(' ')}\n${detail}`);
    }

    return {
        ok,
        stdout: ((result.stdout as string | null) ?? '').trim(),
        stderr: ((result.stderr as string | null) ?? '').trim(),
        code: result.status ?? 1,
    };
};

/**
 * Runs `kubectl apply -f -` with `yaml` piped to stdin.
 *
 * @remarks
 * Piping via stdin avoids writing a temporary file, eliminating cleanup
 * requirements and TOCTOU races.
 *
 * Use `stringData` fields in Secret manifests so the API server handles
 * base64 encoding.  Use `data` fields only when the value is already
 * base64-encoded (e.g. JWT signing keys preserved from jsonpath output).
 *
 * @param yaml - YAML manifest string to pipe to `kubectl apply`.
 * @param cfg  - Bootstrap config supplying `kubeconfig` and `dryRun`.
 * @param opts - Execution options.
 * @param opts.check - When `true` (default), throws on non-zero exit.
 * @returns {@link RunResult}.
 * @throws {Error} When `check` is `true` and `kubectl apply` exits non-zero.
 *
 * @example
 * ```typescript
 * const r = kubectlApplyStdin(secretYaml, cfg, { check: false });
 * if (!r.ok) log(`  ⚠ Apply failed: ${r.stderr}`);
 * ```
 */
export const kubectlApplyStdin = (
    yaml: string,
    cfg: Config,
    opts: { check?: boolean } = {},
): RunResult => {
    const { check = true } = opts;

    if (cfg.dryRun) {
        log(`  [DRY-RUN] kubectl apply -f - (${yaml.split('\n').length} lines)`);
        return { ok: true, stdout: '', stderr: '', code: 0 };
    }

    const result = spawnSync('kubectl', ['apply', '-f', '-'], {
        env: buildEnv(cfg),
        encoding: 'utf-8',
        input: yaml,
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    const ok = result.status === 0 && result.error == null;
    if (check && !ok) {
        throw new Error(`kubectl apply failed:\n${result.stderr ?? ''}`);
    }
    return {
        ok,
        stdout: ((result.stdout as string | null) ?? '').trim(),
        stderr: ((result.stderr as string | null) ?? '').trim(),
        code: result.status ?? 1,
    };
};

// =============================================================================
// SSM helpers
// =============================================================================

/**
 * Reads a parameter from SSM Parameter Store.
 *
 * @param cfg     - Bootstrap config supplying `awsRegion`.
 * @param name    - Full parameter name (e.g. `/k8s/development/deploy-key`).
 * @param decrypt - When `true`, decrypts `SecureString` parameters. Defaults to `false`.
 * @returns The parameter value string, or `null` if the parameter does not
 *          exist or the request fails for any reason.
 *
 * @example
 * ```typescript
 * const password = await ssmGet(cfg, '/k8s/dev/admin-password', true);
 * if (!password) throw new Error('Admin password not found in SSM');
 * ```
 */
export const ssmGet = async (
    cfg: Config,
    name: string,
    decrypt = false,
): Promise<string | null> => {
    try {
        const res = await getSsmClient(cfg.awsRegion).send(
            new GetParameterCommand({ Name: name, WithDecryption: decrypt }),
        );
        return res.Parameter?.Value ?? null;
    } catch {
        return null;
    }
};

/**
 * Writes or overwrites a parameter in SSM Parameter Store.
 *
 * @remarks
 * `description` and `tier` are only included in the API request when
 * explicitly provided — passing `undefined` does not send the field.
 *
 * @param cfg   - Bootstrap config supplying `awsRegion`.
 * @param name  - Full parameter name.
 * @param value - String value to store.
 * @param opts  - Optional write settings.
 * @param opts.type        - Parameter type. Defaults to `"String"`.
 * @param opts.overwrite   - Whether to overwrite an existing value. Defaults to `true`.
 * @param opts.description - Human-readable description stored with the parameter.
 * @param opts.tier        - SSM storage tier. Omitted from the request when not set.
 * @throws {Error} On AWS API errors (network failure, permission denied, etc.).
 *
 * @example
 * ```typescript
 * await ssmPut(cfg, '/k8s/dev/ci-token', token, {
 *   type: 'SecureString',
 *   description: 'ArgoCD CI bot API token',
 * });
 * ```
 */
export const ssmPut = async (
    cfg: Config,
    name: string,
    value: string,
    opts: {
        type?: 'String' | 'SecureString';
        overwrite?: boolean;
        description?: string;
        tier?: 'Standard' | 'Advanced';
    } = {},
): Promise<void> => {
    const { type = 'String', overwrite = true, description, tier } = opts;
    await getSsmClient(cfg.awsRegion).send(new PutParameterCommand({
        Name: name,
        Value: value,
        Type: type,
        Overwrite: overwrite,
        ...(description !== undefined && { Description: description }),
        ...(tier        !== undefined && { Tier: tier }),
    }));
};

// =============================================================================
// Secrets Manager helpers
// =============================================================================

/**
 * Retrieves a secret string from AWS Secrets Manager.
 *
 * @param cfg      - Bootstrap config supplying `awsRegion`.
 * @param secretId - Secret name or full ARN.
 * @returns The `SecretString` value, or `null` if the secret does not exist
 *          or the request fails.
 */
export const secretsManagerGet = async (
    cfg: Config,
    secretId: string,
): Promise<string | null> => {
    try {
        const res = await getSecretsClient(cfg.awsRegion).send(
            new GetSecretValueCommand({ SecretId: secretId }),
        );
        return res.SecretString ?? null;
    } catch {
        return null;
    }
};

/**
 * Creates or updates a secret in AWS Secrets Manager.
 *
 * @remarks
 * Uses an optimistic-create strategy: attempts {@link CreateSecretCommand}
 * first, then falls back to {@link UpdateSecretCommand} on
 * `ResourceExistsException`.  All other errors are re-thrown.
 *
 * The description is only sent on create — the update path leaves the existing
 * description unchanged to avoid accidental overwrites.
 *
 * @param cfg         - Bootstrap config supplying `awsRegion`.
 * @param name        - Secret name (e.g. `k8s/development/argocd-ci-token`).
 * @param value       - Plain-text secret value to store.
 * @param description - Optional description included on first create only.
 * @returns `"created"` when the secret was new; `"updated"` when it already existed.
 * @throws {Error} On unexpected AWS errors.
 *
 * @example
 * ```typescript
 * const action = await secretsManagerPut(cfg, 'k8s/dev/argocd-ci-token', token, 'CI bot token');
 * log(`  ✓ CI token ${action} in Secrets Manager`);
 * ```
 */
export const secretsManagerPut = async (
    cfg: Config,
    name: string,
    value: string,
    description?: string,
): Promise<'created' | 'updated'> => {
    const client = getSecretsClient(cfg.awsRegion);
    try {
        await client.send(new CreateSecretCommand({
            Name: name,
            SecretString: value,
            ...(description !== undefined && { Description: description }),
        }));
        return 'created';
    } catch (err: unknown) {
        const code = (err as { name?: string }).name;
        if (code === 'ResourceExistsException') {
            await client.send(new UpdateSecretCommand({ SecretId: name, SecretString: value }));
            return 'updated';
        }
        throw err;
    }
};

// =============================================================================
// Utilities
// =============================================================================

/**
 * Returns a `Promise` that resolves after `ms` milliseconds.
 *
 * @param ms - Sleep duration in milliseconds.
 *
 * @example
 * ```typescript
 * log('  Retrying in 30s...');
 * await sleep(30_000);
 * ```
 */
export const sleep = (ms: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, ms));

/**
 * Returns `true` when the cluster has at least one non-control-plane node.
 *
 * Used to gate any step that triggers a rolling restart of an ArgoCD workload:
 * on a control-plane-only cluster all argocd-* pods stay `Pending`, so a
 * `kubectl rollout status` will block until SSM kills the bootstrap (exit 143).
 * Skipping the synchronous wait is safe — the underlying ConfigMap patch is
 * already applied; ArgoCD reconciliation will pick it up when workers join.
 */
export const hasSchedulableWorkers = (cfg: Config): boolean => {
    const result = run(
        ['kubectl', 'get', 'nodes', '-l', '!node-role.kubernetes.io/control-plane', '-o', 'name'],
        cfg,
        { check: false, capture: true },
    );
    return result.ok && result.stdout.split('\n').filter(l => l.trim() !== '').length > 0;
};
