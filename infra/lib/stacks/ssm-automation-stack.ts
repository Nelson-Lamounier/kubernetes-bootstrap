/**
 * @format
 * SSM Automation Stack — K8s Bootstrap Orchestration
 *
 * Standalone CDK stack containing SSM Automation documents that orchestrate
 * the Kubernetes bootstrap process. Deployed independently from the Compute
 * stack so that bootstrap scripts can be updated without re-deploying EC2.
 *
 * Resources Created:
 *   - SSM Automation Documents (2): control-plane, worker
 *   - SSM Run Command Documents (2): bootstrap-runner, deploy-runner
 *   - SSM Parameters: Document name discovery for EC2 user data
 *   - IAM Role: Automation execution role with RunCommand permissions
 *   - Step Functions SM-A: Bootstrap orchestrator state machine
 *   - Step Functions SM-B: Config orchestrator state machine
 *   - Lambda: Thin router for ASG tag resolution
 *   - EventBridge: Auto-trigger on ASG instance launch + SM-A success
 *   - CloudWatch Alarm + SNS: Failure notifications
 *   - SSM State Manager Association: Node drift enforcement (30-min schedule)
 */

import { NagSuppressions } from 'cdk-nag';

import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

import { Environment } from '../config/environments.js';
import { K8sConfigs } from '../config/kubernetes/index.js';
import {
    SsmAutomationDocument,
} from '../constructs/ssm/automation-document.js';
import type { AutomationStep } from '../constructs/ssm/automation-document.js';
import {
    BootstrapAlarmConstruct,
} from '../constructs/ssm/bootstrap-alarm.js';
import {
    BootstrapOrchestratorConstruct,
} from '../constructs/ssm/bootstrap-orchestrator.js';
import {
    ConfigOrchestratorConstruct,
} from '../constructs/ssm/config-orchestrator.js';
import {
    NodeDriftEnforcementConstruct,
} from '../constructs/ssm/node-drift-enforcement.js';
import {
    ResourceCleanupProvider,
} from '../constructs/ssm/resource-cleanup-provider.js';
import {
    SsmRunCommandDocument,
} from '../constructs/ssm/ssm-run-command-document.js';

// =============================================================================
// PROPS
// =============================================================================

export interface K8sSsmAutomationStackProps extends cdk.StackProps {
    readonly targetEnvironment: Environment;
    readonly configs: K8sConfigs;
    readonly namePrefix?: string;
    readonly ssmPrefix: string;
    readonly scriptsBucketName: string;
    readonly notificationEmail?: string;
}

// =============================================================================
// STEP DEFINITIONS
// =============================================================================

const CONTROL_PLANE_STEPS: AutomationStep[] = [
    {
        name: 'bootstrapControlPlane',
        scriptPath: 'boot/steps/orchestrator.ts',
        timeoutSeconds: 1800,
        description: 'Run modular control plane bootstrap via cp.main() (validate AMI, EBS, kubeadm, Calico, kubectl, ArgoCD, verify, CloudWatch)',
    },
];

const WORKER_STEPS: AutomationStep[] = [
    {
        name: 'bootstrapWorker',
        scriptPath: 'boot/steps/worker.ts',
        timeoutSeconds: 900,
        description: 'Run consolidated worker bootstrap (validate AMI, join cluster, CloudWatch, EIP association)',
    },
];

// =============================================================================
// STACK
// =============================================================================

export class K8sSsmAutomationStack extends cdk.Stack {
    public readonly controlPlaneDocName: string;
    public readonly workerDocName: string;
    public readonly deploySecretsDocName: string;
    public readonly automationRoleArn: string;
    public readonly stateMachineArn: string;
    public readonly configStateMachineArn: string;
    public readonly bootstrapLogGroup: logs.LogGroup;
    public readonly deployLogGroup: logs.LogGroup;

    constructor(scope: Construct, id: string, props: K8sSsmAutomationStackProps) {
        super(scope, id, props);

        const prefix = props.namePrefix ?? 'k8s';

        // =====================================================================
        // Resource Cleanup — pre-emptive orphan deletion
        //
        // Resources with hardcoded physical names become orphans after
        // CloudFormation UPDATE_ROLLBACK_COMPLETE. This provider runs a
        // cleanup Lambda before each CREATE, deleting any pre-existing
        // resource so the deployment always succeeds.
        // =====================================================================

        const cleanup = new ResourceCleanupProvider(this, 'ResourceCleanup');

        // =====================================================================
        // IAM Role — Automation Execution
        // =====================================================================

        const automationRole = new iam.Role(this, 'AutomationExecutionRole', {
            roleName: `${prefix}-ssm-automation-role`,
            assumedBy: new iam.ServicePrincipal('ssm.amazonaws.com'),
            description: 'Allows SSM Automation to run commands on EC2 instances',
        });

        automationRole.addToPolicy(new iam.PolicyStatement({
            sid: 'AllowRunCommand',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:SendCommand',
                'ssm:ListCommands',
                'ssm:ListCommandInvocations',
                'ssm:GetCommandInvocation',
                'ssm:CancelCommand',
                'ssm:DescribeInstanceInformation',
            ],
            resources: ['*'],
        }));

        automationRole.addToPolicy(new iam.PolicyStatement({
            sid: 'AllowAutomationIntrospection',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:GetAutomationExecution',
                'ssm:DescribeAutomationStepExecutions',
            ],
            resources: ['*'],
        }));

        automationRole.addToPolicy(new iam.PolicyStatement({
            sid: 'AllowSsmParameters',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:GetParameter',
                'ssm:PutParameter',
            ],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter${props.ssmPrefix}/*`,
            ],
        }));

        automationRole.addToPolicy(new iam.PolicyStatement({
            sid: 'AllowS3Read',
            effect: iam.Effect.ALLOW,
            actions: [
                's3:GetObject',
                's3:ListBucket',
            ],
            resources: [
                `arn:aws:s3:::${props.scriptsBucketName}`,
                `arn:aws:s3:::${props.scriptsBucketName}/*`,
            ],
        }));

        automationRole.addToPolicy(new iam.PolicyStatement({
            sid: 'AllowEc2Describe',
            effect: iam.Effect.ALLOW,
            actions: ['ec2:DescribeInstances'],
            resources: ['*'],
        }));

        automationRole.addToPolicy(new iam.PolicyStatement({
            sid: 'AllowCloudWatchLogs',
            effect: iam.Effect.ALLOW,
            actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
                'logs:DescribeLogGroups',
                'logs:DescribeLogStreams',
            ],
            resources: [
                `arn:aws:logs:${this.region}:${this.account}:log-group:/ssm${props.ssmPrefix}/*`,
                `arn:aws:logs:${this.region}:${this.account}:log-group:/ssm${props.ssmPrefix}/*:*`,
            ],
        }));

        this.automationRoleArn = automationRole.roleArn;

        // =====================================================================
        // CloudWatch Log Groups — SSM RunCommand Output
        //
        // Pre-create log groups so retention and removal policies are enforced.
        // Without this, the SSM Agent auto-creates groups with infinite retention.
        // =====================================================================

        this.bootstrapLogGroup = new logs.LogGroup(this, 'BootstrapLogGroup', {
            logGroupName: `/ssm${props.ssmPrefix}/bootstrap`,
            retention: logs.RetentionDays.TWO_WEEKS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        cleanup.addLogGroup(`/ssm${props.ssmPrefix}/bootstrap`, this.bootstrapLogGroup);

        this.deployLogGroup = new logs.LogGroup(this, 'DeployLogGroup', {
            logGroupName: `/ssm${props.ssmPrefix}/deploy`,
            retention: logs.RetentionDays.TWO_WEEKS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        cleanup.addLogGroup(`/ssm${props.ssmPrefix}/deploy`, this.deployLogGroup);

        // =====================================================================
        // SSM Automation Documents — Bootstrap (kept for EC2 user-data compatibility)
        // =====================================================================

        const docBaseProps = {
            ssmPrefix: props.ssmPrefix,
            s3Bucket: props.scriptsBucketName,
            automationRoleArn: automationRole.roleArn,
        };

        const cpDoc = new SsmAutomationDocument(this, 'ControlPlaneAutomation', {
            documentName: `${prefix}-bootstrap-control-plane`,
            description: 'Orchestrates Kubernetes control plane bootstrap (consolidated)',
            documentCategory: 'bootstrap',
            steps: CONTROL_PLANE_STEPS,
            ...docBaseProps,
        });
        this.controlPlaneDocName = cpDoc.documentName;

        const workerDoc = new SsmAutomationDocument(this, 'WorkerAutomation', {
            documentName: `${prefix}-bootstrap-worker`,
            description: 'Orchestrates Kubernetes worker node bootstrap (all roles — app, monitoring, argocd)',
            documentCategory: 'bootstrap',
            steps: WORKER_STEPS,
            ...docBaseProps,
        });
        this.workerDocName = workerDoc.documentName;

        // Keep deploySecretsDocName for backwards compatibility — SM-B supersedes this.
        this.deploySecretsDocName = `${prefix}-deploy-secrets`;

        // =====================================================================
        // SSM Run Command Documents — Step Functions Orchestrators
        // =====================================================================

        const runnerParams = {
            ScriptPath: { type: 'String' as const, description: 'Relative path to python script' },
            SsmPrefix: { type: 'String' as const, description: 'SSM parameter prefix' },
            S3Bucket: { type: 'String' as const, description: 'S3 scripts bucket name' },
            Region: { type: 'String' as const, description: 'AWS region' },
        };

        const bootstrapRunner = new SsmRunCommandDocument(this, 'BootstrapRunnerCommand', {
            documentName: `${prefix}-bootstrap-runner`,
            description: 'Step Functions Runner for K8s Bootstrap Scripts',
            parameters: runnerParams,
            steps: [{
                name: 'runScript',
                // control_plane.py: kubeadm init + Calico + CCM + ArgoCD bootstrap takes up to
                // ~25 minutes on a fresh node. The SM-A poll ceiling is 1800s (30 min).
                // SSM's own timeoutSeconds must be >= SM-A ceiling or it will SIGKILL mid-run.
                // Root cause of 2026-04-13 failure: default 600s killed control_plane.py at
                // Step 9 (create_ci_bot rollout wait) after exactly 10 minutes of execution.
                timeoutSeconds: 3600,
                commands: [
                    'export PATH="/opt/k8s-venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
                    // set -euo pipefail is prepended by SsmRunCommandDocument (without -u).
                    // Do NOT re-add -u here — SSM non-login shells lack $HOME.
                    // Scripts are baked into the AMI at /opt/k8s-bootstrap/ — no S3 download.
                    // The BakeBootstrapScripts Image Builder step syncs them at AMI build time,
                    // version-locking scripts and binaries to the same AMI commit.
                    'SCRIPT_PATH="{{ScriptPath}}"',
                    'STEPS_DIR="/opt/k8s-bootstrap/$(dirname "$SCRIPT_PATH")"',
                    'SCRIPT="/opt/k8s-bootstrap/$SCRIPT_PATH"',
                    '',
                    'echo "Clearing retryable step markers..."',
                    'rm -f /etc/kubernetes/.calico-installed',
                    'rm -f /etc/kubernetes/.ccm-installed',
                    'echo "Retryable markers cleared"',
                    '',
                    'if [ -f /etc/profile.d/k8s-env.sh ]; then',
                    '  source /etc/profile.d/k8s-env.sh',
                    'fi',
                    '',
                    'export SSM_PREFIX="{{SsmPrefix}}"',
                    'export AWS_REGION="{{Region}}"',
                    'export S3_BUCKET="{{S3Bucket}}"',
                    'export MOUNT_POINT="/data"',
                    'export KUBECONFIG="/etc/kubernetes/admin.conf"',
                    '',
                    'cd "$STEPS_DIR"',
                    'npx --prefix /opt/k8s-bootstrap tsx "$SCRIPT" 2>&1'
                ],
            }],
        });

        const deployRunner = new SsmRunCommandDocument(this, 'DeployRunnerCommand', {
            documentName: `${prefix}-deploy-runner`,
            description: 'Step Functions Runner for K8s Deploy Scripts',
            parameters: runnerParams,
            steps: [{
                name: 'runScript',
                commands: [
                    'export PATH="/opt/k8s-venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
                    // set -euo pipefail is prepended by SsmRunCommandDocument (without -u).
                    // Do NOT re-add -u here — SSM non-login shells lack $HOME.
                    'mkdir -p "/data/k8s-bootstrap"',
                    'aws s3 sync "s3://{{S3Bucket}}/k8s-bootstrap/" "/data/k8s-bootstrap/" --region {{Region}} --quiet',
                    '',
                    'SCRIPT_PATH="{{ScriptPath}}"',
                    'DEPLOY_DIR="/data/$(dirname "$SCRIPT_PATH")"',
                    'SCRIPT="/data/$SCRIPT_PATH"',
                    'mkdir -p "$DEPLOY_DIR"',
                    'aws s3 sync "s3://{{S3Bucket}}/$(dirname "$SCRIPT_PATH")/" "$DEPLOY_DIR/" --region {{Region}} --quiet',
                    '',
                    'if [ -f "$DEPLOY_DIR/requirements.txt" ]; then',
                    '  /opt/k8s-venv/bin/pip install -q -r "$DEPLOY_DIR/requirements.txt" 2>/dev/null',
                    'fi',
                    '',
                    'export KUBECONFIG="/etc/kubernetes/admin.conf"',
                    'export SSM_PREFIX="{{SsmPrefix}}"',
                    'export AWS_REGION="{{Region}}"',
                    'export S3_BUCKET="{{S3Bucket}}"',
                    '',
                    'cd "$DEPLOY_DIR"',
                    'python3 "$SCRIPT" 2>&1'
                ],
            }],
        });

        // =====================================================================
        // SSM Parameters — Document Discovery
        //
        // EC2 user data reads these parameters to find the document names
        // without needing cross-stack references.
        // =====================================================================

        const cpDocParam = new ssm.StringParameter(this, 'ControlPlaneDocNameParam', {
            parameterName: `${props.ssmPrefix}/bootstrap/control-plane-doc-name`,
            stringValue: cpDoc.documentName,
            description: 'SSM Automation document name for control plane bootstrap',
        });
        cleanup.addSsmParameter(`${props.ssmPrefix}/bootstrap/control-plane-doc-name`, cpDocParam);

        const workerDocParam = new ssm.StringParameter(this, 'WorkerDocNameParam', {
            parameterName: `${props.ssmPrefix}/bootstrap/worker-doc-name`,
            stringValue: workerDoc.documentName,
            description: 'SSM Automation document name for worker node bootstrap (all roles)',
        });
        cleanup.addSsmParameter(`${props.ssmPrefix}/bootstrap/worker-doc-name`, workerDocParam);

        // Keep the SSM parameter for backwards compatibility — any EC2 user data or legacy
        // scripts that read /deploy/secrets-doc-name still resolve a name, even though
        // SM-B has superseded this document as the canonical config injection path.
        const deployDocParam = new ssm.StringParameter(this, 'DeploySecretsDocNameParam', {
            parameterName: `${props.ssmPrefix}/deploy/secrets-doc-name`,
            stringValue: this.deploySecretsDocName,
            description: 'SSM Automation document name for legacy secrets deployment (kept for backwards compatibility — SM-B supersedes)',
        });
        cleanup.addSsmParameter(`${props.ssmPrefix}/deploy/secrets-doc-name`, deployDocParam);

        const roleArnParam = new ssm.StringParameter(this, 'AutomationRoleArnParam', {
            parameterName: `${props.ssmPrefix}/bootstrap/automation-role-arn`,
            stringValue: automationRole.roleArn,
            description: 'IAM role ARN for SSM Automation execution',
        });
        cleanup.addSsmParameter(`${props.ssmPrefix}/bootstrap/automation-role-arn`, roleArnParam);

        const bootstrapLogGroupParam = new ssm.StringParameter(this, 'BootstrapLogGroupParam', {
            parameterName: `${props.ssmPrefix}/cloudwatch/ssm-bootstrap-log-group`,
            stringValue: this.bootstrapLogGroup.logGroupName,
            description: 'CloudWatch Log Group for SSM RunCommand bootstrap output',
        });
        cleanup.addSsmParameter(`${props.ssmPrefix}/cloudwatch/ssm-bootstrap-log-group`, bootstrapLogGroupParam);

        const deployLogGroupParam = new ssm.StringParameter(this, 'DeployLogGroupParam', {
            parameterName: `${props.ssmPrefix}/cloudwatch/ssm-deploy-log-group`,
            stringValue: this.deployLogGroup.logGroupName,
            description: 'CloudWatch Log Group for SSM RunCommand deploy output',
        });
        cleanup.addSsmParameter(`${props.ssmPrefix}/cloudwatch/ssm-deploy-log-group`, deployLogGroupParam);

        // =====================================================================
        // Step Functions Orchestrator — EventBridge → State Machine → SSM
        // =====================================================================

        const orchestrator = new BootstrapOrchestratorConstruct(this, 'Orchestrator', {
            prefix,
            ssmPrefix: props.ssmPrefix,
            automationRoleArn: automationRole.roleArn,
            scriptsBucketName: props.scriptsBucketName,
            bootstrapRunnerName: bootstrapRunner.documentName,
            bootstrapLogGroupName: this.bootstrapLogGroup.logGroupName,
        });

        this.stateMachineArn = orchestrator.stateMachine.stateMachineArn;

        const smArnParam = new ssm.StringParameter(this, 'StateMachineArnParam', {
            parameterName: `${props.ssmPrefix}/bootstrap/state-machine-arn`,
            stringValue: orchestrator.stateMachine.stateMachineArn,
            description: 'Step Functions bootstrap orchestrator state machine ARN',
        });
        cleanup.addSsmParameter(`${props.ssmPrefix}/bootstrap/state-machine-arn`, smArnParam);

        // ── Grant State Machine Execution Role: SSM permissions ───────────────
        //
        // The Step Functions CallAwsService tasks use the SFn execution role
        // (not the SSM automationRole). We must grant it explicitly here.
        const smRole = orchestrator.stateMachine.role;

        smRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'SfnSendCommand',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:SendCommand',
                'ssm:GetCommandInvocation',
                'ssm:ListCommandInvocations',
                'ssm:CancelCommand',
            ],
            resources: ['*'],
        }));

        smRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'SfnSsmParameters',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:GetParameter',
                'ssm:PutParameter',
            ],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter${props.ssmPrefix}/*`,
            ],
        }));

        smRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'SfnCloudWatchLogs',
            effect: iam.Effect.ALLOW,
            actions: [
                'logs:CreateLogDelivery',
                'logs:GetLogDelivery',
                'logs:UpdateLogDelivery',
                'logs:DeleteLogDelivery',
                'logs:ListLogDeliveries',
                'logs:PutResourcePolicy',
                'logs:DescribeResourcePolicies',
                'logs:DescribeLogGroups',
            ],
            resources: ['*'],
        }));

        smRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'SfnXRay',
            effect: iam.Effect.ALLOW,
            actions: [
                'xray:PutTraceSegments',
                'xray:PutTelemetryRecords',
                'xray:GetSamplingRules',
                'xray:GetSamplingTargets',
            ],
            resources: ['*'],
        }));

        // Required for the NotifyConfigOrchestrator EventBridgePutEvents state
        // in the CP path of SM-A. Workers never reach this state so the grant
        // is safe (least-privilege: default bus only).
        smRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'SfnPutBootstrapEvent',
            effect: iam.Effect.ALLOW,
            actions: ['events:PutEvents'],
            resources: [
                `arn:aws:events:${this.region}:${this.account}:event-bus/default`,
            ],
        }));

        NagSuppressions.addResourceSuppressions(orchestrator.stateMachine, [{
            id: 'AwsSolutions-IAM5',
            reason: 'Step Functions CallAwsService tasks require ssm:SendCommand and ssm:GetCommandInvocation on \'*\' (instance IDs are resolved dynamically at runtime). CloudWatch log delivery actions also require \'*\'.',
        }, {
            id: 'AwsSolutions-SF1',
            reason: 'Step Functions logging is enabled via vendedlogs destination at LogLevel.ALL including execution data.',
        }, {
            id: 'AwsSolutions-SF2',
            reason: 'X-Ray tracing is enabled on the state machine.',
        }], true);

        cleanup.addLogGroup(`/aws/vendedlogs/states/${prefix}-bootstrap-orchestrator`, orchestrator.stateMachine);
        cleanup.addLogGroup(`/aws/lambda/${prefix}-bootstrap-router`, orchestrator.routerFunction);

        // =====================================================================
        // Config Orchestrator (SM-B) — App Config Injection
        // =====================================================================

        const configOrchestrator = new ConfigOrchestratorConstruct(this, 'ConfigOrchestrator', {
            prefix,
            ssmPrefix: props.ssmPrefix,
            scriptsBucketName: props.scriptsBucketName,
            deployRunnerName: deployRunner.documentName,
            deployLogGroupName: this.deployLogGroup.logGroupName,
        });

        this.configStateMachineArn = configOrchestrator.stateMachine.stateMachineArn;

        const configSmArnParam = new ssm.StringParameter(this, 'ConfigStateMachineArnParam', {
            parameterName: `${props.ssmPrefix}/bootstrap/config-state-machine-arn`,
            stringValue: configOrchestrator.stateMachine.stateMachineArn,
            description: 'Step Functions config orchestrator (SM-B) ARN — app secrets injection',
        });
        cleanup.addSsmParameter(`${props.ssmPrefix}/bootstrap/config-state-machine-arn`, configSmArnParam);

        const configSmRole = configOrchestrator.stateMachine.role;

        configSmRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'ConfigSmSendCommand',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:SendCommand',
                'ssm:GetCommandInvocation',
            ],
            resources: ['*'],
        }));

        configSmRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'ConfigSmSsmParams',
            effect: iam.Effect.ALLOW,
            actions: [
                'ssm:GetParameter',
                'ssm:PutParameter',
            ],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter${props.ssmPrefix}/*`,
            ],
        }));

        configSmRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'ConfigSmCloudWatchLogs',
            effect: iam.Effect.ALLOW,
            actions: [
                'logs:CreateLogDelivery',
                'logs:GetLogDelivery',
                'logs:UpdateLogDelivery',
                'logs:DeleteLogDelivery',
                'logs:ListLogDeliveries',
                'logs:PutResourcePolicy',
                'logs:DescribeResourcePolicies',
                'logs:DescribeLogGroups',
            ],
            resources: ['*'],
        }));

        configSmRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'ConfigSmXRay',
            effect: iam.Effect.ALLOW,
            actions: [
                'xray:PutTraceSegments',
                'xray:PutTelemetryRecords',
                'xray:GetSamplingRules',
                'xray:GetSamplingTargets',
            ],
            resources: ['*'],
        }));

        cleanup.addLogGroup(
            `/aws/vendedlogs/states/${prefix}-config-orchestrator`,
            configOrchestrator.stateMachine,
        );

        NagSuppressions.addResourceSuppressions(configOrchestrator.stateMachine, [{
            id: 'AwsSolutions-IAM5',
            reason: 'SM-B CallAwsService tasks require ssm:SendCommand/GetCommandInvocation on \'*\' (instance IDs are dynamic). CW log delivery requires \'*\'.',
        }, {
            id: 'AwsSolutions-SF1',
            reason: 'Step Functions logging is enabled via vendedlogs at LogLevel.ALL with execution data.',
        }, {
            id: 'AwsSolutions-SF2',
            reason: 'X-Ray tracing is enabled on the config state machine.',
        }], true);

        // =====================================================================
        // CloudWatch Alarm — Step Functions Execution Failures
        // =====================================================================

        const alarm = new BootstrapAlarmConstruct(this, 'BootstrapAlarm', {
            prefix,
            stateMachine: orchestrator.stateMachine,
            notificationEmail: props.notificationEmail,
        });

        automationRole.addToPolicy(new iam.PolicyStatement({
            sid: 'AllowSnsPublish',
            effect: iam.Effect.ALLOW,
            actions: ['sns:Publish'],
            resources: [alarm.topic.topicArn],
        }));

        cleanup.addSnsTopic(`${prefix}-bootstrap-alarm`, alarm.topic);

        // =====================================================================
        // Node Drift Enforcement — SSM State Manager Association
        // =====================================================================

        new NodeDriftEnforcementConstruct(this, 'DriftEnforcement', {
            prefix,
            targetEnvironment: props.targetEnvironment,
            ssmPrefix: props.ssmPrefix,
        });

        // =====================================================================
        // CDK-Nag Suppressions
        // =====================================================================

        NagSuppressions.addResourceSuppressions(automationRole, [{
            id: 'AwsSolutions-IAM5',
            reason: 'SSM RunCommand/AutomationIntrospection require wildcard resources (instance IDs and command IDs are resolved dynamically at runtime). SSM parameter prefix, S3 bucket objects, and CloudWatch log streams use wildcard suffixes as required by their respective APIs.',
        }], true);

        NagSuppressions.addResourceSuppressions(orchestrator.routerFunction, [{
            id: 'AwsSolutions-L1',
            reason: 'Python 3.13 is the latest GA Lambda runtime. PYTHON_3_14 is a CDK placeholder for an unreleased version.',
        }, {
            id: 'AwsSolutions-IAM4',
            reason: 'AWSLambdaBasicExecutionRole is the minimal managed policy for Lambda CloudWatch Logs access — standard CDK pattern.',
        }, {
            id: 'AwsSolutions-IAM5',
            reason: 'autoscaling:DescribeAutoScalingGroups requires wildcard resources (ASG names are resolved dynamically from EventBridge events). SSM parameter prefix uses wildcard suffix as required by the API.',
        }], true);

        NagSuppressions.addResourceSuppressions(cleanup, [{
            id: 'AwsSolutions-L1',
            reason: 'Python 3.13 is the latest GA Lambda runtime. Provider framework Lambda runtime is managed by CDK.',
        }, {
            id: 'AwsSolutions-IAM5',
            reason: 'Cleanup Lambda requires wildcard for log group/SSM parameter ARNs as orphaned resource names are dynamic.',
        }, {
            id: 'AwsSolutions-IAM4',
            reason: 'Provider framework uses AWS managed policy for Lambda basic execution — standard CDK pattern.',
        }], true);
    }
}
