import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BootConfig } from '../../boot/steps/control_plane.js';

vi.mock('../../boot/steps/common.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../boot/steps/common.js')>();
    return {
        ...actual,
        run:       vi.fn(),
        imds:      vi.fn().mockReturnValue(''),
        ssmGet:    vi.fn(),
        ssmPut:    vi.fn(),
        waitUntil: vi.fn().mockResolvedValue(undefined),
        info:      vi.fn(),
        warn:      vi.fn(),
        error:     vi.fn(),
    };
});

import { imds, run } from '../../boot/steps/common.js';
import {
    ensureBootstrapToken,
    ensureCoreDns,
    ensureKubeProxy,
} from '../../boot/steps/control_plane.js';

const mockRun  = vi.mocked(run);
const mockImds = vi.mocked(imds);

const ok   = (stdout = '', stderr = '') => ({ ok: true,  stdout, stderr, code: 0 });
const fail = (stdout = '', stderr = '') => ({ ok: false, stdout, stderr, code: 1 });

const cfg: BootConfig = {
    ssmPrefix:    '/k8s/development',
    awsRegion:    'eu-west-1',
    k8sVersion:   '1.35.1',
    dataDir:      '/data/kubernetes',
    podCidr:      '192.168.0.0/16',
    serviceCidr:  '10.96.0.0/12',
    hostedZoneId: '',
    apiDnsName:   'k8s-api.k8s.internal',
    s3Bucket:     '',
    mountPoint:   '/data',
    calicoVersion: 'v3.29.3',
    environment:  'development',
    logGroupName: '',
};

beforeEach(() => { vi.clearAllMocks(); });

// ── ensureBootstrapToken ───────────────────────────────────────────────────

describe('ensureBootstrapToken', () => {
    it('skips when cluster-info ConfigMap is present', () => {
        mockRun.mockReturnValue(ok('NAME           DATA   AGE\ncluster-info   3      5d\n'));
        ensureBootstrapToken();
        expect(mockRun).toHaveBeenCalledTimes(1);
        const cmd: string[] = mockRun.mock.calls[0][0] as string[];
        expect(cmd).toContain('configmap');
        expect(cmd).toContain('cluster-info');
    });

    it('runs all restore phases when ConfigMap is missing', () => {
        mockRun
            .mockReturnValueOnce(fail('Error from server (NotFound)'))
            .mockReturnValue(ok());

        ensureBootstrapToken();

        expect(mockRun).toHaveBeenCalledTimes(4);
        const cmds = mockRun.mock.calls.map(c => (c[0] as string[]).join(' '));
        expect(cmds.some(c => c.includes('upload-config') && c.includes('kubeadm'))).toBe(true);
        expect(cmds.some(c => c.includes('upload-config') && c.includes('kubelet'))).toBe(true);
        expect(cmds.some(c => c.includes('bootstrap-token'))).toBe(true);
    });
});

// ── ensureKubeProxy ────────────────────────────────────────────────────────

describe('ensureKubeProxy', () => {
    it('skips when kube-proxy DaemonSet is already present', async () => {
        mockRun.mockReturnValue(ok('NAME         DESIRED\nkube-proxy   1\n'));
        await ensureKubeProxy(cfg);
        expect(mockRun).toHaveBeenCalledTimes(1);
        const cmd: string[] = mockRun.mock.calls[0][0] as string[];
        expect(cmd).toContain('daemonset');
        expect(cmd).toContain('kube-proxy');
    });

    it('deploys kube-proxy with correct args when missing', async () => {
        mockRun.mockReturnValue(fail('NotFound'));
        mockImds.mockReturnValue('10.0.1.42');
        mockRun
            .mockReturnValueOnce(fail('NotFound'))
            .mockReturnValue(ok());

        await ensureKubeProxy(cfg);

        const kubeadmCall = mockRun.mock.calls.find(c =>
            (c[0] as string[]).includes('kubeadm') && (c[0] as string[]).includes('kube-proxy'),
        );
        expect(kubeadmCall).toBeDefined();
        const cmd = kubeadmCall![0] as string[];
        expect(cmd.some(a => a.includes('apiserver-advertise-address=10.0.1.42'))).toBe(true);
        expect(cmd.some(a => a.includes('pod-network-cidr=192.168.0.0/16'))).toBe(true);
    });

    it('throws when IMDS cannot provide private IP', async () => {
        mockRun.mockReturnValue(fail('NotFound'));
        mockImds.mockReturnValue('');
        await expect(ensureKubeProxy(cfg)).rejects.toThrow('Cannot deploy kube-proxy');
    });
});

// ── ensureCoreDns ──────────────────────────────────────────────────────────

describe('ensureCoreDns', () => {
    it('skips when CoreDNS Deployment is already present', () => {
        mockRun.mockReturnValue(ok('NAME      READY\ncoredns   2/2\n'));
        ensureCoreDns(cfg);
        expect(mockRun).toHaveBeenCalledTimes(1);
        const cmd: string[] = mockRun.mock.calls[0][0] as string[];
        expect(cmd).toContain('deployment');
        expect(cmd).toContain('coredns');
    });

    it('deploys CoreDNS with correct service-cidr when missing', () => {
        mockRun
            .mockReturnValueOnce(fail('NotFound'))
            .mockReturnValue(ok());

        ensureCoreDns(cfg);

        expect(mockRun).toHaveBeenCalledTimes(2);
        const kubeadmCmd = mockRun.mock.calls[1][0] as string[];
        expect(kubeadmCmd[0]).toBe('kubeadm');
        expect(kubeadmCmd).toContain('coredns');
        expect(kubeadmCmd.some(a => a.includes('service-cidr=10.96.0.0/12'))).toBe(true);
    });
});
