import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../sm-a/argocd/helpers/config.js';

// Mock runner helpers before importing the module under test
vi.mock('../../../sm-a/argocd/helpers/runner.js', () => ({
    log:               vi.fn(),
    run:               vi.fn(),
    ssmGet:            vi.fn(),
    ssmPut:            vi.fn(),
    kubectlApplyStdin: vi.fn(),
    sleep:             vi.fn().mockResolvedValue(undefined),
    secretsManagerGet: vi.fn(),
    secretsManagerPut: vi.fn(),
}));

import { run, ssmGet, ssmPut, kubectlApplyStdin } from '../../../sm-a/argocd/helpers/runner.js';
import { backupCert, restoreCert } from '../../../sm-a/argocd/helpers/tls-cert.js';

const mockRun               = vi.mocked(run);
const mockSsmGet            = vi.mocked(ssmGet);
const mockSsmPut            = vi.mocked(ssmPut);
const mockKubectlApplyStdin = vi.mocked(kubectlApplyStdin);

const ok   = (stdout = ''): ReturnType<typeof run> => ({ ok: true,  stdout, stderr: '', code: 0 });
const fail = (stderr = 'not found'): ReturnType<typeof run> => ({ ok: false, stdout: '', stderr, code: 1 });

const cfg: Config = {
    ssmPrefix:       '/k8s/development',
    awsRegion:       'eu-west-1',
    kubeconfig:      '/etc/kubernetes/admin.conf',
    argocdDir:       '/opt/k8s-bootstrap/sm-a/argocd',
    argocdCliVersion: 'v2.14.11',
    argoTimeout:     300,
    dryRun:          false,
    env:             'development',
};

const dryCfg: Config = { ...cfg, dryRun: true };

// kubectl jsonpath output: "{data fields json},{secret type}"
const tlsKubectlOutput = '{"tls.crt":"CERTBASE64","tls.key":"KEYBASE64"},kubernetes.io/tls';
const opaqueKubectlOutput = '{"tls.key":"KEYBASE64"},Opaque';

const tlsSsmPayload = JSON.stringify({
    data: { 'tls.crt': 'CERTBASE64', 'tls.key': 'KEYBASE64' },
    type: 'kubernetes.io/tls',
});

beforeEach(() => { vi.clearAllMocks(); });

// ── backupCert ─────────────────────────────────────────────────────────────

describe('backupCert', () => {
    it('returns false when the kubectl call fails (secret not found)', async () => {
        mockRun.mockReturnValue(fail());
        expect(await backupCert(cfg, 'ops-tls-cert', 'kube-system')).toBe(false);
        expect(mockSsmPut).not.toHaveBeenCalled();
    });

    it('returns false when kubectl stdout is empty', async () => {
        mockRun.mockReturnValue(ok(''));
        expect(await backupCert(cfg, 'ops-tls-cert', 'kube-system')).toBe(false);
    });

    it('stores secret data and type in SSM on success', async () => {
        mockRun.mockReturnValue(ok(tlsKubectlOutput));
        mockSsmPut.mockResolvedValue(undefined);

        expect(await backupCert(cfg, 'ops-tls-cert', 'kube-system')).toBe(true);
        expect(mockSsmPut).toHaveBeenCalledOnce();
        expect(mockSsmPut).toHaveBeenCalledWith(
            cfg,
            '/k8s/development/tls/ops-tls-cert',
            expect.any(String),
            expect.objectContaining({ type: 'SecureString', tier: 'Advanced' }),
        );
    });

    it('includes both data fields and type in the SSM JSON payload', async () => {
        mockRun.mockReturnValue(ok(tlsKubectlOutput));
        mockSsmPut.mockResolvedValue(undefined);

        await backupCert(cfg, 'ops-tls-cert', 'kube-system');

        const payload = JSON.parse(vi.mocked(ssmPut).mock.calls[0]![2] as string) as {
            data: Record<string, string>; type: string;
        };
        expect(payload.type).toBe('kubernetes.io/tls');
        expect(payload.data['tls.crt']).toBe('CERTBASE64');
        expect(payload.data['tls.key']).toBe('KEYBASE64');
    });

    it('handles Opaque secrets correctly (single data field)', async () => {
        mockRun.mockReturnValue(ok(opaqueKubectlOutput));
        mockSsmPut.mockResolvedValue(undefined);

        await backupCert(cfg, 'letsencrypt-account-key', 'cert-manager');

        const payload = JSON.parse(vi.mocked(ssmPut).mock.calls[0]![2] as string) as {
            data: Record<string, string>; type: string;
        };
        expect(payload.type).toBe('Opaque');
        expect(payload.data['tls.key']).toBe('KEYBASE64');
    });

    it('returns true without calling SSM in dry-run mode', async () => {
        mockRun.mockReturnValue(ok(tlsKubectlOutput));

        expect(await backupCert(dryCfg, 'ops-tls-cert', 'kube-system')).toBe(true);
        expect(mockSsmPut).not.toHaveBeenCalled();
    });

    it('uses the correct SSM path: {ssmPrefix}/tls/{secretName}', async () => {
        mockRun.mockReturnValue(ok(tlsKubectlOutput));
        mockSsmPut.mockResolvedValue(undefined);

        await backupCert({ ...cfg, ssmPrefix: '/k8s/production' }, 'ops-tls-cert', 'kube-system');

        expect(mockSsmPut).toHaveBeenCalledWith(
            expect.anything(),
            '/k8s/production/tls/ops-tls-cert',
            expect.any(String),
            expect.anything(),
        );
    });
});

// ── restoreCert ────────────────────────────────────────────────────────────

describe('restoreCert', () => {
    it('returns true immediately when the secret already exists', async () => {
        mockRun.mockReturnValue(ok('ops-tls-cert   kube-system'));

        expect(await restoreCert(cfg, 'ops-tls-cert', 'kube-system')).toBe(true);
        expect(mockSsmGet).not.toHaveBeenCalled();
        expect(mockKubectlApplyStdin).not.toHaveBeenCalled();
    });

    it('returns false when SSM has no backup for the secret', async () => {
        mockRun.mockReturnValue(fail());    // secret doesn't exist
        mockSsmGet.mockResolvedValue(null);

        expect(await restoreCert(cfg, 'ops-tls-cert', 'kube-system')).toBe(false);
        expect(mockKubectlApplyStdin).not.toHaveBeenCalled();
    });

    it('returns false when SSM payload is invalid JSON', async () => {
        mockRun.mockReturnValue(fail());
        mockSsmGet.mockResolvedValue('not valid json at all');

        expect(await restoreCert(cfg, 'ops-tls-cert', 'kube-system')).toBe(false);
    });

    it('applies a Secret manifest containing the stored base64 values', async () => {
        // Return empty stdout for namespace creation so kubectlApplyStdin is
        // called exactly once — for the Secret manifest, not the namespace YAML.
        mockRun
            .mockReturnValueOnce(fail())  // secret doesn't exist
            .mockReturnValue(ok(''));     // namespace dry-run: empty stdout → skip apply
        mockSsmGet.mockResolvedValue(tlsSsmPayload);
        mockKubectlApplyStdin.mockReturnValue(ok('created'));

        const result = await restoreCert(cfg, 'ops-tls-cert', 'kube-system');

        expect(result).toBe(true);
        expect(mockKubectlApplyStdin).toHaveBeenCalledOnce();
        const manifest = mockKubectlApplyStdin.mock.calls[0]![0] as string;
        expect(manifest).toContain('kind: Secret');
        expect(manifest).toContain('name: ops-tls-cert');
        expect(manifest).toContain('namespace: kube-system');
        expect(manifest).toContain('type: kubernetes.io/tls');
        expect(manifest).toContain('tls.crt: CERTBASE64');
        expect(manifest).toContain('tls.key: KEYBASE64');
    });

    it('handles legacy flat SSM payload (no data/type envelope)', async () => {
        const legacyPayload = JSON.stringify({ 'tls.crt': 'CERTBASE64', 'tls.key': 'KEYBASE64' });
        mockRun
            .mockReturnValueOnce(fail())
            .mockReturnValue(ok(''));
        mockSsmGet.mockResolvedValue(legacyPayload);
        mockKubectlApplyStdin.mockReturnValue(ok('created'));

        await restoreCert(cfg, 'ops-tls-cert', 'kube-system');

        const manifest = mockKubectlApplyStdin.mock.calls[0]![0] as string;
        // Legacy flat format defaults to kubernetes.io/tls
        expect(manifest).toContain('type: kubernetes.io/tls');
    });

    it('returns true without contacting SSM or kubectl in dry-run mode', async () => {
        mockRun.mockReturnValue(fail()); // secret doesn't exist

        expect(await restoreCert(dryCfg, 'ops-tls-cert', 'kube-system')).toBe(true);
        expect(mockSsmGet).not.toHaveBeenCalled();
        expect(mockKubectlApplyStdin).not.toHaveBeenCalled();
    });

    it('returns false when kubectlApplyStdin fails', async () => {
        mockRun
            .mockReturnValueOnce(fail())
            .mockReturnValue(ok('namespace'));
        mockSsmGet.mockResolvedValue(tlsSsmPayload);
        mockKubectlApplyStdin.mockReturnValue(fail('apply failed'));

        expect(await restoreCert(cfg, 'ops-tls-cert', 'kube-system')).toBe(false);
    });
});
