import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SSMClient } from '@aws-sdk/client-ssm';

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, execFileSync: vi.fn().mockReturnValue('') };
});

vi.mock('../../scripts/lib/logger.js', () => ({
    default: { info: vi.fn(), warn: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

import { execFileSync } from 'node:child_process';
import logger from '../../scripts/lib/logger.js';
import {
    EDGE_REGION,
    FALLBACK_ADMIN_API,
    FALLBACK_PUBLIC_API,
    ensureNamespace,
    resolveBffUrls,
    resolveSecrets,
    syncFromS3,
    upsertConfigmap,
    upsertSecret,
} from '../../scripts/lib/deploy-helpers.js';

const mockExec   = vi.mocked(execFileSync);
const mockLogger = vi.mocked(logger);

// Helper: build a minimal SSMClient mock
function ssmClient(getValue: (path: string) => string | null): SSMClient {
    return {
        send: vi.fn().mockImplementation((cmd: { input: { Name: string } }) => {
            const value = getValue(cmd.input.Name);
            if (value === null) {
                const err = Object.assign(new Error('ParameterNotFound'), { name: 'ParameterNotFound' });
                return Promise.reject(err);
            }
            return Promise.resolve({ Parameter: { Value: value } });
        }),
    } as unknown as SSMClient;
}

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
    vi.clearAllMocks();
    savedEnv = { ...process.env };
});
afterEach(() => {
    process.env = savedEnv;
});

// ── resolveSecrets ─────────────────────────────────────────────────────────

describe('resolveSecrets', () => {
    it('resolves a single SSM parameter', async () => {
        const client = ssmClient((p) => p === '/k8s/dev/grafana-pw' ? 'super-secret' : null);
        const result = await resolveSecrets(client, '/k8s/dev', { 'grafana-pw': 'GRAFANA_PW' });
        expect(result['GRAFANA_PW']).toBe('super-secret');
    });

    it('resolves multiple parameters', async () => {
        const client = ssmClient((p) => ({ '/p/a': 'val-a', '/p/b': 'val-b' }[p] ?? null));
        const result = await resolveSecrets(client, '/p', { a: 'A', b: 'B' });
        expect(result).toEqual({ A: 'val-a', B: 'val-b' });
    });

    it('omits key when ParameterNotFound', async () => {
        const client = ssmClient(() => null);
        const result = await resolveSecrets(client, '/p', { 'missing': 'MISSING' });
        expect(result['MISSING']).toBeUndefined();
    });

    it('omits key on generic SSM error', async () => {
        const client = { send: vi.fn().mockRejectedValue(new Error('AccessDenied')) } as unknown as SSMClient;
        const result = await resolveSecrets(client, '/p', { 'x': 'X' });
        expect(result['X']).toBeUndefined();
    });

    it('uses env var override and skips SSM', async () => {
        process.env['GRAFANA_PW'] = 'env-override';
        const client = ssmClient(() => 'ssm-value');
        const result = await resolveSecrets(client, '/p', { 'grafana-pw': 'GRAFANA_PW' });
        expect(result['GRAFANA_PW']).toBe('env-override');
        expect((client.send as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('does not treat empty env var as override', async () => {
        process.env['GRAFANA_PW'] = '';
        const client = ssmClient(() => 'ssm-value');
        const result = await resolveSecrets(client, '/p', { 'grafana-pw': 'GRAFANA_PW' });
        expect(result['GRAFANA_PW']).toBe('ssm-value');
    });

    it('does not treat __VAR__ placeholder as override', async () => {
        process.env['GRAFANA_PW'] = '__GRAFANA_PW__';
        const client = ssmClient(() => 'real-value');
        const result = await resolveSecrets(client, '/p', { 'grafana-pw': 'GRAFANA_PW' });
        expect(result['GRAFANA_PW']).toBe('real-value');
    });
});

// ── resolveBffUrls ─────────────────────────────────────────────────────────

describe('resolveBffUrls', () => {
    it('EDGE_REGION is us-east-1', () => {
        expect(EDGE_REGION).toBe('us-east-1');
    });

    it('resolves both URLs from SSM', async () => {
        const client = ssmClient((p) => ({
            '/bedrock-dev/admin-api-url':  'https://admin.example.com',
            '/bedrock-dev/public-api-url': 'https://api.example.com',
        }[p] ?? null));
        const result = await resolveBffUrls('dev', client);
        expect(result.adminApiUrl).toBe('https://admin.example.com');
        expect(result.publicApiUrl).toBe('https://api.example.com');
    });

    it('uses correct /bedrock-{shortEnv}/ prefix', async () => {
        const client = ssmClient((p) => ({
            '/bedrock-prd/admin-api-url':  'https://admin.nelsonlamounier.com',
            '/bedrock-prd/public-api-url': 'https://api.nelsonlamounier.com',
        }[p] ?? null));
        const result = await resolveBffUrls('prd', client);
        expect(result.adminApiUrl).toBe('https://admin.nelsonlamounier.com');
    });

    it('falls back to in-cluster DNS when both SSM params missing', async () => {
        const client = ssmClient(() => null);
        const result = await resolveBffUrls('dev', client);
        expect(result.adminApiUrl).toBe(FALLBACK_ADMIN_API);
        expect(result.publicApiUrl).toBe(FALLBACK_PUBLIC_API);
    });

    it('falls back admin independently when only public-api-url exists', async () => {
        const client = ssmClient((p) =>
            p === '/bedrock-dev/public-api-url' ? 'https://api.example.com' : null,
        );
        const result = await resolveBffUrls('dev', client);
        expect(result.adminApiUrl).toBe(FALLBACK_ADMIN_API);
        expect(result.publicApiUrl).toBe('https://api.example.com');
    });

    it('honours env override (inherited from resolveSecrets)', async () => {
        process.env['ADMIN_API_URL']  = 'https://env-admin.example.com';
        process.env['PUBLIC_API_URL'] = 'https://env-public.example.com';
        const client = ssmClient(() => 'should-not-be-called');
        const result = await resolveBffUrls('dev', client);
        expect(result.adminApiUrl).toBe('https://env-admin.example.com');
        expect(result.publicApiUrl).toBe('https://env-public.example.com');
    });
});

// ── ensureNamespace ────────────────────────────────────────────────────────

describe('ensureNamespace', () => {
    it('no-op when namespace already exists', () => {
        mockExec.mockReturnValue('nextjs-app   Active   5d');
        ensureNamespace('/etc/kubernetes/admin.conf', 'nextjs-app');
        expect(mockExec).toHaveBeenCalledTimes(1);
        expect(mockExec.mock.calls[0][1]).toContain('--ignore-not-found');
    });

    it('creates namespace when not found', () => {
        mockExec.mockReturnValueOnce('').mockReturnValue('');
        ensureNamespace('/etc/kubernetes/admin.conf', 'new-ns');
        expect(mockExec).toHaveBeenCalledTimes(2);
        expect(mockExec.mock.calls[1][1]).toContain('create');
        expect(mockExec.mock.calls[1][1]).toContain('new-ns');
    });

    it('propagates kubectl error (e.g. auth failure)', () => {
        mockExec.mockImplementation(() => { throw new Error('connection refused'); });
        expect(() => ensureNamespace('/etc/kubernetes/admin.conf', 'ns')).toThrow('connection refused');
    });
});

// ── upsertSecret ───────────────────────────────────────────────────────────

describe('upsertSecret', () => {
    it('passes correct namespace and name to kubectl', () => {
        mockExec.mockReturnValue('');
        upsertSecret('/etc/kubernetes/admin.conf', 'my-secret', 'my-ns', { KEY: 'value' });
        const createArgs = mockExec.mock.calls[0][1] as string[];
        expect(createArgs).toContain('my-secret');
        expect(createArgs).toContain('-n');
        expect(createArgs).toContain('my-ns');
    });

    it('includes all --from-literal pairs as raw values (kubectl handles base64)', () => {
        mockExec.mockReturnValue('');
        upsertSecret('/etc/kubernetes/admin.conf', 's', 'ns', { A: 'alpha', B: 'beta' });
        const createArgs = mockExec.mock.calls[0][1] as string[];
        expect(createArgs).toContain('--from-literal=A=alpha');
        expect(createArgs).toContain('--from-literal=B=beta');
    });

    it('runs dry-run then apply via stdin (no shell pipe)', () => {
        mockExec.mockReturnValueOnce('yaml-output').mockReturnValue('');
        upsertSecret('/etc/kubernetes/admin.conf', 's', 'ns', { K: 'v' });
        // Second call is kubectl apply -f -
        const applyCall = mockExec.mock.calls[1];
        expect(applyCall[1]).toContain('apply');
        expect((applyCall[2] as { input?: string }).input).toBe('yaml-output');
    });
});

// ── upsertConfigmap ────────────────────────────────────────────────────────

describe('upsertConfigmap', () => {
    it('passes correct namespace, name, and data', () => {
        mockExec.mockReturnValue('');
        upsertConfigmap('/etc/kubernetes/admin.conf', 'my-cm', 'my-ns', { ENV: 'development' });
        const createArgs = mockExec.mock.calls[0][1] as string[];
        expect(createArgs).toContain('configmap');
        expect(createArgs).toContain('my-cm');
        expect(createArgs).toContain('--from-literal=ENV=development');
    });
});

// ── syncFromS3 ─────────────────────────────────────────────────────────────

describe('syncFromS3', () => {
    it('calls aws s3 sync with correct args', () => {
        mockExec.mockReturnValue('');
        syncFromS3('my-bucket', 'app-deploy/nextjs', '/data/app-deploy/nextjs', 'eu-west-1');
        const awsArgs = mockExec.mock.calls[0][1] as string[];
        expect(awsArgs).toContain('s3');
        expect(awsArgs).toContain('sync');
        expect(awsArgs.some(a => a.includes('my-bucket'))).toBe(true);
        expect(awsArgs).toContain('--region');
        expect(awsArgs).toContain('eu-west-1');
    });

    it('runs find -exec chmod to make .sh files executable', () => {
        mockExec.mockReturnValue('');
        syncFromS3('b', 'prefix', '/data', 'eu-west-1');
        const findCall = mockExec.mock.calls.find(c => c[0] === 'find');
        expect(findCall).toBeDefined();
        expect(findCall![1]).toContain('-name');
        expect(findCall![1]).toContain('*.sh');
    });
});
