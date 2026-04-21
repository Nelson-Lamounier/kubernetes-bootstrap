/**
 * @format
 * Golden AMI Pipeline Construct — Generic Image Builder Blueprint
 *
 * Reusable construct for creating EC2 Image Builder pipelines. This is a
 * domain-agnostic blueprint — it knows nothing about Kubernetes, Docker,
 * or any specific software stack. All domain-specific logic belongs in the
 * consuming stack.
 *
 * Architecture:
 * 1. Component: Created from a pre-built YAML document (injected via props)
 * 2. Recipe: Combines the component with a parent AMI
 * 3. Infrastructure Config: Instance type, subnet, security group
 * 4. Distribution Config: AMI tagging & naming
 * 5. CfnImage: CloudFormation-managed AMI build
 * 6. SSM Parameter: Stores the latest AMI ID for Launch Template lookup
 *
 * Design Philosophy:
 * - Construct is a blueprint, not a configuration handler
 * - Stack builds the component YAML → passes it here
 * - Stack provides IAM policies, AMI tags, and SSM paths
 * - This construct handles Image Builder resource wiring ONLY
 *
 * Blueprint Pattern Flow:
 * 1. Stack builds component document (domain-specific install steps)
 * 2. Stack creates GoldenAmiImageConstruct (with pre-built YAML) → image
 * 3. Stack publishes AMI ID to SSM for downstream consumers
 *
 * @example
 * ```typescript
 * const goldenAmi = new GoldenAmiImageConstruct(this, 'GoldenAmi', {
 *     namePrefix: 'k8s-development',
 *     componentDocument: buildGoldenAmiComponent({ imageConfig, clusterConfig }),
 *     componentDescription: 'Installs Docker, kubeadm, Calico',
 *     parentImageSsmPath: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64',
 *     vpc,
 *     subnetId: vpc.publicSubnets[0].subnetId,
 *     securityGroupId: sg.securityGroupId,
 *     scriptsBucket,
 *     amiSsmPath: '/k8s/development/golden-ami/latest',
 *     amiTags: { Purpose: 'GoldenAMI' },
 *     amiDescription: 'Golden AMI for k8s-development',
 * });
 * ```
 */

import * as crypto from 'crypto';

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as imagebuilder from 'aws-cdk-lib/aws-imagebuilder';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';
import { NagSuppressions } from 'cdk-nag';

import { Construct } from 'constructs';

// =============================================================================
// PROPS
// =============================================================================

export interface GoldenAmiImageProps {
    /** Environment-aware name prefix (e.g., 'k8s-development') */
    readonly namePrefix: string;

    /**
     * Pre-built Image Builder component YAML document.
     * The stack builds this using a domain-specific utility function
     * and injects it here. The construct does not generate any install steps.
     */
    readonly componentDocument: string;

    /** Human-readable description for the Image Builder component */
    readonly componentDescription: string;

    /** Parent image SSM path (e.g., Amazon Linux 2023 latest) */
    readonly parentImageSsmPath: string;

    /** VPC for the Image Builder infrastructure */
    readonly vpc: ec2.IVpc;

    /** Subnet ID for Image Builder instances */
    readonly subnetId: string;

    /** Security group ID for Image Builder instances */
    readonly securityGroupId: string;

    /** S3 bucket for bootstrap scripts (grants read access to Image Builder role) */
    readonly scriptsBucket: s3.IBucket;

    /** SSM parameter path to store the output AMI ID */
    readonly amiSsmPath: string;

    /**
     * Additional IAM managed policies to attach to the Image Builder instance role.
     * The construct already adds scoped inline policies for SSM agent communication,
     * Image Builder agent, and S3 script sync. Only use this for extra policies.
     * @default []
     */
    readonly managedPolicies?: iam.IManagedPolicy[];

    /**
     * Instance types for Image Builder build instances.
     * @default ['t3.medium']
     */
    readonly instanceTypes?: string[];

    /**
     * Root EBS volume size in GB for the AMI recipe.
     * Must be >= the parent AMI snapshot size.
     * @default 30
     */
    readonly rootVolumeSizeGb?: number;

    /**
     * Whether to encrypt the root EBS volume in the AMI recipe.
     * @default true
     */
    readonly rootVolumeEncrypted?: boolean;

    /**
     * Tags applied to the output AMI via the distribution configuration.
     * @default {}
     */
    readonly amiTags?: Record<string, string>;

    /**
     * Description for the output AMI in the distribution configuration.
     * @default `Golden AMI for {namePrefix}`
     */
    readonly amiDescription?: string;

    /**
     * Timeout in minutes for Image Builder image tests.
     * @default 60
     */
    readonly imageTestTimeoutMinutes?: number;
}

// =============================================================================
// CONSTRUCT
// =============================================================================

/**
 * Generic EC2 Image Builder Pipeline Construct.
 *
 * Creates the full Image Builder pipeline from a pre-built component document.
 * The construct is reusable across any project — all domain-specific logic
 * (install steps, K8s config, etc.) is the stack's responsibility.
 *
 * Security Features:
 * - Encrypted EBS volumes by default
 * - Instances terminate on build failure
 * - Build logs shipped to CloudWatch (3-day retention)
 * - IAM follows least-privilege principle
 */
export class GoldenAmiImageConstruct extends Construct {

    /** The Image Builder image (CloudFormation-built) */
    public readonly image: imagebuilder.CfnImage;
    /** The AMI ID produced by Image Builder */
    public readonly imageId: string;
    /** SSM parameter storing the latest AMI ID */
    public readonly amiSsmParameter: ssm.StringParameter;
    /** IAM role used by Image Builder instances */
    public readonly instanceRole: iam.Role;
    /** Instance profile used by Image Builder */
    public readonly instanceProfile: iam.CfnInstanceProfile;

    constructor(scope: Construct, id: string, props: GoldenAmiImageProps) {
        super(scope, id);

        const {
            namePrefix,
            componentDocument,
            componentDescription,
            parentImageSsmPath,
            vpc: _vpc,
            subnetId,
            securityGroupId,
            scriptsBucket,
            amiSsmPath,
        } = props;

        // Resolve prop defaults
        const instanceTypes = props.instanceTypes ?? ['t3.medium'];
        const rootVolumeSizeGb = props.rootVolumeSizeGb ?? 30;
        const rootVolumeEncrypted = props.rootVolumeEncrypted ?? true;
        const amiTags = props.amiTags ?? {};
        const amiDescription = props.amiDescription ?? `Golden AMI for ${namePrefix}`;
        const imageTestTimeoutMinutes = props.imageTestTimeoutMinutes ?? 60;

        // -----------------------------------------------------------------
        // 1. IAM Role for Image Builder instances
        //
        // No AWS managed policies — all permissions are explicit inline
        // statements so the full grant surface is visible in code.
        // -----------------------------------------------------------------
        this.instanceRole = new iam.Role(this, 'InstanceRole', {
            roleName: `${namePrefix}-image-builder-role`,
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: props.managedPolicies ?? [],
            description: 'IAM role for EC2 Image Builder instances (Golden AMI)',
        });

        this.instanceProfile = new iam.CfnInstanceProfile(this, 'InstanceProfile', {
            instanceProfileName: `${namePrefix}-image-builder-profile`,
            roles: [this.instanceRole.roleName],
        });

        // SSM Agent communication — replaces AmazonSSMManagedInstanceCore.
        // Resource: * is required; SSM agent actions are not resource-scopable
        // by AWS service design (see SSM IAM reference docs).
        this.instanceRole.addToPolicy(new iam.PolicyStatement({
            sid: 'SsmAgentCore',
            actions: [
                'ssm:DescribeAssociation',
                'ssm:GetDeployablePatchSnapshotForInstance',
                'ssm:GetDocument',
                'ssm:DescribeDocument',
                'ssm:GetManifest',
                'ssm:GetParameter',
                'ssm:GetParameters',
                'ssm:ListAssociations',
                'ssm:ListInstanceAssociations',
                'ssm:PutInventory',
                'ssm:PutComplianceItems',
                'ssm:PutConfigurePackageResult',
                'ssm:UpdateAssociationStatus',
                'ssm:UpdateInstanceAssociationStatus',
                'ssm:UpdateInstanceInformation',
            ],
            resources: ['*'],
        }));

        this.instanceRole.addToPolicy(new iam.PolicyStatement({
            sid: 'SsmAndEc2Messaging',
            actions: [
                'ssmmessages:CreateControlChannel',
                'ssmmessages:CreateDataChannel',
                'ssmmessages:OpenControlChannel',
                'ssmmessages:OpenDataChannel',
                'ec2messages:AcknowledgeMessage',
                'ec2messages:DeleteMessage',
                'ec2messages:FailMessage',
                'ec2messages:GetEndpoint',
                'ec2messages:GetMessages',
                'ec2messages:SendReply',
            ],
            resources: ['*'],
        }));

        // Image Builder AWSTOE agent — replaces EC2InstanceProfileForImageBuilder.
        // imagebuilder:Get/List require * because the agent resolves its own
        // component ARNs dynamically at build time.
        this.instanceRole.addToPolicy(new iam.PolicyStatement({
            sid: 'ImageBuilderAgent',
            actions: [
                'imagebuilder:GetComponent',
                'imagebuilder:GetContainerRecipe',
                'imagebuilder:ListComponents',
                'imagebuilder:ListContainerRecipes',
                'imagebuilder:ListImageRecipes',
                'imagebuilder:ListImages',
                'imagebuilder:ListImageBuildVersions',
            ],
            resources: ['*'],
        }));

        // AWS-owned S3 buckets for Image Builder component package downloads.
        // Bucket names are AWS-region-specific (ec2imagebuilder-{region}); * is required.
        this.instanceRole.addToPolicy(new iam.PolicyStatement({
            sid: 'ImageBuilderComponentDownload',
            actions: ['s3:GetObject'],
            resources: ['arn:aws:s3:::ec2imagebuilder-*/*'],
        }));

        // Suppress IAM5 for * resources above — hard AWS service constraints:
        //   - SSM agent (ssm:*, ssmmessages:*, ec2messages:*) cannot be scoped to
        //     resource ARNs by AWS service design
        //   - imagebuilder:Get/List need * because the AWSTOE agent resolves its own ARNs
        //   - ec2imagebuilder-* S3 bucket names are AWS-managed and region-dynamic
        //   - S3 /* on the scripts bucket is unavoidable for `aws s3 sync` —
        //     object enumeration and download require a wildcard object ARN
        NagSuppressions.addResourceSuppressions(this.instanceRole, [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'SSM agent (ssm:*, ssmmessages:*, ec2messages:*) and Image Builder ' +
                    'agent (imagebuilder:Get/List) do not support resource-level restrictions — ' +
                    'AWS service design constraint. ' +
                    'ec2imagebuilder-* buckets are AWS-managed with region-dynamic names. ' +
                    'S3 /* on the scripts bucket is required for `aws s3 sync` at AMI bake time.',
                appliesTo: [
                    'Resource::*',
                    { regex: '/^Resource::arn:aws:s3:::ec2imagebuilder-.+\\*$/g' },
                    { regex: '/^Resource::arn:aws:s3:::.+\\/\\*$/g' },
                ],
            },
        ], true);

        // S3 bootstrap scripts — replaces scriptsBucket.grantRead() which uses
        // wildcard actions (GetObject*, GetBucket*, List*).
        // Scoped to specific actions on this bucket only.
        this.instanceRole.addToPolicy(new iam.PolicyStatement({
            sid: 'ScriptsBucketObjects',
            actions: ['s3:GetObject'],
            resources: [scriptsBucket.arnForObjects('*')],
        }));

        this.instanceRole.addToPolicy(new iam.PolicyStatement({
            sid: 'ScriptsBucketMeta',
            actions: ['s3:ListBucket', 's3:GetBucketLocation'],
            resources: [scriptsBucket.bucketArn],
        }));

        // -----------------------------------------------------------------
        // 2. Image Builder Component
        //
        // Image Builder components are IMMUTABLE — same name + version
        // cannot be updated. We derive the version from a content hash
        // so it auto-bumps whenever install steps or software versions change.
        // -----------------------------------------------------------------
        const contentHash = crypto.createHash('sha256').update(componentDocument).digest();
        const componentVersion = `${contentHash[0]}.${contentHash[1]}.${contentHash[2]}`;

        const installComponent = new imagebuilder.CfnComponent(this, 'InstallComponent', {
            name: `${namePrefix}-golden-ami-install`,
            platform: 'Linux',
            version: componentVersion,
            description: componentDescription,
            data: componentDocument,
        });

        // -----------------------------------------------------------------
        // 3. Image Builder Recipe
        // -----------------------------------------------------------------
        const recipe = new imagebuilder.CfnImageRecipe(this, 'Recipe', {
            name: `${namePrefix}-golden-ami-recipe`,
            version: componentVersion,
            parentImage: `ssm:${parentImageSsmPath}`,
            components: [
                {
                    componentArn: installComponent.attrArn,
                },
            ],
            blockDeviceMappings: [
                {
                    deviceName: '/dev/xvda',
                    ebs: {
                        volumeSize: rootVolumeSizeGb,
                        volumeType: 'gp3',
                        deleteOnTermination: true,
                        encrypted: rootVolumeEncrypted,
                    },
                },
            ],
        });

        // -----------------------------------------------------------------
        // 4. Infrastructure Configuration
        // -----------------------------------------------------------------

        // CloudWatch Logs for Image Builder build output
        const buildLogGroup = new logs.LogGroup(this, 'BuildLogs', {
            logGroupName: `/aws/imagebuilder/${namePrefix}-golden-ami`,
            retention: logs.RetentionDays.THREE_DAYS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Grant instance role permission to write build logs
        buildLogGroup.grantWrite(this.instanceRole);

        const infraConfig = new imagebuilder.CfnInfrastructureConfiguration(
            this,
            'InfraConfig',
            {
                name: `${namePrefix}-golden-ami-infra`,
                instanceProfileName: this.instanceProfile.instanceProfileName!,
                instanceTypes,
                subnetId,
                securityGroupIds: [securityGroupId],
                terminateInstanceOnFailure: true,
            },
        );
        infraConfig.addDependency(this.instanceProfile);

        // -----------------------------------------------------------------
        // 5. Distribution Configuration — AMI tagging & naming
        //
        // NOTE: amiDistributionConfiguration uses PascalCase raw JSON due to
        // a known CDK/CloudFormation binding issue where camelCase properties
        // fail CloudFormation validation.
        // -----------------------------------------------------------------
        const distribution = new imagebuilder.CfnDistributionConfiguration(
            this,
            'Distribution',
            {
                name: `${namePrefix}-golden-ami-dist`,
                distributions: [
                    {
                        region: cdk.Stack.of(this).region,
                        amiDistributionConfiguration: {
                            Name: `${namePrefix}-golden-ami-{{ imagebuilder:buildDate }}`,
                            Description: amiDescription,
                            AmiTags: amiTags,
                        },
                    },
                ],
            },
        );

        // -----------------------------------------------------------------
        // 6. CfnImage — CloudFormation-managed AMI build
        //
        // CloudFormation creates and builds the AMI inline during cdk deploy.
        // When the component/recipe changes, CFN replaces this resource,
        // triggering a new build automatically. When the stack is deleted,
        // CFN deregisters the AMI — no orphaned images or stale SSM params.
        //
        // NOTE: This resource takes ~15–25 minutes to create. This is
        // acceptable because the Compute stacks (ControlPlane, Workers)
        // depend on this stack completing before they deploy.
        // -----------------------------------------------------------------
        this.image = new imagebuilder.CfnImage(this, 'Image', {
            imageRecipeArn: recipe.attrArn,
            infrastructureConfigurationArn: infraConfig.attrArn,
            distributionConfigurationArn: distribution.attrArn,
            imageTestsConfiguration: {
                imageTestsEnabled: true,
                timeoutMinutes: imageTestTimeoutMinutes,
            },
        });

        // The AMI ID is extracted from the CfnImage output
        this.imageId = this.image.attrImageId;

        // -----------------------------------------------------------------
        // 7. SSM Parameter — stores the AMI ID for Launch Template discovery
        //
        // The Launch Template uses ec2.MachineImage.fromSsmParameter() which
        // resolves to {{resolve:ssm:/k8s/{env}/golden-ami/latest}}. This
        // parameter is now fully lifecycle-managed by CloudFormation:
        //   - Created when the stack deploys
        //   - Updated when the image changes (component/recipe changes)
        //   - Deleted when the stack is deleted
        //
        // No more stale SSM references to deregistered AMIs.
        // -----------------------------------------------------------------
        this.amiSsmParameter = new ssm.StringParameter(this, 'AmiIdParam', {
            parameterName: amiSsmPath,
            stringValue: this.imageId,
            description: `Golden AMI ID for ${namePrefix} (managed by CloudFormation)`,
        });

        // Tags: applied by TaggingAspect at stack level
    }
}
