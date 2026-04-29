import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerConfig } from '../../../sm-a/boot/steps/worker.js';

// Mock common.js BEFORE importing the module under test
vi.mock('../../../sm-a/boot/steps/common.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../sm-a/boot/steps/common.js')>();
    return {
        ...actual,
        run:    vi.fn(),
        ssmGet: vi.fn(),
        ssmPut: vi.fn(),
        sleep:  vi.fn().mockResolvedValue(undefined),
        info:   vi.fn(),
        warn:   vi.fn(),
        error:  vi.fn(),
    };
});

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        existsSync:  vi.fn().mockReturnValue(false),
        unlinkSync:  vi.fn(),
    };
});

import { existsSync } from 'node:fs';
import { run, ssmGet } from '../../../sm-a/boot/steps/common.js';
import {
    buildNodeLabels,
    checkCaMismatch,
    computeLocalCaHash,
    parseLabelString,
    resolveControlPlaneEndpoint,
    waitForKubelet,
} from '../../../sm-a/boot/steps/worker.js';

const mockRun    = vi.mocked(run);
const mockSsmGet = vi.mocked(ssmGet);
const mockExistsSyncFs = vi.mocked(existsSync);

const ok   = (stdout = '', stderr = '') => ({ ok: true,  stdout, stderr, code: 0 });
const fail = (stdout = '', stderr = '') => ({ ok: false, stdout, stderr, code: 1 });

const baseCfg: WorkerConfig = {
    ssmPrefix:         '/k8s/development',
    awsRegion:         'eu-west-1',
    environment:       'development',
    logGroupName:      '',
    nodeLabel:         'role=worker',
    nodePool:          '',
    joinMaxRetries:    3,
    joinRetryInterval: 0,
};

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

// ── parseLabelString (pure) ────────────────────────────────────────────────

describe('parseLabelString', () => {
    it('parses a single label', () => {
        expect(parseLabelString('workload=frontend')).toEqual({ workload: 'frontend' });
    });

    it('parses comma-separated labels', () => {
        expect(parseLabelString('workload=frontend,environment=development'))
            .toEqual({ workload: 'frontend', environment: 'development' });
    });

    it('returns empty object for empty string', () => {
        expect(parseLabelString('')).toEqual({});
    });

    it('strips whitespace from keys and values', () => {
        expect(parseLabelString(' workload = frontend , environment = dev '))
            .toEqual({ workload: 'frontend', environment: 'dev' });
    });
});

// ── buildNodeLabels (pure) ─────────────────────────────────────────────────

describe('buildNodeLabels', () => {
    it('returns NODE_LABEL unchanged when NODE_POOL is empty (legacy path)', () => {
        const cfg = { ...baseCfg, nodeLabel: 'workload=frontend,environment=development', nodePool: '' };
        expect(buildNodeLabels(cfg)).toBe('workload=frontend,environment=development');
    });

    it('appends node-pool when NODE_POOL is set', () => {
        const cfg = { ...baseCfg, nodeLabel: 'workload=frontend', nodePool: 'general' };
        expect(buildNodeLabels(cfg)).toBe('workload=frontend,node-pool=general');
    });

    it('does not duplicate node-pool when already present in NODE_LABEL', () => {
        const cfg = { ...baseCfg, nodeLabel: 'workload=frontend,node-pool=general', nodePool: 'general' };
        const result = buildNodeLabels(cfg);
        expect(result.split(',').filter(l => l === 'node-pool=general')).toHaveLength(1);
    });

    it('builds monitoring pool label', () => {
        const cfg = { ...baseCfg, nodeLabel: 'role=worker', nodePool: 'monitoring' };
        expect(buildNodeLabels(cfg)).toBe('role=worker,node-pool=monitoring');
    });

    it('includes default role label when only NODE_POOL is set', () => {
        const cfg = { ...baseCfg, nodeLabel: 'role=worker', nodePool: 'general' };
        const result = buildNodeLabels(cfg);
        expect(result).toContain('role=worker');
        expect(result).toContain('node-pool=general');
    });
});

// ── computeLocalCaHash ─────────────────────────────────────────────────────

describe('computeLocalCaHash', () => {
    it('returns sha256:<hash> on success', () => {
        mockRun.mockReturnValue(ok('abc123def456\n'));
        expect(computeLocalCaHash()).toBe('sha256:abc123def456');
    });

    it('returns empty string when openssl fails', () => {
        mockRun.mockReturnValue(fail());
        expect(computeLocalCaHash()).toBe('');
    });
});

// ── checkCaMismatch ────────────────────────────────────────────────────────

describe('checkCaMismatch', () => {
    it('returns false when no local CA cert exists', async () => {
        mockExistsSyncFs.mockReturnValue(false);
        expect(await checkCaMismatch(baseCfg)).toBe(false);
    });

    it('returns false when hashes match', async () => {
        mockExistsSyncFs.mockReturnValue(true);
        mockRun.mockReturnValue(ok('abc123\n'));
        mockSsmGet.mockResolvedValue('sha256:abc123');
        expect(await checkCaMismatch(baseCfg)).toBe(false);
    });

    it('returns true and runs kubeadm reset on mismatch', async () => {
        mockExistsSyncFs.mockReturnValue(true);
        mockRun.mockReturnValue(ok('old_hash\n'));
        mockSsmGet.mockResolvedValue('sha256:new_hash');
        const result = await checkCaMismatch(baseCfg);
        expect(result).toBe(true);
        expect(mockRun).toHaveBeenCalledWith(expect.arrayContaining(['kubeadm', 'reset']), expect.anything());
    });
});

// ── resolveControlPlaneEndpoint ────────────────────────────────────────────

describe('resolveControlPlaneEndpoint', () => {
    it('returns endpoint immediately when SSM has it', async () => {
        mockSsmGet.mockResolvedValue('k8s-api.k8s.internal:6443');
        expect(await resolveControlPlaneEndpoint(baseCfg)).toBe('k8s-api.k8s.internal:6443');
    });

    it('throws when SSM never returns an endpoint (tiny timeout)', async () => {
        // Make Date.now() return a value past the deadline on the while-check
        // so the loop exits immediately and throws the expected error
        const now = Date.now();
        let call = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => call++ === 0 ? now : now + 400_000);

        mockSsmGet.mockResolvedValue('');
        await expect(resolveControlPlaneEndpoint({ ...baseCfg })).rejects.toThrow('not satisfied after');
    });
});

// ── waitForKubelet ─────────────────────────────────────────────────────────

describe('waitForKubelet', () => {
    it('returns immediately when kubelet is active and config file exists', async () => {
        mockExistsSyncFs.mockReturnValue(true);
        mockRun.mockReturnValue(ok());
        await expect(waitForKubelet()).resolves.toBeUndefined();
    });

    it('retries until kubelet becomes active', async () => {
        mockExistsSyncFs.mockReturnValue(true);
        mockRun
            .mockReturnValueOnce(fail())
            .mockReturnValueOnce(fail())
            .mockReturnValue(ok());
        await waitForKubelet();
        expect(mockRun).toHaveBeenCalledTimes(3);
    });
});
