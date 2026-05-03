/**
 * @format
 * Bootstrap Alarm Construct
 *
 * Centralised ops notifications for the K8s bootstrap pipeline:
 *
 * 1. **Bootstrap failures** — CloudWatch alarm on `ExecutionsFailed` for the
 *    Step Functions SM-A. Fires within 5 minutes of any execution failure.
 *
 * 2. **Node lifecycle events** — EventBridge rules for ASG instance launch and
 *    terminate events on all k8s ASGs. Fires when a node is replaced (manual
 *    termination, health-check replacement, or AMI refresh).
 *
 * ## Subscription
 * Email is read from the SSM parameter `{ssmPrefix}/ops-email` at CDK deploy
 * time. Set it once with:
 *   aws ssm put-parameter --name "/k8s/{env}/ops-email" \
 *     --value "you@example.com" --type String --overwrite
 *
 * An explicit `notificationEmail` prop overrides the SSM parameter (useful for
 * CI pipelines or local testing).
 */

import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

// =============================================================================
// TYPES
// =============================================================================

export interface BootstrapAlarmProps {
    /** Resource name prefix (e.g. 'k8s-dev') */
    readonly prefix: string;

    /** SSM parameter prefix (e.g. '/k8s/development').
     *  Used to read `{ssmPrefix}/ops-email` when `notificationEmail` is not set. */
    readonly ssmPrefix: string;

    /** Step Functions state machine to monitor for execution failures */
    readonly stateMachine: sfn.StateMachine;

    /**
     * Email address for alarm notifications.
     * When provided, overrides the `{ssmPrefix}/ops-email` SSM parameter.
     * When omitted, the SSM parameter is read at CDK deploy time.
     */
    readonly notificationEmail?: string;
}

// =============================================================================
// CONSTRUCT
// =============================================================================

export class BootstrapAlarmConstruct extends Construct {
    /** The CloudWatch alarm for SM-A execution failures */
    public readonly alarm: cloudwatch.Alarm;

    /** Shared SNS topic — receives both failure alarms and lifecycle events */
    public readonly topic: sns.Topic;

    constructor(scope: Construct, id: string, props: BootstrapAlarmProps) {
        super(scope, id);

        // ── SNS topic ────────────────────────────────────────────────────────

        this.topic = new sns.Topic(this, 'Topic', {
            topicName: `${props.prefix}-bootstrap-alarm`,
            displayName: `${props.prefix} K8s Bootstrap & Lifecycle Alerts`,
            enforceSSL: true,
        });

        // ── Email subscription ───────────────────────────────────────────────
        // Prefer explicit prop (CI override); fall back to SSM parameter so
        // deployments without NOTIFICATION_EMAIL still subscribe correctly.
        const email: string =
            props.notificationEmail ??
            ssm.StringParameter.valueForStringParameter(this, `${props.ssmPrefix}/ops-email`);

        this.topic.addSubscription(new sns_subscriptions.EmailSubscription(email));

        // ── Alarm: SM-A execution failures ───────────────────────────────────

        this.alarm = new cloudwatch.Alarm(this, 'Alarm', {
            alarmName: `${props.prefix}-bootstrap-orchestrator-errors`,
            alarmDescription:
                `Bootstrap orchestrator FAILED — a K8s node may not have bootstrapped.\n` +
                `State machine: ${props.stateMachine.stateMachineName}\n` +
                `Executions: https://console.aws.amazon.com/states/home#/statemachines/view/${props.stateMachine.stateMachineArn}`,
            metric: props.stateMachine.metricFailed({
                period: cdk.Duration.minutes(5),
                statistic: 'Sum',
            }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        this.alarm.addAlarmAction(new cloudwatchActions.SnsAction(this.topic));

        // ── EventBridge: node lifecycle notifications ────────────────────────
        //
        // Fires when any k8s ASG launches or terminates an instance.
        // Covers CP replacement, worker replacement (AMI refresh, health check).
        // These succeed in SM-A (SkipNonK8s or normal bootstrap) so they never
        // trigger the failure alarm — a separate notification is needed.
        //
        // Implementation note: rules use the L1 CfnRule.targets setter with
        // inputTransformer directly — avoiding events.RuleTargetInput.fromText()
        // which double-escapes \n via JSON.stringify() and produces literal \n
        // characters in the email body instead of real newlines.

        // Grant EventBridge service principal permission to publish to the topic.
        // Must be done manually when bypassing the L2 targets.SnsTopic construct.
        this.topic.grantPublish(new iam.ServicePrincipal('events.amazonaws.com'));

        const asgFilter = {
            source: ['aws.autoscaling'],
            detail: {
                AutoScalingGroupName: [{ prefix: `${props.prefix}-` }],
            },
        };

        // ── Rule: instance launched ──────────────────────────────────────────

        const launchRule = new events.Rule(this, 'NodeLaunchRule', {
            ruleName: `${props.prefix}-node-launched`,
            description: 'Notify when a K8s ASG launches a new instance (replacement or scale-out)',
            eventPattern: {
                ...asgFilter,
                detailType: ['EC2 Instance Launch Successful'],
            },
        });

        (launchRule.node.defaultChild as events.CfnRule).targets = [{
            id: 'SnsNotification',
            arn: this.topic.topicArn,
            inputTransformer: {
                inputPathsMap: {
                    instanceId: '$.detail.EC2InstanceId',
                    asgName: '$.detail.AutoScalingGroupName',
                    cause: '$.detail.Cause',
                    time: '$.time',
                },
                inputTemplate: [
                    `[${props.prefix}] NODE LAUNCHED`,
                    `----------------------------------`,
                    ``,
                    `  Instance  : <instanceId>`,
                    `  ASG       : <asgName>`,
                    `  Cause     : <cause>`,
                    `  Timestamp : <time>`,
                    ``,
                    `----------------------------------`,
                ].join('\n'),
            },
        }];

        // ── Rule: instance terminated ────────────────────────────────────────

        const terminateRule = new events.Rule(this, 'NodeTerminateRule', {
            ruleName: `${props.prefix}-node-terminated`,
            description: 'Notify when a K8s ASG terminates an instance (replacement or scale-in)',
            eventPattern: {
                ...asgFilter,
                detailType: ['EC2 Instance Terminate Successful'],
            },
        });

        (terminateRule.node.defaultChild as events.CfnRule).targets = [{
            id: 'SnsNotification',
            arn: this.topic.topicArn,
            inputTransformer: {
                inputPathsMap: {
                    instanceId: '$.detail.EC2InstanceId',
                    asgName: '$.detail.AutoScalingGroupName',
                    cause: '$.detail.Cause',
                    time: '$.time',
                },
                inputTemplate: [
                    `[${props.prefix}] NODE TERMINATED`,
                    `----------------------------------`,
                    ``,
                    `  Instance  : <instanceId>`,
                    `  ASG       : <asgName>`,
                    `  Cause     : <cause>`,
                    `  Timestamp : <time>`,
                    ``,
                    `----------------------------------`,
                ].join('\n'),
            },
        }];

        // ── Rule: instance launch failed ─────────────────────────────────────

        const launchFailRule = new events.Rule(this, 'NodeLaunchFailRule', {
            ruleName: `${props.prefix}-node-launch-failed`,
            description: 'Notify when a K8s ASG fails to launch an instance',
            eventPattern: {
                ...asgFilter,
                detailType: ['EC2 Instance Launch Unsuccessful'],
            },
        });

        (launchFailRule.node.defaultChild as events.CfnRule).targets = [{
            id: 'SnsNotification',
            arn: this.topic.topicArn,
            inputTransformer: {
                inputPathsMap: {
                    asgName: '$.detail.AutoScalingGroupName',
                    reason: '$.detail.StatusMessage',
                    time: '$.time',
                },
                inputTemplate: [
                    `[${props.prefix}] NODE LAUNCH FAILED`,
                    `----------------------------------`,
                    ``,
                    `  ASG       : <asgName>`,
                    `  Reason    : <reason>`,
                    `  Timestamp : <time>`,
                    ``,
                    `----------------------------------`,
                ].join('\n'),
            },
        }];
    }
}
