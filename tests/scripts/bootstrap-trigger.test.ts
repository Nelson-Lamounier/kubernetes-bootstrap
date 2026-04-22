import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SFNClient } from '@aws-sdk/client-sfn';
import type { EC2Client } from '@aws-sdk/client-ec2';
import {
    buildTargets,
    findRunningExecution,
    resolveAsgNameByTag,
    resolveInstanceByTag,
    waitForExecution,
} from '../../scripts/cd/bootstrap-trigger-lib.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const noop = () => Promise.resolve();

const makeSfn  = (send: ReturnType<typeof vi.fn>) => ({ send }) as unknown as SFNClient;
const makeEc2  = (send: ReturnType<typeof vi.fn>) => ({ send }) as unknown as EC2Client;

const ec2Result = (instanceId: string, asgName: string) => ({
    Reservations: [{
        Instances: [{
            InstanceId: instanceId,
            Tags: [{ Key: 'aws:autoscaling:groupName', Value: asgName }],
        }],
    }],
});

// ── buildTargets ──────────────────────────────────────────────────────────────

describe('buildTargets', () => {
    it('returns exactly three targets', () => {
        expect(buildTargets('/k8s/development')).toHaveLength(3);
    });

    it('first target is control-plane', () => {
        const [cp] = buildTargets('/k8s/development');
        expect(cp.role).toBe('control-plane');
        expect(cp.targetTagValue).toBe('control-plane');
    });

    it('uses the prefix in SSM exec params', () => {
        const [cp, gp, mp] = buildTargets('/k8s/production');
        expect(cp.execParam).toBe('/k8s/production/bootstrap/execution-id');
        expect(gp.execParam).toBe('/k8s/production/bootstrap/general-pool-execution-id');
        expect(mp.execParam).toBe('/k8s/production/bootstrap/monitoring-pool-execution-id');
    });

    it('each target has a unique role and outputKey', () => {
        const targets = buildTargets('/k8s/development');
        const roles   = targets.map((t) => t.role);
        const keys    = targets.map((t) => t.outputKey);
        expect(new Set(roles).size).toBe(3);
        expect(new Set(keys).size).toBe(3);
    });
});

// ── resolveInstanceByTag ──────────────────────────────────────────────────────

describe('resolveInstanceByTag', () => {
    let send: ReturnType<typeof vi.fn>;
    beforeEach(() => { send = vi.fn(); });

    it('returns the instance ID when found', async () => {
        send.mockResolvedValue(ec2Result('i-abc123', 'my-asg'));
        expect(await resolveInstanceByTag(makeEc2(send), 'control-plane')).toBe('i-abc123');
    });

    it('returns undefined when no reservations', async () => {
        send.mockResolvedValue({ Reservations: [] });
        expect(await resolveInstanceByTag(makeEc2(send), 'control-plane')).toBeUndefined();
    });

    it('returns undefined when EC2 call throws', async () => {
        send.mockRejectedValue(new Error('AccessDenied'));
        expect(await resolveInstanceByTag(makeEc2(send), 'control-plane')).toBeUndefined();
    });
});

// ── resolveAsgNameByTag ───────────────────────────────────────────────────────

describe('resolveAsgNameByTag', () => {
    let send: ReturnType<typeof vi.fn>;
    beforeEach(() => { send = vi.fn(); });

    it('returns ASG name from instance tags', async () => {
        send.mockResolvedValue(ec2Result('i-abc123', 'k8s-general-asg'));
        expect(await resolveAsgNameByTag(makeEc2(send), 'general-pool')).toBe('k8s-general-asg');
    });

    it('returns undefined when no instance found', async () => {
        send.mockResolvedValue({ Reservations: [] });
        expect(await resolveAsgNameByTag(makeEc2(send), 'general-pool')).toBeUndefined();
    });

    it('returns undefined when ASG tag is absent', async () => {
        send.mockResolvedValue({
            Reservations: [{ Instances: [{ InstanceId: 'i-xyz', Tags: [] }] }],
        });
        expect(await resolveAsgNameByTag(makeEc2(send), 'general-pool')).toBeUndefined();
    });

    it('returns undefined on API error', async () => {
        send.mockRejectedValue(new Error('throttled'));
        expect(await resolveAsgNameByTag(makeEc2(send), 'general-pool')).toBeUndefined();
    });
});

// ── findRunningExecution ──────────────────────────────────────────────────────

describe('findRunningExecution', () => {
    let send: ReturnType<typeof vi.fn>;
    beforeEach(() => { send = vi.fn(); });

    it('returns undefined when no executions are running', async () => {
        send.mockResolvedValue({ executions: [] });
        expect(await findRunningExecution(makeSfn(send), 'arn:aws:states:eu-west-1:123:sm', 'control-plane')).toBeUndefined();
    });

    it('returns the ARN of the matching execution', async () => {
        send.mockResolvedValue({
            executions: [
                { name: 'github-control-plane-1700000000', executionArn: 'arn:aws:states:...:exec-cp' },
                { name: 'github-general-pool-1700000001',  executionArn: 'arn:aws:states:...:exec-gp' },
            ],
        });
        expect(await findRunningExecution(makeSfn(send), 'arn:...', 'control-plane'))
            .toBe('arn:aws:states:...:exec-cp');
    });

    it('does not match an execution for a different role', async () => {
        send.mockResolvedValue({
            executions: [{ name: 'github-general-pool-1700000001', executionArn: 'arn:...:exec-gp' }],
        });
        expect(await findRunningExecution(makeSfn(send), 'arn:...', 'control-plane')).toBeUndefined();
    });

    it('returns undefined when SFN call throws (safe dedup failure)', async () => {
        send.mockRejectedValue(new Error('AccessDenied'));
        expect(await findRunningExecution(makeSfn(send), 'arn:...', 'control-plane')).toBeUndefined();
    });

    it('passes statusFilter RUNNING to the API', async () => {
        send.mockResolvedValue({ executions: [] });
        await findRunningExecution(makeSfn(send), 'arn:...', 'control-plane');
        const [cmd] = send.mock.calls[0] as [{ input: { statusFilter: string } }];
        expect(cmd.input.statusFilter).toBe('RUNNING');
    });
});

// ── waitForExecution ──────────────────────────────────────────────────────────

describe('waitForExecution', () => {
    let send: ReturnType<typeof vi.fn>;
    beforeEach(() => { send = vi.fn(); });

    it('returns true when execution is SUCCEEDED', async () => {
        send.mockResolvedValue({ status: 'SUCCEEDED' });
        expect(await waitForExecution(makeSfn(send), 'arn:...exec', 60, noop)).toBe(true);
    });

    it('returns false when execution is FAILED', async () => {
        send.mockResolvedValue({ status: 'FAILED' });
        expect(await waitForExecution(makeSfn(send), 'arn:...exec', 60, noop)).toBe(false);
    });

    it('returns false when execution is TIMED_OUT', async () => {
        send.mockResolvedValue({ status: 'TIMED_OUT' });
        expect(await waitForExecution(makeSfn(send), 'arn:...exec', 60, noop)).toBe(false);
    });

    it('returns false when execution is ABORTED', async () => {
        send.mockResolvedValue({ status: 'ABORTED' });
        expect(await waitForExecution(makeSfn(send), 'arn:...exec', 60, noop)).toBe(false);
    });

    it('keeps polling until a terminal state is reached', async () => {
        send
            .mockResolvedValueOnce({ status: 'RUNNING' })
            .mockResolvedValueOnce({ status: 'RUNNING' })
            .mockResolvedValue({ status: 'SUCCEEDED' });

        expect(await waitForExecution(makeSfn(send), 'arn:...exec', 60, noop)).toBe(true);
        expect(send).toHaveBeenCalledTimes(3);
    });

    it('returns false when maxWaitSeconds elapses before terminal state', async () => {
        // Each poll advances waited by pollInterval (15_000 ms).
        // With maxWaitSeconds=0, the while condition fails immediately.
        send.mockResolvedValue({ status: 'RUNNING' });
        expect(await waitForExecution(makeSfn(send), 'arn:...exec', 0, noop)).toBe(false);
        expect(send).not.toHaveBeenCalled();
    });

    it('calls onPoll with status and elapsed time each iteration', async () => {
        send
            .mockResolvedValueOnce({ status: 'RUNNING' })
            .mockResolvedValue({ status: 'SUCCEEDED' });

        const polls: [string, number][] = [];
        await waitForExecution(makeSfn(send), 'arn:...exec', 60, noop, (s, e) => { polls.push([s, e]); });

        expect(polls[0]).toEqual(['RUNNING', 0]);
        expect(polls[1]).toEqual(['SUCCEEDED', 15]);
    });

    it('treats a transient API error as UNKNOWN and continues polling', async () => {
        send
            .mockRejectedValueOnce(new Error('transient'))
            .mockResolvedValue({ status: 'SUCCEEDED' });

        expect(await waitForExecution(makeSfn(send), 'arn:...exec', 60, noop)).toBe(true);
        expect(send).toHaveBeenCalledTimes(2);
    });
});
