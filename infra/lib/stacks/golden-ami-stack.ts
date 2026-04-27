/**
 * @format
 * Golden AMI Stack — EC2 Image Builder Pipeline
 *
 * Dedicated stack for the EC2 Image Builder pipeline that bakes Docker, AWS CLI,
 * kubeadm toolchain, ecr-credential-provider, Calico manifests, Helm, K8sGPT,
 * and the Python 3.11 bootstrap virtualenv into a Golden AMI.
 *
 * This stack handles all K8s-specific domain logic:
 * - Builds the component YAML document via `buildGoldenAmiComponent()`
 * - Provides K8s-specific IAM managed policies
 * - Configures K8s-specific AMI tags and description
 * - Resolves base infrastructure from SSM (VPC, SG, S3) — no cross-stack exports
 *
 * The underlying `GoldenAmiImageConstruct` is a generic, reusable Image Builder
 * blueprint that knows nothing about Kubernetes.
 *
 * Deployment Order:
 * ```
 * 1. deploy-base       → creates VPC, SG, scripts bucket   [cdk-monitoring]
 * 2. deploy-goldenami  → creates Image Builder pipeline     [kubernetes-bootstrap] ← this stack
 * 3. build-golden-ami  → triggers pipeline, bakes AMI
 * 4. deploy-compute    → ASG launches EC2 with baked AMI   [cdk-monitoring]
 * ```
 *
 * VPC Resolution Strategy (Option A):
 * The VPC ID is injected as a CDK context variable (`-c vpcId=...`) by the CI
 * pipeline before calling `cdk deploy`. The CI job reads the value from SSM at
 * workflow runtime using `aws ssm get-parameter`. This avoids `ec2.Vpc.fromLookup`
 * requiring a separate synth-time AWS credential step.
 *
 * @example
 * ```typescript
 * new GoldenAmiStack(app, 'K8s-GoldenAmi-development', {
 *     env: cdkEnvironment(Environment.DEVELOPMENT),
 *     targetEnvironment: Environment.DEVELOPMENT,
 *     configs,
 *     namePrefix: 'k8s-development',
 *     ssmPrefix: '/k8s/development',
 * });
 * ```
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment } from '../config/environments.js';
import { K8sConfigs } from '../config/kubernetes/index.js';
import { GoldenAmiAlertConstruct } from '../constructs/compute/golden-ami-alert.js';
import { GoldenAmiImageConstruct } from '../constructs/compute/golden-ami-image.js';
import { buildGoldenAmiComponent } from '../constructs/compute/build-golden-ami-component.js';

// =============================================================================
// PROPS
// =============================================================================

export interface GoldenAmiStackProps extends cdk.StackProps {
    /**
     * VPC ID from the base stack.
     * Injected by CI as a CDK context variable (`-c vpcId=...`) read from SSM
     * before `cdk deploy` runs. Must NOT be empty.
     */
    readonly vpcId: string;

    /** Target environment (development, staging, production) */
    readonly targetEnvironment: Environment;

    /** Full K8s configuration (imageConfig + clusterConfig) */
    readonly configs: K8sConfigs;

    /** Environment-aware name prefix (e.g., 'k8s-development') */
    readonly namePrefix: string;

    /** SSM parameter prefix for the base stack (e.g., '/k8s/development') */
    readonly ssmPrefix: string;

    /**
     * Email address to subscribe to the AMI build failure SNS topic.
     * When omitted, the topic is still created and wired to EventBridge —
     * subscribers can be added out-of-band.
     */
    readonly notificationEmail?: string;
}

// =============================================================================
// STACK
// =============================================================================

/**
 * Golden AMI Stack — EC2 Image Builder Pipeline.
 *
 * Orchestrates the generic `GoldenAmiImageConstruct` with K8s-specific
 * domain logic: component YAML generation, IAM policies, and AMI tags.
 * Creates the Image Builder pipeline as a standalone resource so it can
 * be deployed before the Compute stacks.
 *
 * @remarks
 * Deployment of this stack triggers a CfnImage build that takes 15–25 minutes.
 * This is expected — when the stack completes, the AMI ID is written to SSM
 * at `/k8s/{env}/golden-ami/latest`, ready for consumption by Compute stacks.
 */
export class GoldenAmiStack extends cdk.Stack {
    /** The underlying image builder construct (for cross-stack references if needed) */
    public readonly imageBuilder: GoldenAmiImageConstruct;
    /** The AMI ID produced by Image Builder (CloudFormation token until deployed) */
    public readonly imageId: string;
    /** SNS topic for Image Builder build failures (FAILED/CANCELLED/TIMED_OUT) */
    public readonly amiFailureTopic: sns.Topic;

    constructor(scope: Construct, id: string, props: GoldenAmiStackProps) {
        super(scope, id, props);

        const { configs, namePrefix } = props;

        // -----------------------------------------------------------------
        // 1. Resolve base infrastructure via SSM (no cross-stack exports)
        //
        // These parameters are written by the base stack in cdk-monitoring.
        // Using SSM lookup avoids hard CloudFormation cross-stack dependencies.
        // -----------------------------------------------------------------
        const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpcId });

        const scriptsBucketName = ssm.StringParameter.valueForStringParameter(
            this, `${props.ssmPrefix}/scripts-bucket`,
        );
        const scriptsBucket = s3.Bucket.fromBucketName(this, 'ScriptsBucket', scriptsBucketName);

        const securityGroupId = ssm.StringParameter.valueForStringParameter(
            this, `${props.ssmPrefix}/security-group-id`,
        );

        // -----------------------------------------------------------------
        // 2. Build K8s-specific component YAML document
        //
        // The utility function generates the full Image Builder component
        // YAML with all Kubernetes install steps. Software versions come
        // from the centralised K8sImageConfig.
        // -----------------------------------------------------------------
        // Hash all source baked into the AMI at /opt/k8s-bootstrap/ so any
        // change invalidates the component YAML content hash and forces CDK
        // to create a new CfnImage, triggering an AMI re-bake.
        //
        // Previously this only covered sm-a/boot/steps/*.ts, which left
        // sm-a/argocd/** invisible to the bake trigger — argocd-only edits
        // produced a CDK no-op deploy and the AMI never rolled forward. The
        // walker now covers the whole sm-a/ tree (boot + argocd + future
        // dirs) for {ts,yaml,yml,sh,json}, sorted for determinism. Excludes
        // node_modules/, dist/, and .yarn/ (build/cache artefacts that don't
        // affect runtime behaviour).
        const smaRoot = path.resolve(__dirname, '../../../../sm-a');
        const stepsHash = fs.existsSync(smaRoot)
            ? (() => {
                const h = crypto.createHash('sha256');
                const exts = new Set(['.ts', '.yaml', '.yml', '.sh', '.json']);
                const skip = new Set(['node_modules', 'dist', '.yarn']);
                const walk = (dir: string): string[] => {
                    const out: string[] = [];
                    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                        if (skip.has(ent.name)) continue;
                        const full = path.join(dir, ent.name);
                        if (ent.isDirectory()) out.push(...walk(full));
                        else if (exts.has(path.extname(ent.name))) out.push(full);
                    }
                    return out;
                };
                walk(smaRoot)
                    .sort()                          // deterministic order
                    .forEach(f => h.update(fs.readFileSync(f)));
                return h.digest('hex').slice(0, 12);
            })()
            : undefined;

        const componentDocument = buildGoldenAmiComponent({
            imageConfig: configs.image,
            clusterConfig: configs.cluster,
            scriptsBucketSsmPath: `${props.ssmPrefix}/scripts-bucket`,
            extraHash: stepsHash,
        });

        // -----------------------------------------------------------------
        // 3. Create generic Image Builder pipeline
        //
        // The construct is a reusable blueprint — all K8s-specific values
        // are injected here as props.
        // -----------------------------------------------------------------
        this.imageBuilder = new GoldenAmiImageConstruct(this, 'GoldenAmi', {
            namePrefix,
            componentDocument,
            componentDescription: 'Installs Docker, AWS CLI, kubeadm toolchain, Calico CNI, Helm, K8sGPT, and Python 3.11 venv',
            parentImageSsmPath: configs.image.parentImageSsmPath,
            vpc,
            subnetId: vpc.publicSubnets[0].subnetId,
            securityGroupId,
            scriptsBucket,
            amiSsmPath: configs.image.amiSsmPath,

            // K8s-specific AMI distribution tags
            amiTags: {
                'Purpose': 'GoldenAMI',
                'KubernetesVersion': configs.cluster.kubernetesVersion,
                'ContainerdVersion': configs.image.bakedVersions.containerd,
                'CalicoVersion': configs.image.bakedVersions.calico,
                'K8sGPTVersion': configs.image.bakedVersions.k8sgpt,
                'Component': 'ImageBuilder',
                'ManagedBy': 'kubernetes-bootstrap',
                'BootstrapBaked': 'true',
            },
            amiDescription: `Golden AMI for ${namePrefix} (kubeadm ${configs.cluster.kubernetesVersion})`,
        });

        this.imageId = this.imageBuilder.imageId;

        // -----------------------------------------------------------------
        // 4. Build-failure alert: SNS topic + EventBridge rule
        //
        // Closes the gap between Image Builder failures and downstream EC2
        // launches. Without this, a failed bake leaves the SSM AMI parameter
        // pointing at the previous build and downstream orchestrators silently
        // roll forward on the stale AMI. Recipe name matches the construct's
        // own internal naming (`${namePrefix}-golden-ami-recipe`).
        // -----------------------------------------------------------------
        const amiAlert = new GoldenAmiAlertConstruct(this, 'AmiBuildFailureAlert', {
            namePrefix,
            recipeName: `${namePrefix}-golden-ami-recipe`,
            notificationEmail: props.notificationEmail,
        });
        this.amiFailureTopic = amiAlert.topic;

        // -----------------------------------------------------------------
        // 5. Stack-level outputs for observability
        // -----------------------------------------------------------------
        new cdk.CfnOutput(this, 'AmiId', {
            value: this.imageId,
            description: 'Golden AMI ID produced by Image Builder',
            exportName: `${namePrefix}-golden-ami-id`,
        });

        new cdk.CfnOutput(this, 'AmiSsmPath', {
            value: configs.image.amiSsmPath,
            description: 'SSM parameter path storing the latest Golden AMI ID',
        });

        new cdk.CfnOutput(this, 'AmiFailureTopicArn', {
            value: this.amiFailureTopic.topicArn,
            description: 'SNS topic ARN for Golden AMI build failures',
            exportName: `${namePrefix}-golden-ami-failure-topic`,
        });
    }
}
