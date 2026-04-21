#!/usr/bin/env node
/**
 * @format
 * CDK App Entry Point — kubernetes-bootstrap Stacks
 *
 * Resolves environment from CDK context (`-c environment=development`)
 * and instantiates all kubernetes-bootstrap stacks with matching config.
 *
 * Stacks:
 *   - K8s-GoldenAmi-{env}     → EC2 Image Builder pipeline (new)
 *   - K8s-SsmAutomation-{env} → SSM Automation + Step Functions
 *
 * Usage:
 *   npx cdk synth  -c environment=development -c vpcId=vpc-xxxxxxxxxxxxxxxxx
 *   npx cdk deploy K8s-GoldenAmi-development \
 *     -c environment=development \
 *     -c vpcId=vpc-xxxxxxxxxxxxxxxxx
 *   npx cdk deploy K8s-SsmAutomation-development \
 *     -c environment=development
 *
 * VPC ID Resolution (Option A):
 *   The CI pipeline reads VPC_ID from SSM before calling cdk deploy and
 *   injects it via: -c vpcId=$VPC_ID. This avoids ec2.Vpc.fromLookup
 *   needing a separate synth-time AWS credential step.
 */

import * as cdk from 'aws-cdk-lib/core';
import { AwsSolutionsChecks } from 'cdk-nag';

import {
    cdkEnvironment,
    getEnvironmentConfig,
    resolveEnvironment,
} from '../lib/config/environments.js';
import { k8sSsmPrefix } from '../lib/config/ssm-paths.js';
import { getK8sConfigs } from '../lib/config/kubernetes/index.js';
import { K8sSsmAutomationStack } from '../lib/stacks/ssm-automation-stack.js';
import { GoldenAmiStack } from '../lib/stacks/golden-ami-stack.js';

const app = new cdk.App();

// ---------------------------------------------------------------------------
// Resolve shared context
// ---------------------------------------------------------------------------

/** Resolve environment from `-c environment=...` or $ENVIRONMENT */
const envContext = app.node.tryGetContext('environment') as string | undefined;
const targetEnvironment = resolveEnvironment(envContext);
const configs = getK8sConfigs(targetEnvironment);
const envConfig = getEnvironmentConfig(targetEnvironment);

// ---------------------------------------------------------------------------
// K8s-GoldenAmi-{env}
//
// VPC ID is injected by CI as a context variable (-c vpcId=...) after
// reading the value from SSM (/k8s/{env}/vpc-id) before cdk deploy.
// ---------------------------------------------------------------------------

/** VPC ID from CDK context (required for GoldenAmiStack) */
const vpcId =
    (app.node.tryGetContext('vpcId') as string | undefined) ??
    process.env['VPC_ID'];

if (vpcId) {
    new GoldenAmiStack(app, `K8s-GoldenAmi-${targetEnvironment}`, {
        env: cdkEnvironment(targetEnvironment),
        targetEnvironment,
        configs,
        namePrefix: `k8s-${targetEnvironment}`,
        ssmPrefix: k8sSsmPrefix(targetEnvironment),
        vpcId,
        description: `K8s Golden AMI Image Builder Pipeline — ${targetEnvironment}`,
    });
} else {
    // Allow synth without vpcId for SSM Automation stack only
    // eslint-disable-next-line no-console
    console.warn(
        '[app.ts] vpcId not provided — skipping GoldenAmiStack synthesis. ' +
        'Pass -c vpcId=<vpc-id> or set VPC_ID env var to include it.',
    );
}

// ---------------------------------------------------------------------------
// K8s-SsmAutomation-{env}
// ---------------------------------------------------------------------------

/** S3 scripts bucket name from context or environment variable */
const scriptsBucketName =
    (app.node.tryGetContext('scriptsBucket') as string | undefined) ??
    process.env['SCRIPTS_BUCKET'] ??
    `k8s-scripts-${envConfig.account}-${envConfig.region}`;

new K8sSsmAutomationStack(app, `K8s-SsmAutomation-${targetEnvironment}`, {
    env: cdkEnvironment(targetEnvironment),
    targetEnvironment,
    configs,
    ssmPrefix: k8sSsmPrefix(targetEnvironment),
    scriptsBucketName,
    notificationEmail: process.env['NOTIFICATION_EMAIL'],
    description: `K8s SSM Automation Stack — bootstrap orchestration for ${targetEnvironment}`,
});

// Apply CDK-Nag security checks
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

