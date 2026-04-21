import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fromEnv as cpFromEnv } from '../../boot/steps/control_plane.js';
import { fromEnv as workerFromEnv } from '../../boot/steps/worker.js';

const ORIG_ENV = { ...process.env };

beforeEach(() => { Object.keys(process.env).forEach(k => { delete process.env[k]; }); });
afterEach(()  => { Object.assign(process.env, ORIG_ENV); });

describe('BootConfig (control_plane fromEnv)', () => {
    it('provides sensible defaults when env is empty', () => {
        const cfg = cpFromEnv();
        expect(cfg.awsRegion).toBe('eu-west-1');
        expect(cfg.ssmPrefix).toBe('/k8s/development');
        expect(cfg.environment).toBe('development');
        expect(cfg.mountPoint).toBe('/data');
        expect(cfg.dataDir).toBe('/data/kubernetes');
        expect(cfg.podCidr).toBe('192.168.0.0/16');
        expect(cfg.serviceCidr).toBe('10.96.0.0/12');
    });

    it('reads overrides from environment variables', () => {
        process.env.AWS_REGION   = 'us-east-1';
        process.env.SSM_PREFIX   = '/k8s/staging';
        process.env.MOUNT_POINT  = '/mnt/data';
        process.env.K8S_VERSION  = '1.30.0';
        process.env.S3_BUCKET    = 'my-bucket';

        const cfg = cpFromEnv();
        expect(cfg.awsRegion).toBe('us-east-1');
        expect(cfg.ssmPrefix).toBe('/k8s/staging');
        expect(cfg.mountPoint).toBe('/mnt/data');
        expect(cfg.k8sVersion).toBe('1.30.0');
        expect(cfg.s3Bucket).toBe('my-bucket');
    });

    it('reads ENVIRONMENT variable', () => {
        process.env.ENVIRONMENT = 'production';
        expect(cpFromEnv().environment).toBe('production');
    });

    it('optional fields default to empty string', () => {
        const cfg = cpFromEnv();
        expect(cfg.hostedZoneId).toBe('');
        expect(cfg.s3Bucket).toBe('');
        expect(cfg.logGroupName).toBe('');
    });
});

describe('WorkerConfig (worker fromEnv)', () => {
    it('provides sensible defaults when env is empty', () => {
        const cfg = workerFromEnv();
        expect(cfg.awsRegion).toBe('eu-west-1');
        expect(cfg.ssmPrefix).toBe('/k8s/development');
        expect(cfg.environment).toBe('development');
        expect(cfg.nodeLabel).toBe('role=worker');
        expect(cfg.joinMaxRetries).toBe(5);
        expect(cfg.joinRetryInterval).toBe(30);
    });

    it('reads NODE_POOL and NODE_LABEL overrides', () => {
        process.env.NODE_LABEL = 'workload=monitoring';
        process.env.NODE_POOL  = 'monitoring';

        const cfg = workerFromEnv();
        expect(cfg.nodeLabel).toBe('workload=monitoring');
        expect(cfg.nodePool).toBe('monitoring');
    });

    it('parses numeric JOIN_MAX_RETRIES', () => {
        process.env.JOIN_MAX_RETRIES    = '10';
        process.env.JOIN_RETRY_INTERVAL = '15';

        const cfg = workerFromEnv();
        expect(cfg.joinMaxRetries).toBe(10);
        expect(cfg.joinRetryInterval).toBe(15);
    });

    it('optional fields default to empty string', () => {
        const cfg = workerFromEnv();
        expect(cfg.logGroupName).toBe('');
        expect(cfg.nodePool).toBe('');
    });
});
