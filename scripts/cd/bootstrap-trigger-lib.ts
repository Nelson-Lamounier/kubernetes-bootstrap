import { DescribeExecutionCommand, ListExecutionsCommand } from '@aws-sdk/client-sfn';
import { DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import type { SFNClient } from '@aws-sdk/client-sfn';
import type { EC2Client } from '@aws-sdk/client-ec2';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TriggerTarget {
    role: string;
    execParam: string;
    outputKey: string;
    targetTagValue: string;
}

export interface TriggerResult {
    role: string;
    status: 'triggered' | 'skipped';
    executionArn?: string;
    instanceId?: string;
    reason?: string;
}

// ── Pure functions ────────────────────────────────────────────────────────────

export function buildTargets(prefix: string): TriggerTarget[] {
    return [
        {
            role:           'control-plane',
            execParam:      `${prefix}/bootstrap/execution-id`,
            outputKey:      'cp_execution_id',
            targetTagValue: 'control-plane',
        },
        {
            role:           'general-pool',
            execParam:      `${prefix}/bootstrap/general-pool-execution-id`,
            outputKey:      'general_pool_execution_id',
            targetTagValue: 'general-pool',
        },
        {
            role:           'monitoring-pool',
            execParam:      `${prefix}/bootstrap/monitoring-pool-execution-id`,
            outputKey:      'monitoring_pool_execution_id',
            targetTagValue: 'monitoring-pool',
        },
    ];
}

// ── EC2 helpers ───────────────────────────────────────────────────────────────

export async function resolveInstanceByTag(
    ec2: EC2Client,
    tagValue: string,
): Promise<string | undefined> {
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
        return instances[0]?.InstanceId;
    } catch {
        return undefined;
    }
}

export async function resolveAsgNameByTag(
    ec2: EC2Client,
    tagValue: string,
): Promise<string | undefined> {
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

// ── Step Functions helpers ────────────────────────────────────────────────────

/**
 * Returns the ARN of any RUNNING execution whose name contains `-{role}-`.
 * Returns undefined if none found or the API call fails.
 */
export async function findRunningExecution(
    sfn: SFNClient,
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

const TERMINAL_SUCCESS = new Set(['SUCCEEDED']);
const TERMINAL_FAILURE = new Set(['FAILED', 'TIMED_OUT', 'ABORTED']);

/**
 * Polls a Step Functions execution until it reaches a terminal state or
 * `maxWaitSeconds` elapses.
 *
 * @param sleep - injectable sleep (default: real setTimeout). Pass
 *                `() => Promise.resolve()` in tests to avoid real delays.
 * @param onPoll - optional callback invoked after each poll with the current
 *                 status and elapsed seconds — used for logging in callers.
 */
export async function waitForExecution(
    sfn: SFNClient,
    executionArn: string,
    maxWaitSeconds: number,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    onPoll?: (status: string, elapsedSeconds: number) => void,
): Promise<boolean> {
    const pollInterval = 15_000;
    let waited = 0;

    while (waited < maxWaitSeconds * 1000) {
        let status = 'UNKNOWN';
        try {
            const result = await sfn.send(new DescribeExecutionCommand({ executionArn }));
            status = result.status ?? 'UNKNOWN';
        } catch {
            // transient — keep polling
        }

        onPoll?.(status, waited / 1000);

        if (TERMINAL_SUCCESS.has(status)) return true;
        if (TERMINAL_FAILURE.has(status)) return false;

        await sleep(pollInterval);
        waited += pollInterval;
    }

    return false;
}
