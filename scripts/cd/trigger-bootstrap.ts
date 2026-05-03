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
 * Each execution is started with a synthetic EventBridge-style payload so the
 * Lambda router resolves the correct role:
 *
 * ```json
 * {
 *   "detail": {
 *     "EC2InstanceId": "<instance-id>",
 *     "AutoScalingGroupName": "<asg-name>"
 *   }
 * }
 * ```
 *
 * Usage:
 *   npx tsx trigger-bootstrap.ts \
 *     --environment development \
 *     [--region eu-west-1] \
 *     [--max-wait 600]
 *
 * Environment Variables (overridden by CLI flags):
 *   DEPLOY_ENVIRONMENT — environment name
 *   AWS_REGION         — AWS region (default: eu-west-1)
 *
 * Exit Codes:
 *   0 — success (all triggered nodes started; CP may have failed but workers still triggered)
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
} from '@aws-sdk/client-sfn';
import {
    DescribeInstanceInformationCommand,
    GetParameterCommand,
    PutParameterCommand,
    SSMClient,
} from '@aws-sdk/client-ssm';
import { parseArgs, buildAwsConfig } from '@nelsonlamounier/cdk-deploy-scripts/aws.js';
import { setOutput, writeSummary, emitAnnotation } from '@nelsonlamounier/cdk-deploy-scripts/github.js';
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
            name: 'max-wait',
            description: 'Max seconds to wait for control-plane execution (default: 1200)',
            hasValue: true,
            default: '1200',
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
    /** Bootstrap role label — matches `k8s:bootstrap-role` ASG tag value */
    role: string;
    /** SSM parameter path to publish the execution ARN for the observer job */
    execParam: string;
    /** GitHub Actions output key */
    outputKey: string;
    /** Value of the k8s:bootstrap-role tag used for EC2 tag-based discovery */
    targetTagValue: string;
}

/**
 * Build the ordered list of node targets to trigger.
 *
 * Worker targets have been updated to the new ASG pool names:
 *   `general-pool`    — t3.small Spot; hosts Next.js, tucaken-app, and ArgoCD
 *   `monitoring-pool` — t3.medium Spot; hosts the observability stack
 *
 * @param prefix - SSM prefix (e.g. `/k8s/development`)
 */
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

/**
 * Resolve a running EC2 instance ID by its `k8s:bootstrap-role` tag.
 *
 * Uses EC2 DescribeInstances filtered by tag + running state. This ensures
 * we never target a stale instance ID left behind in SSM when an ASG recycles.
 *
 * @param tagValue - Value of the `k8s:bootstrap-role` tag to match
 * @returns Instance ID, or undefined if no running instance was found
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

        // There should be exactly one running instance per role
        return instances[0].InstanceId;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`EC2 describe-instances failed for tag k8s:bootstrap-role=${tagValue}: ${message}`);
        return undefined;
    }
}

/**
 * Resolve the ASG name for an instance by its `k8s:bootstrap-role` tag.
 *
 * Step Functions router Lambda reads `AutoScalingGroupName` from the event
 * payload to fetch ASG tags, so we must supply the real ASG name.
 *
 * @param tagValue - Value of the `k8s:bootstrap-role` tag to match
 * @returns ASG name, or undefined if not found
 */
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

/** Sleep for a given number of milliseconds. */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Verify the SSM agent on an instance is online before firing Step Functions.
 *
 * If the agent is `ConnectionLost` or `Inactive`, triggers an EC2 reboot and
 * re-polls for up to `maxRecoverySeconds` seconds.
 *
 * **Throws** a descriptive `Error` on every irrecoverable failure — callers
 * must NOT continue after this function rejects.
 *
 * @param instanceId         - EC2 instance to check
 * @param maxRecoverySeconds - Max seconds to wait after reboot (default 180)
 * @throws {Error} If the SSM agent cannot be confirmed online
 */
async function checkSsmAgentHealth(
    instanceId: string,
    maxRecoverySeconds = 180,
): Promise<void> {
    /** Fetch the current SSM PingStatus for the instance. */
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

    if (initialStatus === 'Online') return; // agent is ready — proceed

    // ── Recovery: reboot the instance to restart the SSM agent ──────────────
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

        // Poll every 15 s for up to maxRecoverySeconds
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
                return; // recovered — proceed
            }
        }

        throw new Error(
            `FATAL: SSM agent on ${instanceId} (${initialStatus}) did not come online within ` +
            `${maxRecoverySeconds}s after reboot. Aborting deployment — ` +
            'check CloudWatch agent logs and EC2 system status checks before retrying.',
        );
    }

    // NotYetRegistered / Unknown — cannot recover automatically.
    throw new Error(
        `FATAL: Unexpected SSM agent PingStatus '${initialStatus}' on ${instanceId}. ` +
        'This instance has never registered with SSM or its registration has been lost. ' +
        'Verify the IAM role, SSM agent installation, and VPC endpoints before retrying.',
    );
}

// =============================================================================
// Core Functions
// =============================================================================

interface TriggerResult {
    role: string;
    /** `triggered` = SF execution started. `skipped` = no instance / config missing. */
    status: 'triggered' | 'skipped';
    executionArn?: string;
    instanceId?: string;
    reason?: string;
}

/**
 * Start a Step Functions execution for a single node role.
 *
 * Resolves instance ID from EC2 tags, verifies SSM agent health, then starts
 * an execution against the bootstrap orchestrator state machine.
 *
 * The execution input is a synthetic EventBridge-style payload:
 * ```json
 * { "detail": { "EC2InstanceId": "...", "AutoScalingGroupName": "..." } }
 * ```
 * This allows the Lambda router inside the state machine to resolve role tags
 * from the ASG without any code changes.
 *
 * @param target        - Target definition (role, SSM param paths, output key)
 * @param stateMachineArn - ARN of the Step Functions state machine
 * @returns TriggerResult with execution ARN on success
 */
async function triggerNode(
    target: TriggerTarget,
    stateMachineArn: string,
): Promise<TriggerResult> {
    logger.task(`${target.role}`);

    // 1. Resolve instance ID from EC2 tags (live — never stale)
    const instanceId = await resolveInstanceByTag(target.targetTagValue);
    if (!instanceId) {
        logger.info(`[SKIP] No running instance with tag k8s:bootstrap-role=${target.targetTagValue}`);
        return { role: target.role, status: 'skipped', reason: 'no running instance' };
    }
    logger.keyValue('Instance', instanceId);

    // 2. Resolve ASG name (required by the Lambda router)
    const asgName = await resolveAsgNameByTag(target.targetTagValue);
    if (!asgName) {
        logger.warn(`[SKIP] Could not resolve ASG name for tag ${target.targetTagValue}`);
        return { role: target.role, status: 'skipped', reason: 'no ASG name' };
    }
    logger.keyValue('ASG', asgName);

    // 3. Verify SSM agent is online — auto-reboot and retry if ConnectionLost.
    //    Throws on any irrecoverable failure, aborting the deployment.
    await checkSsmAgentHealth(instanceId);

    // 4. Start Step Functions execution with a synthetic EventBridge payload
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
                // Unique name prevents duplicate executions on re-run within the same minute
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

    // 5. Publish execution ARN to SSM for the observer job
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
        // Non-fatal — observer can still use GitHub Actions outputs
        logger.warn(`Could not publish execution ARN to ${target.execParam}`);
    }

    // 6. Set GitHub Actions output
    setOutput(target.outputKey, executionArn);

    logger.success(`${target.role} Step Functions execution started`);
    return { role: target.role, status: 'triggered', executionArn, instanceId };
}

/** Terminal Step Functions execution statuses */
const TERMINAL_SUCCESS = new Set(['SUCCEEDED']);
const TERMINAL_FAILURE = new Set(['FAILED', 'TIMED_OUT', 'ABORTED']);

/**
 * Poll a Step Functions execution until it reaches a terminal state or times out.
 *
 * @param role           - Human-readable label for log messages
 * @param executionArn   - ARN of the execution to poll
 * @param maxWaitSeconds - Maximum seconds to wait before giving up
 * @returns true if execution succeeded, false otherwise
 */
async function waitForExecution(
    role: string,
    executionArn: string,
    maxWaitSeconds: number,
): Promise<boolean> {
    const pollInterval = 15_000; // 15 seconds
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
    logger.blank();

    // ── Resolve State Machine ARN from SSM ────────────────────────────────────
    // The CDK stack stores `{ssmPrefix}/bootstrap/state-machine-arn` after deploy.
    const smArnParam = `${ssmPrefix}/bootstrap/state-machine-arn`;
    const stateMachineArn = await getParam(smArnParam);
    if (!stateMachineArn) {
        emitAnnotation(
            'error',
            `State machine ARN not found at SSM path '${smArnParam}'. ` +
            'Deploy the K8s SSM Automation stack (_deploy-kubernetes.yml) first.',
            'Bootstrap Config Error',
        );
        logger.fatal(
            `State machine ARN not found at ${smArnParam}. ` +
            'Run the Kubernetes CDK deployment pipeline to provision the Step Functions stack.',
        );
    }
    logger.keyValue('State Machine ARN', stateMachineArn!);
    logger.blank();

    const targets = buildTargets(ssmPrefix);
    const results: TriggerResult[] = [];

    // ── Step 1: Trigger control-plane ─────────────────────────────────────────
    const cpTarget = targets[0];
    const cpResult = await triggerNode(cpTarget, stateMachineArn!);
    results.push(cpResult);
    logger.blank();

    // ── Step 2: Wait for control-plane to complete ────────────────────────────
    //
    // Workers MUST NOT start until the control-plane exports join credentials
    // (join token, CA hash, API server endpoint) to SSM Parameter Store.
    // Starting workers against a failed control-plane means they will never
    // join — leaving the cluster nodeless and the site down.
    if (cpResult.status === 'triggered' && cpResult.executionArn) {
        const cpSuccess = await waitForExecution('control-plane', cpResult.executionArn, maxWait);
        if (!cpSuccess) {
            // HARD FAILURE — abort before workers are triggered.
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

    // ── Step 3: Trigger worker nodes ──────────────────────────────────────────
    for (const workerTarget of targets.slice(1)) {
        const result = await triggerNode(workerTarget, stateMachineArn!);
        results.push(result);
        logger.blank();
    }

    // ── Step 4: Write GitHub step summary ─────────────────────────────────────
    const summaryLines: string[] = [
        '## Step Functions Bootstrap Triggers',
        '',
        '| Role | Status | Execution ARN |',
        '|------|--------|---------------|',
    ];

    for (const r of results) {
        const icon = r.status === 'triggered' ? '✅' : '⏭️';
        const execRef = r.executionArn
            ? `\`${r.executionArn.split(':').slice(-1)[0]}\`` // short UUID suffix
            : r.reason ?? '—';
        summaryLines.push(`| ${r.role} | ${icon} ${r.status} | ${execRef} |`);
    }

    summaryLines.push('');
    summaryLines.push(`**Environment:** ${environment}`);
    summaryLines.push(`**State Machine:** \`${stateMachineArn}\``);

    writeSummary(summaryLines.join('\n'));

    // ── Done ──────────────────────────────────────────────────────────────────
    const triggeredCount = results.filter((r) => r.status === 'triggered').length;
    logger.header('Trigger Complete');
    logger.success(`${triggeredCount}/${results.length} nodes triggered via Step Functions`);
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    emitAnnotation('error', `Step Functions trigger failed: ${message}`, 'Bootstrap Trigger Error');
    logger.fatal(`Step Functions trigger failed: ${message}`);
});
