/**
 * @format
 * Deployment configuration — TypeScript equivalent of deploy_helpers/config.py.
 * The Python original is preserved for existing tests (tests/deploy/test_config.py).
 */

import logger from './logger.js';

export interface DeployConfig {
    readonly ssmPrefix: string;
    readonly awsRegion: string;
    readonly kubeconfig: string;
    readonly s3Bucket: string;
    readonly s3KeyPrefix: string;
    readonly namespace: string;
    readonly dryRun: boolean;
    readonly secrets: Record<string, string>;
}

export const fromEnv = (): DeployConfig => ({
    ssmPrefix:   process.env.SSM_PREFIX   ?? '/k8s/development',
    awsRegion:   process.env.AWS_REGION   ?? 'eu-west-1',
    kubeconfig:  process.env.KUBECONFIG   ?? '/etc/kubernetes/admin.conf',
    s3Bucket:    process.env.S3_BUCKET    ?? '',
    s3KeyPrefix: process.env.S3_KEY_PREFIX ?? 'k8s',
    namespace:   process.env.NAMESPACE    ?? 'default',
    dryRun:      process.env.DRY_RUN === 'true',
    secrets:     {},
});

export const printBanner = (cfg: DeployConfig, title: string): void => {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    logger.header(title);
    logger.config('Configuration', {
        ssm_prefix: cfg.ssmPrefix,
        aws_region: cfg.awsRegion,
        namespace:  cfg.namespace,
        triggered:  now,
    });
};
