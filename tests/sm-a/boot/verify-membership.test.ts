import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../sm-a/boot/steps/common.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../sm-a/boot/steps/common.js')>();
    return {
        ...actual,
        run:    vi.fn().mockReturnValue({ ok: true, stdout: '', stderr: '', code: 0 }),
        ssmGet: vi.fn().mockResolvedValue(''),
        ssmPut: vi.fn().mockResolvedValue(undefined),
        sleep:  vi.fn().mockResolvedValue(undefined),
        info:   vi.fn(),
        warn:   vi.fn(),
        error:  vi.fn(),
    };
});

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, existsSync: vi.fn().mockReturnValue(false) };
});

import { buildNodeLabels, parseLabelString } from '../../../sm-a/boot/steps/worker.js';

beforeEach(() => { vi.clearAllMocks(); });

// ── parseLabelString (pure) ────────────────────────────────────────────────

describe('parseLabelString', () => {
    it('parses single key=value pair', () => {
        expect(parseLabelString('workload=frontend')).toEqual({ workload: 'frontend' });
    });

    it('parses multiple comma-separated pairs', () => {
        expect(parseLabelString('workload=frontend,environment=development'))
            .toEqual({ workload: 'frontend', environment: 'development' });
    });

    it('returns empty object for empty string', () => {
        expect(parseLabelString('')).toEqual({});
    });

    it('strips surrounding whitespace from keys and values', () => {
        expect(parseLabelString(' workload = frontend , environment = dev '))
            .toEqual({ workload: 'frontend', environment: 'dev' });
    });

    it('handles node-pool label correctly', () => {
        expect(parseLabelString('role=worker,node-pool=general'))
            .toEqual({ role: 'worker', 'node-pool': 'general' });
    });
});

// ── node-pool label drift detection ───────────────────────────────────────
// These tests verify the buildNodeLabels + parseLabelString integration
// that drives the drift-correction logic inside verifyClusterMembership.

describe('node-pool label drift detection (via buildNodeLabels)', () => {

    it('detects missing node-pool label when NODE_POOL is set', () => {
        const cfg = {
            ssmPrefix: '/k8s/development', awsRegion: 'eu-west-1',
            environment: 'development', logGroupName: '',
            nodeLabel: 'workload=frontend,environment=development',
            nodePool: 'general',
            joinMaxRetries: 3, joinRetryInterval: 0,
        };
        const expected = parseLabelString(buildNodeLabels(cfg));
        const actual   = parseLabelString('workload=frontend,environment=development'); // node-pool missing

        const drift = Object.entries(expected).filter(([k, v]) => actual[k] !== v);
        expect(drift.length).toBeGreaterThan(0);
        expect(drift.some(([k]) => k === 'node-pool')).toBe(true);
    });

    it('detects no drift when node-pool already matches', () => {
        const cfg = {
            ssmPrefix: '/k8s/development', awsRegion: 'eu-west-1',
            environment: 'development', logGroupName: '',
            nodeLabel: 'workload=frontend,environment=development',
            nodePool: 'general',
            joinMaxRetries: 3, joinRetryInterval: 0,
        };
        const expected = parseLabelString(buildNodeLabels(cfg));
        const actual   = parseLabelString('workload=frontend,environment=development,node-pool=general');

        const drift = Object.entries(expected).filter(([k, v]) => actual[k] !== v);
        expect(drift).toHaveLength(0);
    });
});
