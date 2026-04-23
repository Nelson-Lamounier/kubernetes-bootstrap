import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseArgs } from '../../../sm-a/argocd/helpers/config.js';

const ORIG_ARGV = [...process.argv];
const ORIG_ENV  = { ...process.env };

beforeEach(() => {
    Object.keys(process.env).forEach(k => { delete process.env[k]; });
    process.argv = ['node', 'bootstrap_argocd.ts'];
});
afterEach(() => {
    Object.assign(process.env, ORIG_ENV);
    process.argv = ORIG_ARGV;
});

describe('parseArgs (argocd Config)', () => {
    describe('defaults', () => {
        it('returns sensible defaults when env is empty', () => {
            const cfg = parseArgs();
            expect(cfg.ssmPrefix).toBe('/k8s/development');
            expect(cfg.awsRegion).toBe('eu-west-1');
            expect(cfg.kubeconfig).toBe('/etc/kubernetes/admin.conf');
            expect(cfg.argocdDir).toBe('/opt/k8s-bootstrap/sm-a/argocd');
            expect(cfg.argocdCliVersion).toBe('v2.14.11');
            expect(cfg.argoTimeout).toBe(300);
            expect(cfg.dryRun).toBe(false);
            expect(cfg.env).toBe('development');
        });
    });

    describe('env var overrides', () => {
        it('reads SSM_PREFIX', () => {
            process.env.SSM_PREFIX = '/k8s/production';
            expect(parseArgs().ssmPrefix).toBe('/k8s/production');
        });

        it('reads AWS_REGION', () => {
            process.env.AWS_REGION = 'us-east-1';
            expect(parseArgs().awsRegion).toBe('us-east-1');
        });

        it('reads KUBECONFIG', () => {
            process.env.KUBECONFIG = '/tmp/kubeconfig';
            expect(parseArgs().kubeconfig).toBe('/tmp/kubeconfig');
        });

        it('reads ARGOCD_DIR', () => {
            process.env.ARGOCD_DIR = '/opt/argocd';
            expect(parseArgs().argocdDir).toBe('/opt/argocd');
        });

        it('reads ARGOCD_CLI_VERSION', () => {
            process.env.ARGOCD_CLI_VERSION = 'v2.10.0';
            expect(parseArgs().argocdCliVersion).toBe('v2.10.0');
        });

        it('parses ARGO_TIMEOUT as integer', () => {
            process.env.ARGO_TIMEOUT = '600';
            expect(parseArgs().argoTimeout).toBe(600);
        });
    });

    describe('env derivation from SSM_PREFIX', () => {
        it('derives env from last path segment', () => {
            process.env.SSM_PREFIX = '/k8s/production';
            expect(parseArgs().env).toBe('production');
        });

        it('derives env for staging', () => {
            process.env.SSM_PREFIX = '/k8s/staging';
            expect(parseArgs().env).toBe('staging');
        });

        it('strips trailing slash before deriving env', () => {
            process.env.SSM_PREFIX = '/k8s/development/';
            expect(parseArgs().env).toBe('development');
        });
    });

    describe('--dry-run flag', () => {
        it('sets dryRun true when --dry-run is in process.argv', () => {
            process.argv = ['node', 'bootstrap_argocd.ts', '--dry-run'];
            expect(parseArgs().dryRun).toBe(true);
        });

        it('leaves dryRun false when --dry-run is absent', () => {
            process.argv = ['node', 'bootstrap_argocd.ts'];
            expect(parseArgs().dryRun).toBe(false);
        });
    });
});
