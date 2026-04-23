#!/usr/bin/env npx tsx
/**
 * Deploy Monitoring Secrets
 *
 * Triggers the SSM Automation document that runs deploy.py on the
 * control-plane node.  deploy.py resolves SSM parameters (Grafana
 * admin password, GitHub token, etc.), creates/updates K8s Secrets,
 * deploys the Helm chart, and resets the Grafana password.
 *
 * Flow:
 *   1. Resolve control-plane instance ID from SSM
 *   2. Resolve SSM Automation document name from SSM
 *   3. Resolve S3 scripts bucket from SSM
 *   4. Start SSM Automation execution
 *   5. Poll until terminal state
 *   6. On failure → dump step details and exit 1
 *
 * Usage:
 *   npx tsx deploy-monitoring-secrets.ts \
 *     --environment development \
 *     [--region eu-west-1] \
 *     [--timeout 600] \
 *     [--poll-interval 15]
 *
 * Exit codes:
 *   0 — automation completed successfully
 *   1 — fatal error, automation failure, or timeout
 */

import {
    DescribeInstancesCommand,
    EC2Client,
} from '@aws-sdk/client-ec2';
import {
    GetAutomationExecutionCommand,
    GetParameterCommand,
    SSMClient,
    StartAutomationExecutionCommand,
} from '@aws-sdk/client-ssm';
import { parseArgs, buildAwsConfig } from '@nelsonlamounier/cdk-deploy-scripts/aws.js';
import { writeSummary, emitAnnotation } from '@nelsonlamounier/cdk-deploy-scripts/github.js';
import logger from '@nelsonlamounier/cdk-deploy-scripts/logger.js';

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
            name: 'timeout',
            description: 'Max seconds to wait for automation (default: 600)',
            hasValue: true,
            default: '600',
        },
        {
            name: 'poll-interval',
            description: 'Seconds between status polls (default: 15)',
            hasValue: true,
            default: '15',
        },
    ],
    'Deploy monitoring secrets via SSM Automation',
);

if (!args.environment) {
    logger.fatal(
        'Missing --environment flag or DEPLOY_ENVIRONMENT env var.\n' +
        'Run with --help for usage.',
    );
}

const environment = args.environment as string;
const awsConfig = buildAwsConfig(args);
const timeoutSeconds = parseInt(args['timeout'] as string, 10) || 600;
const pollIntervalSeconds = parseInt(args['poll-interval'] as string, 10) || 15;
const ssmPrefix = `/k8s/${environment}`;

// =============================================================================
// AWS Client
// =============================================================================
const ssm = new SSMClient({
    region: awsConfig.region,
    credentials: awsConfig.credentials,
});

const ec2 = new EC2Client({
    region: awsConfig.region,
    credentials: awsConfig.credentials,
});

// =============================================================================
// Helpers
// =============================================================================

/** Fetch a single SSM parameter value, returning undefined if missing. */
async function getParam(name: string): Promise<string | undefined> {
    try {
        const result = await ssm.send(new GetParameterCommand({ Name: name }));
        const value = result.Parameter?.Value;
        if (value && value !== 'None') return value;
        return undefined;
    } catch {
        return undefined;
    }
}

/** Sleep for a given number of milliseconds. */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve a running instance ID by its k8s:bootstrap-role tag.
 * Uses EC2 DescribeInstances filtered by tag + running state to
 * avoid stale SSM parameter lookups after ASG instance replacements.
 */
async function resolveInstanceByTag(tagValue: string): Promise<string | undefined> {
    try {
        const result = await ec2.send(
            new DescribeInstancesCommand({
                Filters: [
                    { Name: 'tag:k8s:bootstrap-role', Values: [tagValue] },
                    { Name: 'instance-state-name', Values: ['running'] },
                ],
            }),
        );

        const instances = result.Reservations?.flatMap((r) => r.Instances ?? []) ?? [];
        if (instances.length === 0) return undefined;
        return instances[0].InstanceId;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`EC2 describe-instances failed for tag k8s:bootstrap-role=${tagValue}: ${message}`);
        return undefined;
    }
}

// =============================================================================
// Terminal status sets
// =============================================================================
const TERMINAL_SUCCESS = new Set(['Success']);
const TERMINAL_FAILURE = new Set([
    'Failed',
    'Cancelled',
    'TimedOut',
    'CompletedWithFailure',
]);

// =============================================================================
// Main
// =============================================================================
async function main(): Promise<void> {
    logger.header('Deploy Monitoring Secrets');
    logger.keyValue('Environment', environment);
    logger.keyValue('Region', awsConfig.region);
    logger.keyValue('SSM Prefix', ssmPrefix);
    logger.keyValue('Timeout', `${timeoutSeconds}s`);
    logger.keyValue('Poll Interval', `${pollIntervalSeconds}s`);
    logger.blank();

    // ── 1. Resolve control-plane instance ID (live EC2 tag lookup) ────────
    const instanceId = await resolveInstanceByTag('control-plane');
    if (!instanceId) {
        emitAnnotation(
            'error',
            'No running control-plane instance found (tag k8s:bootstrap-role=control-plane)',
            'Monitoring Secrets Error',
        );
        logger.fatal('No running instance with tag k8s:bootstrap-role=control-plane');
    }
    logger.keyValue('Instance', instanceId!);

    // ── 2. Resolve SSM Automation document name ──────────────────────────
    const docParam = `${ssmPrefix}/deploy/secrets-doc-name`;
    const docName = await getParam(docParam);
    if (!docName) {
        emitAnnotation(
            'error',
            `Monitoring secrets doc name not found at ${docParam}`,
            'Monitoring Secrets Error',
        );
        logger.fatal(`Monitoring secrets doc name not found at ${docParam}`);
    }
    logger.keyValue('Document', docName!);

    // ── 3. Resolve S3 bucket ─────────────────────────────────────────────
    const s3Bucket = await getParam(`${ssmPrefix}/scripts-bucket`) ?? '';
    if (s3Bucket) {
        logger.keyValue('S3 Bucket', s3Bucket);
    }

    // ── 4. Start SSM Automation execution ────────────────────────────────
    logger.blank();
    logger.task('Starting SSM Automation');

    const startResult = await ssm.send(
        new StartAutomationExecutionCommand({
            DocumentName: docName!,
            Parameters: {
                InstanceId: [instanceId!],
                SsmPrefix: [ssmPrefix],
                S3Bucket: [s3Bucket],
                Region: [awsConfig.region],
            },
        }),
    );

    const executionId = startResult.AutomationExecutionId;
    if (!executionId) {
        emitAnnotation(
            'error',
            'SSM Automation did not return an execution ID',
            'Monitoring Secrets Error',
        );
        logger.fatal('SSM start-automation-execution did not return an execution ID');
    }
    logger.keyValue('Execution ID', executionId!);

    // ── 5. Poll until terminal state ─────────────────────────────────────
    logger.blank();
    logger.task('Polling SSM Automation status');

    const pollMs = pollIntervalSeconds * 1000;
    let waited = 0;
    let finalStatus = 'Unknown';
    let lastExecution: Record<string, unknown> | undefined;

    while (waited < timeoutSeconds * 1000) {
        await sleep(pollMs);
        waited += pollMs;

        try {
            const result = await ssm.send(
                new GetAutomationExecutionCommand({
                    AutomationExecutionId: executionId!,
                }),
            );

            const execution = result.AutomationExecution;
            finalStatus = execution?.AutomationExecutionStatus ?? 'Unknown';
            lastExecution = execution as unknown as Record<string, unknown>;

            // Log step-level progress
            const steps = execution?.StepExecutions ?? [];
            for (const step of steps) {
                const name = step.StepName ?? '?';
                const status = step.StepStatus ?? '?';
                if (status === 'Success') {
                    logger.info(`  [PASS] ${name}`);
                } else if (status === 'Failed') {
                    logger.warn(`  [FAIL] ${name}: ${step.FailureMessage ?? 'unknown'}`);
                } else if (status === 'InProgress') {
                    logger.info(`  [RUN]  ${name}`);
                } else {
                    logger.info(`  [${status}] ${name}`);
                }
            }
        } catch {
            // Transient API error — keep polling
        }

        if (TERMINAL_SUCCESS.has(finalStatus)) {
            break;
        }

        if (TERMINAL_FAILURE.has(finalStatus)) {
            break;
        }

        logger.info(`Status: ${finalStatus} (${waited / 1000}s / ${timeoutSeconds}s)`);
    }

    // ── 6. Final result ──────────────────────────────────────────────────
    logger.blank();

    if (TERMINAL_SUCCESS.has(finalStatus)) {
        logger.success(`deploy.py completed successfully (${waited / 1000}s)`);

        writeSummary(buildSummary('✅ Success', executionId!, waited / 1000));
        return;
    }

    // ── Failure or timeout ───────────────────────────────────────────────
    const isTimeout = !TERMINAL_FAILURE.has(finalStatus) && waited >= timeoutSeconds * 1000;
    const failureReason = isTimeout
        ? `Timed out after ${timeoutSeconds}s`
        : `Automation ${finalStatus}`;

    logger.warn(`[FAIL] ${failureReason}`);

    // Dump step execution details
    if (lastExecution) {
        const steps = (lastExecution as { StepExecutions?: Array<{
            StepName?: string;
            StepStatus?: string;
            Outputs?: Record<string, string[]>;
            FailureMessage?: string;
        }> }).StepExecutions ?? [];

        if (steps.length > 0) {
            logger.blank();
            logger.task('Automation Step Details');
            for (const step of steps) {
                const name = step.StepName ?? '?';
                const status = step.StepStatus ?? '?';
                const outputs = step.Outputs ? JSON.stringify(step.Outputs) : '{}';
                logger.info(`Step: ${name} | Status: ${status} | Output: ${outputs}`);
                if (step.FailureMessage) {
                    logger.warn(`  Reason: ${step.FailureMessage}`);
                }
            }
        }
    }

    emitAnnotation(
        'error',
        `Monitoring secrets deployment failed: ${failureReason}`,
        'Monitoring Secrets Error',
    );

    writeSummary(buildSummary(`❌ ${failureReason}`, executionId!, waited / 1000));
    process.exit(1);
}

// =============================================================================
// Summary helper
// =============================================================================
function buildSummary(
    status: string,
    executionId: string,
    elapsedSeconds: number,
): string {
    return [
        '## Deploy Monitoring Secrets',
        '',
        '| Field | Value |',
        '|-------|-------|',
        `| Status | ${status} |`,
        `| Execution ID | \`${executionId}\` |`,
        `| Environment | ${environment} |`,
        `| Elapsed | ${elapsedSeconds}s |`,
        `| SSM Prefix | \`${ssmPrefix}\` |`,
        '',
    ].join('\n');
}

// =============================================================================
// Entry point
// =============================================================================
main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    emitAnnotation('error', `Monitoring secrets failed: ${message}`, 'Monitoring Secrets Error');
    logger.fatal(`Monitoring secrets failed: ${message}`);
});
