#!/usr/bin/env npx tsx
/**
 * SSM Bootstrap Observer
 *
 * Monitors an SSM Automation execution triggered by trigger-bootstrap.ts.
 * Polls step-level progress and streams CloudWatch logs from both the
 * SSM bootstrap log group and the EC2 instance log group into GitHub
 * Actions output for real-time visibility.
 *
 * Usage:
 *   npx tsx scripts/cd/observe-bootstrap.ts \
 *     --environment development \
 *     --execution-id <ssm-execution-id> \
 *     [--region eu-west-1] \
 *     [--poll-interval 15] \
 *     [--max-polls 80]
 *
 * Environment variables (overridden by CLI flags):
 *   DEPLOY_ENVIRONMENT — environment name
 *   AWS_REGION         — AWS region (default: eu-west-1)
 *   CDK_ENVIRONMENT    — CDK environment (defaults to --environment)
 *   CP_EXECUTION_ID    — execution ID from trigger job
 *
 * Exit codes:
 *   0 — success or skipped (nothing to observe)
 *   1 — automation failed / cancelled / timed out
 */

import {
    CloudWatchLogsClient,
    DescribeLogStreamsCommand,
    GetLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
    GetAutomationExecutionCommand,
    GetCommandInvocationCommand,
    SSMClient,
} from '@aws-sdk/client-ssm';
import { parseArgs, buildAwsConfig } from '../lib/aws.js';
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
            name: 'execution-id',
            description: 'SSM Automation execution ID to observe',
            hasValue: true,
            default: process.env.CP_EXECUTION_ID ?? '',
        },
        {
            name: 'cdk-environment',
            description: 'CDK environment name (defaults to --environment, used for EC2 log group)',
            hasValue: true,
            default: process.env.CDK_ENVIRONMENT ?? '',
        },
        {
            name: 'poll-interval',
            description: 'Seconds between polls (default: 15)',
            hasValue: true,
            default: '15',
        },
        {
            name: 'max-polls',
            description: 'Maximum number of poll iterations (default: 80)',
            hasValue: true,
            default: '80',
        },
    ],
    'SSM Bootstrap Observer — poll automation & stream CloudWatch logs',
);

const environment = (args.environment as string) || '';
const executionId = (args['execution-id'] as string) || '';
const cdkEnvironment = (args['cdk-environment'] as string) || environment;
const awsConfig = buildAwsConfig(args);
const pollInterval = parseInt(args['poll-interval'] as string, 10) || 15;
const maxPolls = parseInt(args['max-polls'] as string, 10) || 80;

const ssmLogGroup = `/ssm/k8s/${environment}/bootstrap`;
const ec2LogGroup = `/ec2/k8s-${cdkEnvironment}/instances`;

// =============================================================================
// AWS Clients
// =============================================================================
const ssm = new SSMClient({
    region: awsConfig.region,
    credentials: awsConfig.credentials,
});

const logs = new CloudWatchLogsClient({
    region: awsConfig.region,
    credentials: awsConfig.credentials,
});

// =============================================================================
// Types
// =============================================================================
interface StepExecution {
    StepName?: string;
    StepStatus?: string;
    FailureMessage?: string;
    Outputs?: Record<string, string[]>;
}

interface ObserverResult {
    outcome: 'success' | 'failed' | 'skipped' | 'timeout';
    reason?: string;
    pollCount: number;
}

const TERMINAL_SUCCESS = new Set(['Success']);
const TERMINAL_FAILURE = new Set(['Failed', 'Cancelled', 'TimedOut', 'CompletedWithFailure']);

// =============================================================================
// Helpers
// =============================================================================

function sleep(seconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function timestamp(): string {
    return new Date().toISOString().replace(/T/, ' ').replace(/\.\d+Z/, 'Z');
}

// =============================================================================
// CloudWatch log streaming
// =============================================================================

async function streamLogGroup(
    logGroupName: string,
    label: string,
    watchStart: number,
    pollNum: number,
): Promise<void> {
    console.log(`::group::${label} (poll ${pollNum})`);

    try {
        const { logStreams } = await logs.send(
            new DescribeLogStreamsCommand({
                logGroupName,
                orderBy: 'LastEventTime',
                descending: true,
                limit: 3,
            }),
        );

        if (!logStreams?.length) {
            console.log('  (no log streams yet)');
            console.log('::endgroup::');
            return;
        }

        for (const stream of logStreams) {
            if (!stream.logStreamName) continue;

            try {
                const { events } = await logs.send(
                    new GetLogEventsCommand({
                        logGroupName,
                        logStreamName: stream.logStreamName,
                        startTime: watchStart,
                        limit: 50,
                    }),
                );

                for (const event of events ?? []) {
                    if (event.message) {
                        console.log(event.message.trimEnd());
                    }
                }
            } catch {
                // Skip individual stream errors
            }
        }
    } catch {
        console.log('  (log group not yet created)');
    }

    console.log('::endgroup::');
}

// =============================================================================
// SSM Automation step rendering
// =============================================================================

function renderStepProgress(
    steps: StepExecution[],
    status: string,
    pollNum: number,
): void {
    console.log(`::group::SSM Bootstrap Steps (Status: ${status}, poll ${pollNum})`);

    for (const step of steps) {
        const name = step.StepName ?? 'unknown';
        const stepStatus = step.StepStatus ?? 'Pending';

        if (stepStatus === 'Success') {
            console.log(`  [PASS] ${name}`);
        } else if (stepStatus === 'Failed') {
            console.log(`  [FAIL] ${name}: ${step.FailureMessage ?? 'unknown'}`);
        } else if (stepStatus === 'InProgress') {
            console.log(`  [RUN]  ${name}`);
        } else {
            console.log(`  [WAIT] ${name} (${stepStatus})`);
        }
    }

    console.log('::endgroup::');
}

// =============================================================================
// Failure diagnostics
// =============================================================================

async function dumpRunCommandOutput(
    steps: StepExecution[],
    instanceId: string | undefined,
): Promise<void> {
    if (!instanceId) return;

    const failedStep = steps.find((s) => s.StepStatus === 'Failed');
    if (!failedStep) return;

    const commandId = failedStep.Outputs?.['RunCommand.CommandId']?.[0];
    if (!commandId) return;

    try {
        console.log(`::group::RunCommand Output (${failedStep.StepName})`);

        const result = await ssm.send(
            new GetCommandInvocationCommand({
                CommandId: commandId,
                InstanceId: instanceId,
            }),
        );

        console.log('STDOUT:');
        console.log(result.StandardOutputContent ?? '(empty)');
        console.log('');
        console.log('STDERR:');
        console.log(result.StandardErrorContent ?? '(empty)');

        console.log('::endgroup::');
    } catch {
        console.log('  (failed to retrieve RunCommand output)');
        console.log('::endgroup::');
    }
}

// =============================================================================
// Summary builder
// =============================================================================

function buildSummary(result: ObserverResult): string {
    const lines: string[] = [
        '## 🔭 SSM Bootstrap Observer',
        '',
        `**Environment**: ${environment}`,
        `**Execution**: \`${executionId}\``,
        `**Region**: ${awsConfig.region}`,
        `**Polls**: ${result.pollCount}`,
        '',
    ];

    switch (result.outcome) {
        case 'success':
            lines.push('✅ **Bootstrap completed successfully**');
            break;
        case 'failed':
            lines.push(`❌ **Bootstrap failed** — ${result.reason ?? 'unknown reason'}`);
            break;
        case 'skipped':
            lines.push(`⏭️ **Skipped** — ${result.reason}`);
            break;
        case 'timeout':
            lines.push(`⏱️ **Timed out** after ${maxPolls} polls`);
            break;
    }

    return lines.join('\n');
}

// =============================================================================
// Main
// =============================================================================
async function main(): Promise<void> {
    logger.header('SSM Bootstrap Observer');
    logger.keyValue('Environment', environment);
    logger.keyValue('Region', awsConfig.region);
    logger.keyValue('SSM Log Group', ssmLogGroup);
    logger.keyValue('EC2 Log Group', ec2LogGroup);
    logger.keyValue('Poll Interval', `${pollInterval}s`);
    logger.keyValue('Max Polls', `${maxPolls}`);
    logger.blank();

    if (!executionId) {
        emitAnnotation(
            'warning',
            'No control-plane execution ID received — nothing to observe',
            'Bootstrap Observer',
        );
        const result: ObserverResult = {
            outcome: 'skipped',
            reason: 'No control-plane execution ID',
            pollCount: 0,
        };
        writeSummary(buildSummary(result));
        logger.info('Skipping observer — no execution ID');
        return;
    }

    logger.keyValue('Execution ID', executionId);
    logger.blank();

    const watchStart = Date.now();

    for (let i = 1; i <= maxPolls; i++) {
        let status = 'Unknown';
        let steps: StepExecution[] = [];
        let instanceId: string | undefined;

        try {
            const result = await ssm.send(
                new GetAutomationExecutionCommand({
                    AutomationExecutionId: executionId,
                }),
            );

            status = result.AutomationExecution?.AutomationExecutionStatus ?? 'Unknown';
            steps = (result.AutomationExecution?.StepExecutions ?? []) as StepExecution[];
            instanceId = result.AutomationExecution?.Parameters?.['InstanceId']?.[0];
        } catch {
            logger.warn(`Poll ${i}: failed to get automation execution (transient)`);
        }

        console.log(`[${timestamp()}] Poll ${i}/${maxPolls} — Status: ${status}`);

        if (steps.length > 0) {
            renderStepProgress(steps, status, i);
        }

        await streamLogGroup(ssmLogGroup, 'Bootstrap Logs (CloudWatch)', watchStart, i);
        await streamLogGroup(ec2LogGroup, 'EC2 Boot Logs (CloudWatch)', watchStart, i);

        if (TERMINAL_SUCCESS.has(status)) {
            logger.blank();
            logger.success('SSM Automation completed successfully');

            await streamLogGroup(ssmLogGroup, 'Full Bootstrap Logs', watchStart, i);
            await streamLogGroup(ec2LogGroup, 'Full EC2 Boot Logs', watchStart, i);

            const result: ObserverResult = { outcome: 'success', pollCount: i };
            writeSummary(buildSummary(result));
            return;
        }

        if (TERMINAL_FAILURE.has(status)) {
            logger.blank();
            logger.error(`SSM Automation ${status}`);

            for (const step of steps) {
                if (step.StepStatus === 'Failed') {
                    logger.error(`FAILED STEP: ${step.StepName}`);
                    logger.error(`Reason: ${step.FailureMessage ?? 'unknown'}`);
                }
            }

            await streamLogGroup(ssmLogGroup, 'Full Bootstrap Logs (for debugging)', watchStart, i);
            await streamLogGroup(ec2LogGroup, 'Full EC2 Boot Logs (for debugging)', watchStart, i);

            await dumpRunCommandOutput(steps, instanceId);

            const result: ObserverResult = {
                outcome: 'failed',
                reason: status,
                pollCount: i,
            };
            writeSummary(buildSummary(result));
            emitAnnotation('error', `SSM Bootstrap ${status}`, 'Bootstrap Observer');
            process.exit(1);
        }

        if (i < maxPolls) {
            await sleep(pollInterval);
        }
    }

    logger.warn(`Observer timed out after ${maxPolls} polls`);
    const result: ObserverResult = { outcome: 'timeout', pollCount: maxPolls };
    writeSummary(buildSummary(result));
    emitAnnotation('warning', `Observer timed out after ${maxPolls} polls`, 'Bootstrap Observer');
    process.exit(1);
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    emitAnnotation('error', `Bootstrap observer failed: ${message}`, 'Bootstrap Observer');
    logger.fatal(`Bootstrap observer failed: ${message}`);
});
