#!/usr/bin/env npx tsx
/**
 * Sync Bootstrap Scripts to S3
 *
 * Resolves the scripts bucket from SSM Parameter Store and syncs local
 * bootstrap / deploy scripts to S3.
 *
 * Sync targets (kubernetes-bootstrap standalone repo layout):
 *   1. repo root (boot/, deploy_helpers/, system/, tests/)  → s3://{bucket}/k8s-bootstrap/
 *   2. workloads/charts/nextjs/      → s3://{bucket}/app-deploy/nextjs/      (optional)
 *   3. workloads/charts/monitoring/  → s3://{bucket}/app-deploy/monitoring/  (optional)
 *   4. workloads/charts/start-admin/ → s3://{bucket}/app-deploy/start-admin/ (optional)
 *   5–7. admin-api / public-api / wiki-mcp                                    (optional)
 *
 * Usage:
 *   npx tsx scripts/cd/sync-bootstrap-scripts.ts \
 *     --environment development \
 *     [--region eu-west-1]
 *
 * Environment variables (overridden by CLI flags):
 *   DEPLOY_ENVIRONMENT — environment name
 *   AWS_REGION         — AWS region (default: eu-west-1)
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parseArgs, buildAwsConfig, getSSMParameter } from '../lib/aws.js';
import { runCommand } from '../lib/exec.js';
import { writeSummary, emitAnnotation } from '../lib/github.js';
import logger from '../lib/logger.js';

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

// In CI (OIDC), AWS_ACCESS_KEY_ID is set — no profile needed.
// Locally, fall back to dev-account profile.
const subprocessProfile: string | undefined =
    (args.profile as string) || (!process.env.AWS_ACCESS_KEY_ID ? 'dev-account' : undefined);

// =============================================================================
// Resolve workspace root (this script lives at scripts/cd/ — two levels up = repo root)
// =============================================================================
const WORKSPACE_ROOT = resolve(__dirname, '..', '..');

// =============================================================================
// Sync Target Definitions
// =============================================================================
interface SyncTarget {
    label: string;
    sourceDir: string;
    s3Prefix: string;
    excludes: string[];
    optional: boolean;
}

const SYNC_TARGETS: SyncTarget[] = [
    {
        label: 'K8s Bootstrap Scripts',
        // Repo root IS the k8s-bootstrap content — exclude TypeScript/CDK directories
        sourceDir: '.',
        s3Prefix: 'k8s-bootstrap/',
        excludes: [
            'infra/*', 'scripts/*', 'logs/*', 'node_modules/*',
            '.git/*', '*.md', '*.toml', '.gitignore', '.ruff_cache/*',
            '.venv/*', '.pytest_cache/*', 'htmlcov/*', '__pycache__/*',
        ],
        optional: false,
    },
    {
        label: 'Next.js App Deploy Scripts',
        sourceDir: 'workloads/charts/nextjs',
        s3Prefix: 'app-deploy/nextjs/',
        excludes: ['chart/*', 'nextjs-values.yaml', '__pycache__/*'],
        optional: true,
    },
    {
        label: 'Monitoring Deploy Scripts',
        sourceDir: 'workloads/charts/monitoring',
        s3Prefix: 'app-deploy/monitoring/',
        excludes: ['chart/*', '__pycache__/*'],
        optional: true,
    },
    {
        label: 'Start-Admin Deploy Scripts',
        sourceDir: 'workloads/charts/start-admin',
        s3Prefix: 'app-deploy/start-admin/',
        excludes: ['chart/*', 'start-admin-values.yaml', '__pycache__/*'],
        optional: true,
    },
    {
        label: 'Admin-API Deploy Scripts',
        sourceDir: 'workloads/charts/admin-api',
        s3Prefix: 'app-deploy/admin-api/',
        excludes: ['chart/*', '__pycache__/*'],
        optional: true,
    },
    {
        label: 'Public-API Deploy Scripts',
        sourceDir: 'workloads/charts/public-api',
        s3Prefix: 'app-deploy/public-api/',
        excludes: ['chart/*', '__pycache__/*'],
        optional: true,
    },
    {
        label: 'Wiki-MCP Deploy Scripts',
        sourceDir: 'workloads/charts/wiki-mcp',
        s3Prefix: 'app-deploy/wiki-mcp/',
        excludes: ['chart/*', 'wiki-mcp-values.yaml', '__pycache__/*'],
        optional: true,
    },
];

// =============================================================================
// Helpers
// =============================================================================

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

async function syncTarget(
    target: SyncTarget,
    bucket: string,
): Promise<{ label: string; fileCount: number; status: 'synced' | 'skipped' }> {
    const absoluteSource = resolve(WORKSPACE_ROOT, target.sourceDir);

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

    const isRecursive = !target.optional;
    const fileCount = countFiles(absoluteSource, isRecursive);

    const s3Destination = `s3://${bucket}/${target.s3Prefix}`;
    const syncArgs = [
        's3', 'sync',
        absoluteSource,
        s3Destination,
        '--delete',
        '--region', awsConfig.region,
    ];

    for (const pattern of target.excludes) {
        syncArgs.push('--exclude', pattern);
    }

    logger.info(`Syncing ${fileCount} files from ${target.sourceDir} to ${s3Destination}`);

    const subprocessEnv: NodeJS.ProcessEnv | undefined = subprocessProfile
        ? { AWS_PROFILE: subprocessProfile }
        : undefined;

    const result = await runCommand('aws', syncArgs, {
        captureOutput: false,
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

    const ssmParamName = `/k8s/${environment}/scripts-bucket`;
    logger.task(`Resolving scripts bucket from SSM: ${ssmParamName}`);

    const bucket = await getSSMParameter(ssmParamName, awsConfig);

    if (!bucket) {
        emitAnnotation(
            'error',
            `Scripts bucket not found at ${ssmParamName}`,
            'S3 Sync Failed',
        );
        logger.fatal(
            `Scripts bucket not found at SSM parameter: ${ssmParamName}\n` +
            'Ensure the parameter exists and has a non-empty value.',
        );
        return;
    }

    logger.success(`Resolved scripts bucket: ${bucket}`);
    logger.blank();

    const results: { label: string; fileCount: number; status: string }[] = [];

    for (const target of SYNC_TARGETS) {
        logger.task(`Syncing ${target.label}...`);
        const result = await syncTarget(target, bucket);
        results.push(result);
        logger.blank();
    }

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
