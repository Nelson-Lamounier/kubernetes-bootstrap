import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../sm-a/boot/steps/common.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../sm-a/boot/steps/common.js')>();
    return {
        ...actual,
        run:   vi.fn().mockReturnValue({ ok: true, stdout: '', stderr: '', code: 0 }),
        info:  vi.fn(),
        warn:  vi.fn(),
        error: vi.fn(),
    };
});

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        existsSync: vi.fn().mockReturnValue(false),
    };
});

import { existsSync } from 'node:fs';
import { run } from '../../../sm-a/boot/steps/common.js';
import {
    ensureDataDirectories,
    resolveNvmeDevice,
} from '../../../sm-a/boot/steps/control_plane.js';

const mockRun         = vi.mocked(run);
const mockExistsSync  = vi.mocked(existsSync);

const ok   = (stdout = '') => ({ ok: true,  stdout, stderr: '', code: 0 });

let tmpDir: string;

beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), 'ebs-test-'));
});

afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});

// ── resolveNvmeDevice ──────────────────────────────────────────────────────

describe('resolveNvmeDevice', () => {
    it('returns /dev/xvdf when it exists', () => {
        mockExistsSync.mockReturnValue(true);
        expect(resolveNvmeDevice()).toBe('/dev/xvdf');
    });

    it('returns first nvme device from ls when xvdf is absent', () => {
        mockExistsSync.mockReturnValue(false);
        mockRun.mockReturnValue(ok('sda\nnvme1n1\nnvme2n1\n'));
        expect(resolveNvmeDevice()).toBe('/dev/nvme1n1');
    });

    it('returns empty string when no suitable device is found', () => {
        mockExistsSync.mockReturnValue(false);
        mockRun.mockReturnValue(ok('sda\nsdb\n'));
        expect(resolveNvmeDevice()).toBe('');
    });
});

// ── ensureDataDirectories ──────────────────────────────────────────────────

describe('ensureDataDirectories', () => {
    it('creates kubernetes, k8s-bootstrap, and app-deploy subdirectories', async () => {
        ensureDataDirectories(tmpDir);

        // existsSync is mocked globally — use readdirSync (not mocked) to verify real FS state
        const { readdirSync } = await import('node:fs');
        const entries = readdirSync(tmpDir);
        expect(entries).toContain('kubernetes');
        expect(entries).toContain('k8s-bootstrap');
        expect(entries).toContain('app-deploy');
    });

    it('calls chown and chmod on app-deploy (non-fatal on failure)', () => {
        mockRun.mockReturnValue({ ok: false, stdout: '', stderr: "invalid group 'ssm-user'", code: 1 });
        // Must not throw even when chown fails
        expect(() => ensureDataDirectories(tmpDir)).not.toThrow();
    });

    it('passes correct paths to chown and chmod', () => {
        ensureDataDirectories(tmpDir);
        const cmds = mockRun.mock.calls.map(c => (c[0] as string[]).join(' '));
        expect(cmds.some(c => c.includes('chown') && c.includes('app-deploy'))).toBe(true);
        expect(cmds.some(c => c.includes('chmod') && c.includes('app-deploy'))).toBe(true);
    });
});
