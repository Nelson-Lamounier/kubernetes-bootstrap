#!/usr/bin/env npx tsx
/**
 * Trigger Bootstrap — Step Functions Edition
 *
 * Starts AWS Step Functions executions for Kubernetes node bootstrap in the
 * following order:
 *
 *   1. Start control-plane execution
 *   2. Wait for control-plane execution to succeed
 *      (workers must not start until join credentials are exported)
 *   3. Start worker node executions in parallel (general-pool, monitoring-pool)
 *
 * The Step Functions state machine ARN is resolved at runtime from the SSM
 * parameter `{ssmPrefix}/bootstrap/state-machine-arn` written by CDK.
 *
 * Usage:
 *   npx tsx scripts/cd/trigger-bootstrap.ts \
 *     --environment development \
 *     [--region eu-west-1] \
 *     [--max-wait 600]
 *
 * Environment Variables (overridden by CLI flags):
 *   DEPLOY_ENVIRONMENT — environment name
 *   AWS_REGION         — AWS region (default: eu-west-1)
 *
 * Exit Codes:
 *   0 — success
 *   1 — fatal error (missing environment, CP failure, configuration error)
 */

import {
    DescribeInstancesCommand,
    EC2Client,
    RebootInstancesCommand,
} from '@aws-sdk/client-ec2';
import {
    SFNClient,
    StartExecutionCommand,
    DescribeExecutionCommand,
    ListExecutionsCommand,
} from '@aws-sdk/client-sfn';
import {
    DescribeInstanceInformationCommand,
    GetParameterCommand,
    PutParameterCommand,
    SSMClient,
} from '@aws-sdk/client-ssm';
import { parseArgs, buildAwsConfig } from '../lib/aws.js';
import { setOutput, writeSummary, emitAnnotation } from '../lib/github.js';
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
            name: 'max-wait',
            description: 'Max seconds to wait for control-plane execution (default: 1200)',
            hasValue: true,
            default: '1200',
        },
        {
            name: 'dry-run',
            description: 'Resolve instances and check for running executions without starting new ones',
            hasValue: false,
            default: false,
        },
    ],
    'Trigger Step Functions K8s bootstrap on K8s nodes',
);

if (!args.environment) {
    logger.fatal(
        'Missing --environment flag or DEPLOY_ENVIRONMENT env var.\n' +
        'Run with --help for usage.',
    );
}

const environment = args.environment as string;
const awsConfig = buildAwsConfig(args);
const maxWait = parseInt(args['max-wait'] as string, 10) || 1200;
const dryRun = Boolean(args['dry-run']);
const ssmPrefix = `/k8s/${environment}`;

// =============================================================================
// AWS Clients
// =============================================================================
const ssm = new SSMClient({
    region: awsConfig.region,
    credentials: awsConfig.credentials,
});

const ec2 = new EC2Client({
    region: awsConfig.region,
    credentials: awsConfig.credentials,
});

const sfn = new SFNClient({
    region: awsConfig.region,
    credentials: awsConfig.credentials,
});

// =============================================================================
// Node Trigger Target Definitions
// =============================================================================

interface TriggerTarget {
    role: string;
    execParam: string;
    outputKey: string;
    targetTagValue: string;
}

function buildTargets(prefix: string): TriggerTarget[] {
    return [
        {
            role: 'control-plane',
            execParam: `${prefix}/bootstrap/execution-id`,
            outputKey: 'cp_execution_id',
            targetTagValue: 'control-plane',
        },
        {
            role: 'general-pool',
            execParam: `${prefix}/bootstrap/general-pool-execution-id`,
            outputKey: 'general_pool_execution_id',
            targetTagValue: 'general-pool',
        },
        {
            role: 'monitoring-pool',
            execParam: `${prefix}/bootstrap/monitoring-pool-execution-id`,
            outputKey: 'monitoring_pool_execution_id',
            targetTagValue: 'monitoring-pool',
        },
    ];
}

// =============================================================================
// Helpers
// =============================================================================

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

async function resolveAsgNameByTag(tagValue: string): Promise<string | undefined> {
    try {
        const result = await ec2.send(
            new DescribeInstancesCommand({
                Filters: [
                    { Name: 'tag:k8s:bootstrap-role', Values: [tagValue] },
                    { Name: 'instance-state-name', Values: ['running'] },
                ],
            }),
        );

        const instance = result.Reservations?.flatMap((r) => r.Instances ?? [])?.[0];
        if (!instance) return undefined;

        const asgTag = instance.Tags?.find((t) => t.Key === 'aws:autoscaling:groupName');
        return asgTag?.Value;
    } catch {
        return undefined;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkSsmAgentHealth(
    instanceId: string,
    maxRecoverySeconds = 180,
): Promise<void> {
    async function getPingStatus(): Promise<string> {
        try {
            const result = await ssm.send(
                new DescribeInstanceInformationCommand({
                    Filters: [{ Key: 'InstanceIds', Values: [instanceId] }],
                }),
            );
            return result.InstanceInformationList?.[0]?.PingStatus ?? 'Unknown';
        } catch {
            return 'Unknown';
        }
    }

    const initialStatus = await getPingStatus();
    logger.keyValue('SSM PingStatus', initialStatus);

    if (initialStatus === 'Online') return;

    if (initialStatus === 'ConnectionLost' || initialStatus === 'Inactive') {
        logger.warn(
            `SSM agent is ${initialStatus} on ${instanceId} — triggering reboot to recover`,
        );
        try {
            await ec2.send(new RebootInstancesCommand({ InstanceIds: [instanceId] }));
            logger.info('Reboot triggered — waiting for SSM agent to come online...');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(
                `FATAL: Could not reboot instance ${instanceId} to recover SSM agent (${msg}). ` +
                'Aborting deployment — a broken node must be investigated before bootstrap proceeds.',
            );
        }

        const pollMs = 15_000;
        let waited = 0;
        while (waited < maxRecoverySeconds * 1000) {
            await sleep(pollMs);
            waited += pollMs;
            const status = await getPingStatus();
            logger.info(
                `SSM agent recovery: ${status} (${waited / 1000}s / ${maxRecoverySeconds}s)`,
            );
            if (status === 'Online') {
                logger.success(`SSM agent recovered on ${instanceId} after ${waited / 1000}s`);
                return;
            }
        }

        throw new Error(
            `FATAL: SSM agent on ${instanceId} (${initialStatus}) did not come online within ` +
            `${maxRecoverySeconds}s after reboot. Aborting deployment — ` +
            'check CloudWatch agent logs and EC2 system status checks before retrying.',
        );
    }

    throw new Error(
        `FATAL: Unexpected SSM agent PingStatus '${initialStatus}' on ${instanceId}. ` +
        'This instance has never registered with SSM or its registration has been lost. ' +
        'Verify the IAM role, SSM agent installation, and VPC endpoints before retrying.',
    );
}

// =============================================================================
// Execution Deduplication
// =============================================================================

/**
 * Returns the ARN of any currently-RUNNING execution for this role.
 * Execution names from this script follow the pattern `github-{role}-{timestamp}`.
 * EventBridge-auto-triggered executions have generated names — those are excluded
 * since the SM-A router handles deduplication for ASG launch events natively.
 */
async function findRunningExecution(
    stateMachineArn: string,
    role: string,
): Promise<string | undefined> {
    try {
        const result = await sfn.send(
            new ListExecutionsCommand({
                stateMachineArn,
                statusFilter: 'RUNNING',
                maxResults: 20,
            }),
        );
        return result.executions
            ?.find((e) => e.name?.includes(`-${role}-`))
            ?.executionArn;
    } catch {
        return undefined;
    }
}

// =============================================================================
// Core Functions
// =============================================================================

interface TriggerResult {
    role: string;
    status: 'triggered' | 'skipped';
    executionArn?: string;
    instanceId?: string;
    reason?: string;
}

async function triggerNode(
    target: TriggerTarget,
    stateMachineArn: string,
    isDryRun: boolean,
): Promise<TriggerResult> {
    logger.task(`${target.role}${isDryRun ? ' [DRY-RUN]' : ''}`);

    const instanceId = await resolveInstanceByTag(target.targetTagValue);
    if (!instanceId) {
        logger.info(`[SKIP] No running instance with tag k8s:bootstrap-role=${target.targetTagValue}`);
        return { role: target.role, status: 'skipped', reason: 'no running instance' };
    }
    logger.keyValue('Instance', instanceId);

    const asgName = await resolveAsgNameByTag(target.targetTagValue);
    if (!asgName) {
        logger.warn(`[SKIP] Could not resolve ASG name for tag ${target.targetTagValue}`);
        return { role: target.role, status: 'skipped', reason: 'no ASG name' };
    }
    logger.keyValue('ASG', asgName);

    // Check for an already-running execution before starting a new one.
    // Prevents duplicate runs when the workflow is re-triggered while a prior
    // execution is still in progress (e.g. re-run on a slow bootstrap).
    const runningArn = await findRunningExecution(stateMachineArn, target.role);
    if (runningArn) {
        logger.warn(
            `[DEDUP] Found running execution for ${target.role} — skipping new start.` +
            ` Attach to: ${runningArn}`,
        );
        if (isDryRun) {
            logger.info(`[DRY-RUN] Would reuse running execution: ${runningArn}`);
        }
        return { role: target.role, status: 'triggered', executionArn: runningArn, instanceId };
    }

    if (isDryRun) {
        logger.info(`[DRY-RUN] Would start SM-A execution for ${target.role}`);
        logger.keyValue('  Input EC2InstanceId', instanceId);
        logger.keyValue('  Input AutoScalingGroupName', asgName);
        logger.info('[DRY-RUN] No execution started');
        return { role: target.role, status: 'skipped', reason: 'dry-run' };
    }

    await checkSsmAgentHealth(instanceId);

    const executionInput = JSON.stringify({
        detail: {
            EC2InstanceId: instanceId,
            AutoScalingGroupName: asgName,
        },
    });

    let executionArn: string;
    try {
        const startResult = await sfn.send(
            new StartExecutionCommand({
                stateMachineArn,
                input: executionInput,
                name: `github-${target.role}-${Date.now()}`,
            }),
        );

        if (!startResult.executionArn) {
            logger.warn(`Failed to start Step Functions execution for ${target.role} — no ARN returned`);
            return { role: target.role, status: 'skipped', reason: 'start failed' };
        }

        executionArn = startResult.executionArn;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Failed to start Step Functions execution for ${target.role}: ${msg}`);
        return { role: target.role, status: 'skipped', reason: msg };
    }

    logger.keyValue('Execution ARN', executionArn);

    try {
        await ssm.send(
            new PutParameterCommand({
                Name: target.execParam,
                Value: executionArn,
                Type: 'String',
                Overwrite: true,
            }),
        );
    } catch {
        logger.warn(`Could not publish execution ARN to ${target.execParam}`);
    }

    setOutput(target.outputKey, executionArn);

    logger.success(`${target.role} Step Functions execution started`);
    return { role: target.role, status: 'triggered', executionArn, instanceId };
}

const TERMINAL_SUCCESS = new Set(['SUCCEEDED']);
const TERMINAL_FAILURE = new Set(['FAILED', 'TIMED_OUT', 'ABORTED']);

async function waitForExecution(
    role: string,
    executionArn: string,
    maxWaitSeconds: number,
): Promise<boolean> {
    const pollInterval = 15_000;
    let waited = 0;

    logger.blank();
    logger.task(`Waiting for ${role} execution`);
    logger.keyValue('ARN', executionArn);

    while (waited < maxWaitSeconds * 1000) {
        let status = 'UNKNOWN';

        try {
            const result = await sfn.send(
                new DescribeExecutionCommand({ executionArn }),
            );
            status = result.status ?? 'UNKNOWN';
        } catch {
            // Transient error — keep polling
        }

        if (TERMINAL_SUCCESS.has(status)) {
            logger.success(`${role} execution SUCCEEDED (${waited / 1000}s)`);
            return true;
        }

        if (TERMINAL_FAILURE.has(status)) {
            logger.warn(`${role} execution finished with status: ${status} (${waited / 1000}s)`);
            return false;
        }

        logger.info(`${role} status: ${status} (${waited / 1000}s / ${maxWaitSeconds}s)`);
        await sleep(pollInterval);
        waited += pollInterval;
    }

    logger.warn(`${role} execution did not complete within ${maxWaitSeconds}s`);
    return false;
}

// =============================================================================
// Main
// =============================================================================
async function main(): Promise<void> {
    logger.header('Trigger Step Functions Bootstrap');
    logger.keyValue('Environment', environment);
    logger.keyValue('Region', awsConfig.region);
    logger.keyValue('SSM Prefix', ssmPrefix);
    logger.keyValue('Max Wait (CP)', `${maxWait}s`);
    if (dryRun) logger.keyValue('Mode', 'DRY-RUN — no executions will be started');
    logger.blank();

    const smArnParam = `${ssmPrefix}/bootstrap/state-machine-arn`;
    const stateMachineArn = await getParam(smArnParam);
    if (!stateMachineArn) {
        emitAnnotation(
            'error',
            `State machine ARN not found at SSM path '${smArnParam}'. ` +
            'Deploy the K8s SSM Automation stack first.',
            'Bootstrap Config Error',
        );
        logger.fatal(
            `State machine ARN not found at ${smArnParam}. ` +
            'Run the CDK deployment pipeline to provision the Step Functions stack.',
        );
    }
    logger.keyValue('State Machine ARN', stateMachineArn!);
    logger.blank();

    const targets = buildTargets(ssmPrefix);
    const results: TriggerResult[] = [];

    const cpTarget = targets[0];
    const cpResult = await triggerNode(cpTarget, stateMachineArn!, dryRun);
    results.push(cpResult);
    logger.blank();

    if (cpResult.status === 'triggered' && cpResult.executionArn && !dryRun) {
        const cpSuccess = await waitForExecution('control-plane', cpResult.executionArn, maxWait);
        if (!cpSuccess) {
            emitAnnotation(
                'error',
                'Control-plane bootstrap FAILED — aborting worker triggers to prevent a broken cluster state. ' +
                'Check the Step Functions execution in the AWS Console and CloudWatch boot logs before retrying.',
                'Bootstrap Aborted',
            );
            logger.fatal(
                'Control-plane execution did not succeed. ' +
                'Worker nodes will NOT be triggered to avoid a partially bootstrapped cluster. ' +
                'Fix the control-plane failure, then re-run the workflow.',
            );
            process.exit(1);
        }
    } else if (cpResult.status === 'skipped') {
        emitAnnotation(
            'error',
            'Control-plane instance not found — cannot trigger workers without join credentials. Aborting.',
            'Bootstrap Aborted',
        );
        logger.fatal(
            'No running control-plane instance was found. ' +
            'Verify the EC2 instance is running and has the correct k8s:bootstrap-role tag.',
        );
        process.exit(1);
    }

    logger.blank();

    for (const workerTarget of targets.slice(1)) {
        const result = await triggerNode(workerTarget, stateMachineArn!, dryRun);
        results.push(result);
        logger.blank();
    }

    const summaryLines: string[] = [
        '## Step Functions Bootstrap Triggers',
        '',
        '| Role | Status | Execution ARN |',
        '|------|--------|---------------|',
    ];

    for (const r of results) {
        const icon = r.status === 'triggered' ? '✅' : '⏭️';
        const execRef = r.executionArn
            ? `\`${r.executionArn.split(':').slice(-1)[0]}\``
            : r.reason ?? '—';
        summaryLines.push(`| ${r.role} | ${icon} ${r.status} | ${execRef} |`);
    }

    summaryLines.push('');
    summaryLines.push(`**Environment:** ${environment}`);
    summaryLines.push(`**State Machine:** \`${stateMachineArn}\``);

    writeSummary(summaryLines.join('\n'));

    const triggeredCount = results.filter((r) => r.status === 'triggered').length;
    logger.header('Trigger Complete');
    logger.success(`${triggeredCount}/${results.length} nodes triggered via Step Functions`);
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    emitAnnotation('error', `Step Functions trigger failed: ${message}`, 'Bootstrap Trigger Error');
    logger.fatal(`Step Functions trigger failed: ${message}`);
});
