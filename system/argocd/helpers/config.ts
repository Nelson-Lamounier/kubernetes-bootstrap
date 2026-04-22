// @format

/**
 * @module config
 * Bootstrap configuration for the ArgoCD bootstrap script.
 *
 * All values are sourced from environment variables with safe defaults so the
 * script can be tested locally without a live cluster.  The {@link parseArgs}
 * factory is the single entry point — callers should treat the returned
 * {@link Config} as an immutable value object for the duration of the run.
 */

/**
 * Immutable runtime configuration for the ArgoCD bootstrap.
 *
 * Populated once at startup by {@link parseArgs} and threaded through every
 * step function.  Using a plain interface (not a class) keeps the shape
 * transparent to TypeScript's structural type system and trivially serialisable
 * for dry-run inspection.
 */
export interface Config {
    /**
     * SSM Parameter Store key prefix, e.g. `/k8s/development`.
     * All bootstrap parameters and status records are stored under this prefix.
     */
    readonly ssmPrefix: string;

    /** AWS region used for SSM and Secrets Manager API calls (e.g. `"eu-west-1"`). */
    readonly awsRegion: string;

    /** Absolute path to the kubeconfig file injected into every `kubectl` invocation. */
    readonly kubeconfig: string;

    /** Absolute path to the directory containing ArgoCD YAML manifests and install files. */
    readonly argocdDir: string;

    /**
     * ArgoCD CLI version to download when the binary is absent at startup.
     * Format: `vMAJOR.MINOR.PATCH` (e.g. `"v2.14.11"`).
     */
    readonly argocdCliVersion: string;

    /**
     * Per-rollout timeout passed to `kubectl rollout status --timeout`.
     * Expressed in **seconds** — callers must append the `s` suffix when
     * constructing the CLI flag (e.g. `--timeout=${cfg.argoTimeout}s`).
     */
    readonly argoTimeout: number;

    /**
     * When `true`, every step logs its intended action and returns immediately
     * without touching any external system.  Activated by the `--dry-run` CLI flag.
     */
    readonly dryRun: boolean;

    /**
     * Short environment name derived from the last path segment of {@link ssmPrefix}.
     * Examples: `"development"`, `"staging"`, `"production"`.
     * Used as a label in log output and SSM status parameter names.
     */
    readonly env: string;
}

/**
 * Reads environment variables and the `--dry-run` CLI flag, then returns an
 * immutable {@link Config} object.
 *
 * @remarks
 * The {@link Config.env} field is derived automatically from the last segment of
 * `SSM_PREFIX` so callers never need to set it explicitly.  For example,
 * `SSM_PREFIX=/k8s/production` yields `env: "production"`.
 *
 * All fields have safe defaults suitable for local development:
 * - `SSM_PREFIX` → `/k8s/development`
 * - `AWS_REGION` → `eu-west-1`
 * - `KUBECONFIG` → `/etc/kubernetes/admin.conf`
 * - `ARGOCD_DIR` → `/data/k8s-bootstrap/system/argocd`
 * - `ARGOCD_CLI_VERSION` → `v2.14.11`
 * - `ARGO_TIMEOUT` → `300` (seconds)
 *
 * @returns Populated, immutable {@link Config}.
 *
 * @example
 * ```typescript
 * const cfg = parseArgs();
 * // SSM_PREFIX=/k8s/production AWS_REGION=eu-west-1 tsx bootstrap_argocd.ts
 * console.log(cfg.env); // "production"
 * console.log(cfg.dryRun); // false
 * ```
 */
export const parseArgs = (): Config => {
    const ssmPrefix   = process.env['SSM_PREFIX']         ?? '/k8s/development';
    const awsRegion   = process.env['AWS_REGION']         ?? 'eu-west-1';
    const kubeconfig  = process.env['KUBECONFIG']         ?? '/etc/kubernetes/admin.conf';
    const argocdDir   = process.env['ARGOCD_DIR']         ?? '/data/k8s-bootstrap/system/argocd';
    const cliVersion  = process.env['ARGOCD_CLI_VERSION'] ?? 'v2.14.11';
    const argoTimeout = parseInt(process.env['ARGO_TIMEOUT'] ?? '300', 10);
    const dryRun      = process.argv.includes('--dry-run');

    return {
        ssmPrefix,
        awsRegion,
        kubeconfig,
        argocdDir,
        argocdCliVersion: cliVersion,
        argoTimeout,
        dryRun,
        env: ssmPrefix.replace(/\/$/, '').split('/').at(-1) ?? 'development',
    };
};
