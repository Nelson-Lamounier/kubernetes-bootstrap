#!/usr/bin/env npx tsx
/**
 * Trigger Config — Step Functions Edition (SM-B)
 *
 * Starts the Config Orchestrator state machine (SM-B) which injects
 * SSM-sourced application configuration into Kubernetes:
 *   - nextjs-secrets, monitoring-secrets, start-admin-secrets
 *   - admin-api ConfigMap + Secret + IngressRoute
 *   - public-api ConfigMap + Secret + IngressRoute
 *
 * SM-B is normally triggered automatically by EventBridge when SM-A
 * (Bootstrap Orchestrator) succeeds. This script provides a manual
 * trigger path for:
 *   - GitHub Actions Phase 6 (post-bootstrap config)
 *   - Standalone secret rotation runs
 *   - Local `just config-run <environment>` recipes
 *
 * The Config SM ARN is resolved from SSM parameter
 * `{ssmPrefix}/bootstrap/config-state-machine-arn`, written by CDK.
 *
 * Unlike trigger-bootstrap.ts, this script does NOT need instance IDs
 * or ASG resolution — SM-B reads the CP instance ID from SSM internally.
 *
 * Usage:
 *   npx tsx trigger-config.ts \
 *     --environment development \
 *     [--region eu-west-1] \
 *     [--max-wait 3600]
 *
 * Environment Variables (overridden by CLI flags):
 *   DEPLOY_ENVIRONMENT — environment name
 *   AWS_REGION         — AWS region (default: eu-west-1)
 *
 * Exit Codes:
 *   0 — SM-B execution completed successfully (ConfigApplied)
 *   1 — Fatal configuration error, SM start failure, or execution failure
 */

import {
    SFNClient,
    StartExecutionCommand,
    DescribeExecutionCommand,
} from '@aws-sdk/client-sfn';
import {
    GetParameterCommand,
    SSMClient,
} from '@aws-sdk/client-ssm';
import { parseArgs, buildAwsConfig } from '@nelson-lamounier/cdk-deploy-scripts/aws.js';
import { setOutput, writeSummary, emitAnnotation } from '@nelson-lamounier/cdk-deploy-scripts/github.js';
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
            name: 'max-wait',
            description: 'Max seconds to wait for SM-B execution (default: 3600 = 1 hour)',
            hasValue: true,
            default: '3600',
        },
    ],
    'Trigger Config Orchestrator (SM-B) — injects app secrets into K8s',
);

if (!args.environment) {
    logger.fatal(
        'Missing --environment flag or DEPLOY_ENVIRONMENT env var.\n' +
        'Run with --help for usage.',
    );
}

const environment = args.environment as string;
const awsConfig = buildAwsConfig(args);
const maxWait = parseInt(args['max-wait'] as string, 10) || 3600;
const ssmPrefix = `/k8s/${environment}`;

// =============================================================================
// AWS Clients
// =============================================================================
const ssm = new SSMClient({
    region: awsConfig.region,
    credentials: awsConfig.credentials,
});

const sfn = new SFNClient({
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

// =============================================================================
// Core
// =============================================================================

/** Terminal Step Functions execution statuses. */
const TERMINAL_SUCCESS = new Set(['SUCCEEDED']);
const TERMINAL_FAILURE = new Set(['FAILED', 'TIMED_OUT', 'ABORTED']);

/**
 * Poll a Step Functions execution until it reaches a terminal state or times out.
 *
 * @param label          - Human-readable label for log messages
 * @param executionArn   - ARN of the execution to poll
 * @param maxWaitSeconds - Maximum seconds to wait before giving up
 * @returns true if execution SUCCEEDED, false otherwise
 */
async function waitForExecution(
    label: string,
    executionArn: string,
    maxWaitSeconds: number,
): Promise<boolean> {
    const pollInterval = 15_000; // 15 seconds
    let waited = 0;

    logger.blank();
    logger.task(`Waiting for ${label} execution`);
    logger.keyValue('ARN', executionArn);

    while (waited < maxWaitSeconds * 1000) {
        let status = 'UNKNOWN';

        try {
            const result = await sfn.send(new DescribeExecutionCommand({ executionArn }));
            status = result.status ?? 'UNKNOWN';
        } catch {
            // Transient error — keep polling
        }

        if (TERMINAL_SUCCESS.has(status)) {
            logger.success(`${label} execution SUCCEEDED (${waited / 1000}s)`);
            return true;
        }

        if (TERMINAL_FAILURE.has(status)) {
            logger.warn(`${label} execution finished with status: ${status} (${waited / 1000}s)`);
            return false;
        }

        logger.info(`${label} status: ${status} (${waited / 1000}s / ${maxWaitSeconds}s)`);
        await sleep(pollInterval);
        waited += pollInterval;
    }

    logger.warn(`${label} execution did not complete within ${maxWaitSeconds}s`);
    return false;
}

// =============================================================================
// Main
// =============================================================================
async function main(): Promise<void> {
    logger.header('Trigger Config Orchestrator (SM-B)');
    logger.keyValue('Environment', environment);
    logger.keyValue('Region', awsConfig.region);
    logger.keyValue('SSM Prefix', ssmPrefix);
    logger.keyValue('Max Wait', `${maxWait}s`);
    logger.blank();

    // ── Resolve Config State Machine ARN ─────────────────────────────────────
    const configArnParam = `${ssmPrefix}/bootstrap/config-state-machine-arn`;
    const configSmArn = await getParam(configArnParam);
    if (!configSmArn) {
        emitAnnotation(
            'error',
            `Config state machine ARN not found at '${configArnParam}'. ` +
            'Deploy the SsmAutomation CDK stack first.',
            'Config Trigger Error',
        );
        logger.fatal(
            `Config SM ARN not found at ${configArnParam}. ` +
            'Run: just deploy-stack SsmAutomation-development kubernetes development',
        );
    }
    logger.keyValue('Config SM ARN', configSmArn!);
    logger.blank();

    // ── Start SM-B execution ──────────────────────────────────────────────────
    //
    // SM-B does not need an instance ID in the input — it reads the CP
    // instance ID from SSM internally (written by SM-A's UpdateInstanceId step).
    //
    const executionInput = JSON.stringify({
        trigger: 'github-actions',
        source:  'manual',
    });

    let executionArn: string;
    try {
        const startResult = await sfn.send(
            new StartExecutionCommand({
                stateMachineArn: configSmArn!,
                input: executionInput,
                name: `gha-config-${environment}-${Date.now()}`,
            }),
        );

        if (!startResult.executionArn) {
            emitAnnotation(
                'error',
                'StartExecution returned no ARN — SM-B may not be accessible.',
                'Config Trigger Error',
            );
            logger.fatal('SM-B StartExecution returned no ARN.');
        }

        executionArn = startResult.executionArn!;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emitAnnotation('error', `Failed to start SM-B: ${msg}`, 'Config Trigger Error');
        logger.fatal(`Failed to start SM-B: ${msg}`);
    }

    logger.keyValue('Execution ARN', executionArn!);
    setOutput('config_execution_arn', executionArn!);

    // ── Wait for completion ───────────────────────────────────────────────────
    const succeeded = await waitForExecution('config-orchestrator', executionArn!, maxWait);

    // ── Step Summary ──────────────────────────────────────────────────────────
    writeSummary([
        '## Config Orchestrator (SM-B) Trigger',
        '',
        `| Field | Value |`,
        `|-------|-------|`,
        `| Environment | ${environment} |`,
        `| Status | ${succeeded ? '✅ SUCCEEDED' : '❌ FAILED'} |`,
        `| Execution ARN | \`${executionArn!.split(':').slice(-1)[0]}\` |`,
        `| Config SM ARN | \`${configSmArn}\` |`,
    ].join('\n'));

    if (!succeeded) {
        emitAnnotation(
            'error',
            'Config Orchestrator (SM-B) execution failed. Check Step Functions and CloudWatch logs.',
            'Config Injection Failed',
        );
        process.exit(1);
    }

    logger.header('Config Injection Complete');
    logger.success('All app config deploy scripts completed successfully');
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    emitAnnotation('error', `Config trigger failed: ${message}`, 'Config Trigger Error');
    logger.fatal(`Config trigger failed: ${message}`);
});
