/**
 * @format
 * Bootstrap Alarm Construct
 *
 * CloudWatch alarm + SNS topic for Step Functions bootstrap failures.
 * Fires when any state machine execution fails (permissions, SSM
 * Automation failures, unhandled exceptions).
 *
 * @example
 * ```typescript
 * const alarm = new BootstrapAlarmConstruct(this, 'Alarm', {
 *     prefix: 'k8s',
 *     stateMachine: orchestrator.stateMachine,
 *     notificationEmail: 'ops@example.com',
 * });
 * ```
 */

import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

// =============================================================================
// TYPES
// =============================================================================

export interface BootstrapAlarmProps {
    /** Resource name prefix (e.g. 'k8s') */
    readonly prefix: string;

    /** Step Functions state machine to monitor */
    readonly stateMachine: sfn.StateMachine;

    /**
     * Email address for alarm notifications.
     * When provided, subscribes to the SNS topic.
     */
    readonly notificationEmail?: string;
}

// =============================================================================
// CONSTRUCT
// =============================================================================

export class BootstrapAlarmConstruct extends Construct {
    /** The CloudWatch alarm */
    public readonly alarm: cloudwatch.Alarm;

    /** The SNS notification topic */
    public readonly topic: sns.Topic;

    constructor(scope: Construct, id: string, props: BootstrapAlarmProps) {
        super(scope, id);

        this.topic = new sns.Topic(this, 'Topic', {
            topicName: `${props.prefix}-bootstrap-alarm`,
            displayName: `${props.prefix} Bootstrap Orchestrator Failure Alarm`,
            enforceSSL: true,  // AwsSolutions-SNS3: Require SSL for publishers
        });

        if (props.notificationEmail) {
            this.topic.addSubscription(
                new sns_subscriptions.EmailSubscription(props.notificationEmail),
            );
        }

        this.alarm = new cloudwatch.Alarm(this, 'Alarm', {
            alarmName: `${props.prefix}-bootstrap-orchestrator-errors`,
            alarmDescription:
                'Bootstrap orchestrator failed — K8s instance may not be bootstrapped. ' +
                'Check Step Functions execution history for ' + props.stateMachine.stateMachineName,
            metric: props.stateMachine.metricFailed({
                period: cdk.Duration.minutes(5),
                statistic: 'Sum',
            }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        });

        this.alarm.addAlarmAction(
            new cloudwatchActions.SnsAction(this.topic),
        );
    }
}
