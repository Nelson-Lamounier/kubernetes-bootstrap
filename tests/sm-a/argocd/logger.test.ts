import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock SSM client before module import so the lazy singleton uses the mock
vi.mock('@aws-sdk/client-ssm', () => ({
    SSMClient: vi.fn().mockImplementation(() => ({
        send: vi.fn().mockResolvedValue({}),
    })),
    PutParameterCommand: vi.fn(),
}));

import { BootstrapLogger } from '../../../sm-a/argocd/helpers/logger.js';

// ── helpers ────────────────────────────────────────────────────────────────

/** Spy on stdout and return a function that returns all captured JSON events. */
const captureStdout = () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        lines.push(String(chunk).trim());
        return true;
    });
    const events = () => lines.filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
    return { spy, events };
};

// ── step() ─────────────────────────────────────────────────────────────────

describe('BootstrapLogger.step()', () => {
    let spy: ReturnType<typeof vi.spyOn>;
    let events: () => Record<string, unknown>[];

    beforeEach(() => {
        ({ spy, events } = captureStdout());
    });
    afterEach(() => { spy.mockRestore(); });

    it('emits start then success events on the happy path', async () => {
        const logger = new BootstrapLogger(null, null);
        await logger.step('deploy-key', () => 'value');

        const [start, success] = events();
        expect(start).toMatchObject({ step: 'deploy-key', status: 'start', level: 'info' });
        expect(success).toMatchObject({ step: 'deploy-key', status: 'success', level: 'info' });
    });

    it('returns the value produced by fn', async () => {
        const logger = new BootstrapLogger(null, null);
        const result = await logger.step('compute', () => 42);
        expect(result).toBe(42);
    });

    it('works with async fn and forwards the resolved value', async () => {
        const logger = new BootstrapLogger(null, null);
        const result = await logger.step('async-step', () => Promise.resolve('async-result'));
        expect(result).toBe('async-result');
    });

    it('success event includes a numeric duration_ms', async () => {
        const logger = new BootstrapLogger(null, null);
        await logger.step('timed', () => undefined);
        const success = events()[1];
        expect(typeof success['duration_ms']).toBe('number');
    });

    it('emits fail event and re-throws the original error', async () => {
        const logger = new BootstrapLogger(null, null);
        await expect(
            logger.step('bad-step', () => { throw new Error('boom'); }),
        ).rejects.toThrow('boom');

        const fail = events()[1];
        expect(fail).toMatchObject({ step: 'bad-step', status: 'fail', level: 'error', msg: 'boom' });
    });

    it('fail event includes duration_ms', async () => {
        const logger = new BootstrapLogger(null, null);
        await expect(logger.step('bad', () => { throw new Error('x'); })).rejects.toThrow();
        expect(typeof events()[1]['duration_ms']).toBe('number');
    });

    it('emits exactly two events on success (start + success)', async () => {
        const logger = new BootstrapLogger(null, null);
        await logger.step('two-events', () => undefined);
        expect(events()).toHaveLength(2);
    });

    it('emits exactly two events on failure (start + fail)', async () => {
        const logger = new BootstrapLogger(null, null);
        await expect(logger.step('two-fail-events', () => { throw new Error(); })).rejects.toThrow();
        expect(events()).toHaveLength(2);
    });
});

// ── skip() ─────────────────────────────────────────────────────────────────

describe('BootstrapLogger.skip()', () => {
    let spy: ReturnType<typeof vi.spyOn>;
    let events: () => Record<string, unknown>[];

    beforeEach(() => {
        ({ spy, events } = captureStdout());
    });
    afterEach(() => { spy.mockRestore(); });

    it('emits a skip event with the provided reason', () => {
        const logger = new BootstrapLogger(null, null);
        logger.skip('generate-token', 'ArgoCD CLI not available');

        const [event] = events();
        expect(event).toMatchObject({
            step: 'generate-token',
            status: 'skip',
            level: 'info',
            msg: 'ArgoCD CLI not available',
        });
    });

    it('emits exactly one event', () => {
        const logger = new BootstrapLogger(null, null);
        logger.skip('some-step', 'reason');
        expect(events()).toHaveLength(1);
    });
});
