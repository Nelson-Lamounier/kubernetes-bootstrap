#!/usr/bin/env npx tsx
/**
 * Sync Bootstrap Scripts to S3
 *
 * Resolves the scripts bucket from SSM Parameter Store and syncs local
 * bootstrap / deploy scripts to S3.
 *
 * Sync targets:
 *   1. k8s-bootstrap/     → s3://{bucket}/k8s-bootstrap/
 *   2. workloads/charts/nextjs/      → s3://{bucket}/app-deploy/nextjs/      (excl. chart/, nextjs-values.yaml)
 *   3. platform/charts/monitoring/   → s3://{bucket}/app-deploy/monitoring/  (excl. chart/)
 *   4. workloads/charts/start-admin/ → s3://{bucket}/app-deploy/start-admin/ (excl. chart/, start-admin-values.yaml)
 *
 * Usage:
 *   npx tsx sync-bootstrap-scripts.ts \
 *     --environment development \
 *     [--region eu-west-1]
 *
 * Environment variables (overridden by CLI flags):
 *   DEPLOY_ENVIRONMENT — environment name
 *   AWS_REGION         — AWS region (default: eu-west-1)
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error (missing bucket, missing source directory)
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parseArgs, buildAwsConfig, getSSMParameter } from '@nelson-lamounier/cdk-deploy-scripts/aws.js';
import { runCommand } from '@nelson-lamounier/cdk-deploy-scripts/exec.js';
import { writeSummary, emitAnnotation } from '@nelson-lamounier/cdk-deploy-scripts/github.js';
import logger from '@nelson-lamounier/cdk-deploy-scripts/logger.js';

// =============================================================================
// CLI argument parsing
// =============================================================================
const args = parseArgs(
    [
        {
            name: 'environment',
            description: 'Deployment environment (e.g. development, staging)',
            hasValue: true,
            default: process.env.DEPLOY_ENVIRONMENT ?? '',
        },
        {
            name: 'region',
            description: 'AWS region',
            hasValue: true,
            default: process.env.AWS_REGION ?? 'eu-west-1',
        },
        {
            name: 'profile',
            description: 'AWS named profile (local use only; omit in CI where OIDC credentials are ambient)',
            hasValue: true,
            default: process.env.AWS_PROFILE ?? '',
        },
    ],
    'Sync bootstrap and deploy scripts to S3',
);

if (!args.environment) {
    logger.fatal(
        'Missing --environment flag or DEPLOY_ENVIRONMENT env var.\n' +
        'Run with --help for usage.',
    );
}

const environment = args.environment as string;
const awsConfig = buildAwsConfig({ ...args, env: args.environment });

// AWS_PROFILE to inject into the `aws s3 sync` subprocess.
// When --profile is provided or the SDK falls back to dev-account, the CLI
// subprocess must see the same profile so it can resolve credentials.
const subprocessProfile: string | undefined =
    (args.profile as string) || (!process.env.AWS_ACCESS_KEY_ID ? 'dev-account' : undefined);

// =============================================================================
// Resolve workspace root (two levels up from this script)
// =============================================================================
const WORKSPACE_ROOT = resolve(__dirname, '..', '..', '..');

// =============================================================================
// Sync Target Definitions
// =============================================================================
interface SyncTarget {
    /** Human-readable label for logging */
    label: string;
    /** Local source directory (relative to workspace root) */
    sourceDir: string;
    /** S3 destination prefix (appended to s3://{bucket}/) */
    s3Prefix: string;
    /** Glob patterns to exclude from sync */
    excludes: string[];
    /** Whether to skip silently if source directory is missing */
    optional: boolean;
}

const SYNC_TARGETS: SyncTarget[] = [
    {
        label: 'K8s Bootstrap Scripts',
        sourceDir: 'kubernetes-app/k8s-bootstrap',
        s3Prefix: 'k8s-bootstrap/',
        excludes: [],
        optional: false,
    },
    {
        label: 'Next.js App Deploy Scripts',
        sourceDir: 'kubernetes-app/workloads/charts/nextjs',
        s3Prefix: 'app-deploy/nextjs/',
        excludes: ['chart/*', 'nextjs-values.yaml', '__pycache__/*'],
        optional: true,
    },
    {
        label: 'Monitoring Deploy Scripts',
        sourceDir: 'kubernetes-app/platform/charts/monitoring',
        s3Prefix: 'app-deploy/monitoring/',
        excludes: ['chart/*', '__pycache__/*'],
        optional: true,
    },
    {
        label: 'Start-Admin Deploy Scripts',
        sourceDir: 'kubernetes-app/workloads/charts/start-admin',
        s3Prefix: 'app-deploy/start-admin/',
        excludes: ['chart/*', 'start-admin-values.yaml', '__pycache__/*'],
        optional: true,
    },
    {
        label: 'Admin-API Deploy Scripts',
        sourceDir: 'kubernetes-app/workloads/charts/admin-api',
        s3Prefix: 'app-deploy/admin-api/',
        excludes: ['chart/*', '__pycache__/*'],
        optional: true,
    },
    {
        label: 'Public-API Deploy Scripts',
        sourceDir: 'kubernetes-app/workloads/charts/public-api',
        s3Prefix: 'app-deploy/public-api/',
        excludes: ['chart/*', '__pycache__/*'],
        optional: true,
    },
    {
        label: 'Wiki-MCP Deploy Scripts',
        sourceDir: 'kubernetes-app/workloads/charts/wiki-mcp',
        s3Prefix: 'app-deploy/wiki-mcp/',
        excludes: ['chart/*', 'wiki-mcp-values.yaml', '__pycache__/*'],
        optional: true,
    },
];

// =============================================================================
// Helpers
// =============================================================================

/**
 * Count files in a directory (non-recursive for app-deploy, recursive for bootstrap).
 */
function countFiles(dirPath: string, recursive: boolean): number {
    let count = 0;

    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
        const fullPath = join(dirPath, entry.name);
        if (entry.isFile()) {
            count++;
        } else if (entry.isDirectory() && recursive) {
            count += countFiles(fullPath, true);
        }
    }

    return count;
}

/**
 * Execute `aws s3 sync` for a single target.
 */
async function syncTarget(
    target: SyncTarget,
    bucket: string,
): Promise<{ label: string; fileCount: number; status: 'synced' | 'skipped' }> {
    const absoluteSource = resolve(WORKSPACE_ROOT, target.sourceDir);

    // Check source directory exists
    if (!existsSync(absoluteSource) || !statSync(absoluteSource).isDirectory()) {
        if (target.optional) {
            logger.info(`[SKIP] ${target.label} — source not found: ${target.sourceDir}`);
            return { label: target.label, fileCount: 0, status: 'skipped' };
        }
        logger.fatal(
            `Source directory not found: ${target.sourceDir}\n` +
            `Expected at: ${absoluteSource}`,
        );
    }

    // Count files for summary
    const isRecursive = !target.optional; // bootstrap is recursive, app-deploy is flat
    const fileCount = countFiles(absoluteSource, isRecursive);

    // Build aws s3 sync command
    const s3Destination = `s3://${bucket}/${target.s3Prefix}`;
    const syncArgs = [
        's3', 'sync',
        absoluteSource,
        s3Destination,
        '--delete',
        '--region', awsConfig.region,
    ];

    // Add exclude flags
    for (const pattern of target.excludes) {
        syncArgs.push('--exclude', pattern);
    }

    logger.info(`Syncing ${fileCount} files from ${target.sourceDir} to ${s3Destination}`);

    // Inject AWS_PROFILE into the subprocess so the `aws` CLI binary resolves
    // the same credentials as the SDK (which uses resolveAuth / fromIni).
    // In CI, AWS_ACCESS_KEY_ID is set via OIDC so subprocessProfile is undefined
    // and process.env carries the credentials automatically.
    const subprocessEnv: NodeJS.ProcessEnv | undefined = subprocessProfile
        ? { AWS_PROFILE: subprocessProfile }
        : undefined;

    const result = await runCommand('aws', syncArgs, {
        captureOutput: false, // stream the output
        env: subprocessEnv,
    });

    if (result.exitCode !== 0) {
        logger.fatal(`S3 sync failed for ${target.label} (exit code ${result.exitCode})`);
    }

    logger.success(`${target.label} synced (${fileCount} files)`);
    return { label: target.label, fileCount, status: 'synced' };
}

// =============================================================================
// Main
// =============================================================================
async function main(): Promise<void> {
    logger.header('Sync Bootstrap Scripts to S3');
    logger.keyValue('Environment', environment);
    logger.keyValue('Region', awsConfig.region);
    logger.blank();

    // ── Step 1: Resolve scripts bucket from SSM ─────────────────────────────
    const ssmParamName = `/k8s/${environment}/scripts-bucket`;
    logger.task(`Resolving scripts bucket from SSM: ${ssmParamName}`);

    const bucket = await getSSMParameter(ssmParamName, awsConfig);

    if (!bucket) {
        emitAnnotation(
            'error',
            `Scripts bucket not found at ${ssmParamName}`,
            'S3 Sync Failed',
        );
        // logger.fatal never returns (calls process.exit), but TS can't infer that
        logger.fatal(
            `Scripts bucket not found at SSM parameter: ${ssmParamName}\n` +
            'Ensure the parameter exists and has a non-empty value.',
        );
        return; // unreachable — satisfies TS control-flow analysis
    }

    logger.success(`Resolved scripts bucket: ${bucket}`);
    logger.blank();

    // ── Step 2: Sync each target ────────────────────────────────────────────
    const results: { label: string; fileCount: number; status: string }[] = [];

    for (const target of SYNC_TARGETS) {
        logger.task(`Syncing ${target.label}...`);
        const result = await syncTarget(target, bucket);
        results.push(result);
        logger.blank();
    }

    // ── Step 3: Write GitHub step summary ───────────────────────────────────
    const summaryLines: string[] = [
        '## Bootstrap Scripts S3 Sync',
        '',
        '| Target | Files | Status |',
        '|--------|-------|--------|',
    ];

    for (const r of results) {
        const icon = r.status === 'synced' ? '✅' : '⏭️';
        summaryLines.push(
            `| ${r.label} | ${r.fileCount} | ${icon} ${r.status} |`,
        );
    }

    summaryLines.push('');
    summaryLines.push(`**Bucket:** \`${bucket}\``);
    summaryLines.push(`**Environment:** ${environment}`);

    writeSummary(summaryLines.join('\n'));

    // ── Done ────────────────────────────────────────────────────────────────
    const syncedCount = results.filter((r) => r.status === 'synced').length;
    const totalFiles = results.reduce((sum, r) => sum + r.fileCount, 0);

    logger.header('Sync Complete');
    logger.success(`${syncedCount}/${results.length} targets synced, ${totalFiles} total files`);
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    emitAnnotation('error', `S3 sync failed: ${message}`, 'S3 Sync Error');
    logger.fatal(`S3 sync failed: ${message}`);
});
