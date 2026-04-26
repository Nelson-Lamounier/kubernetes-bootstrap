/**
 * @format
 * Golden AMI Alert Construct
 *
 * SNS topic + EventBridge rule that fires when an EC2 Image Builder build
 * for this stack's recipe transitions to FAILED, CANCELLED, or TIMED_OUT.
 *
 * Why this exists:
 *   The downstream EC2 launch template silently resolves to whatever AMI
 *   the SSM parameter currently points at — a failed bake leaves the
 *   parameter pointing at the previous AMI and rolls forward without
 *   anyone noticing. This construct closes that gap by paging on FAILED
 *   states the moment Image Builder reports them, so a stale-AMI roll-
 *   forward is visible before downstream bootstrap fails.
 *
 * Event filter:
 *   Source        = aws.imagebuilder
 *   Detail-type   = "EC2 Image Builder Image State Change"
 *   detail.state  ∈ { FAILED, CANCELLED, TIMED_OUT }
 *   resources[0]  prefix-matches arn:<partition>:imagebuilder:<region>:
 *                 <account>:image/<recipeName> — scopes alerts to this
 *                 stack's pipeline so sibling pipelines in the same
 *                 account do not page this topic.
 *
 * @example
 * ```typescript
 * new GoldenAmiAlertConstruct(this, 'AmiAlert', {
 *     namePrefix: 'k8s-development',
 *     recipeName: 'k8s-development-golden-ami-recipe',
 *     notificationEmail: 'ops@example.com',
 * });
 * ```
 */

import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

// =============================================================================
// TYPES
// =============================================================================

export interface GoldenAmiAlertProps {
    /** Resource name prefix (e.g. 'k8s-development') */
    readonly namePrefix: string;

    /**
     * Image Builder recipe name to scope the EventBridge filter to.
     * Must match the recipe's `name` property — the construct builds an
     * ARN prefix from this value to ignore unrelated pipelines.
     */
    readonly recipeName: string;

    /**
     * Email address for failure notifications.
     * When provided, subscribes to the SNS topic. Confirmation email is
     * sent to the address on first deploy.
     */
    readonly notificationEmail?: string;
}

// =============================================================================
// CONSTRUCT
// =============================================================================

export class GoldenAmiAlertConstruct extends Construct {
    /** SNS topic that receives Image Builder failure events */
    public readonly topic: sns.Topic;

    /** EventBridge rule wired to the topic */
    public readonly rule: events.Rule;

    constructor(scope: Construct, id: string, props: GoldenAmiAlertProps) {
        super(scope, id);

        const { namePrefix, recipeName, notificationEmail } = props;

        this.topic = new sns.Topic(this, 'Topic', {
            topicName: `${namePrefix}-golden-ami-failure`,
            displayName: `${namePrefix} Golden AMI build failure`,
            enforceSSL: true,
        });

        if (notificationEmail) {
            this.topic.addSubscription(
                new sns_subscriptions.EmailSubscription(notificationEmail),
            );
        }

        // Recipe ARN prefix scopes the rule to this pipeline. Image Builder
        // emits image-state-change events with resources[0] = full image
        // ARN, which starts with the recipe ARN.
        const stack = cdk.Stack.of(this);
        const recipeArnPrefix = `arn:${stack.partition}:imagebuilder:${stack.region}:${stack.account}:image/${recipeName}`;

        this.rule = new events.Rule(this, 'FailureRule', {
            ruleName: `${namePrefix}-golden-ami-failure`,
            description: `Page on ${namePrefix} Golden AMI build failure`,
            eventPattern: {
                source: ['aws.imagebuilder'],
                detailType: ['EC2 Image Builder Image State Change'],
                detail: {
                    state: {
                        status: ['FAILED', 'CANCELLED', 'TIMED_OUT'],
                    },
                },
                resources: events.Match.prefix(recipeArnPrefix),
            },
        });

        this.rule.addTarget(new targets.SnsTopic(this.topic, {
            message: events.RuleTargetInput.fromText(
                [
                    `⚠ Golden AMI build FAILED for ${namePrefix}.`,
                    '',
                    `State:    ${events.EventField.fromPath('$.detail.state.status')}`,
                    `Reason:   ${events.EventField.fromPath('$.detail.state.reason')}`,
                    `Image:    ${events.EventField.fromPath('$.resources[0]')}`,
                    `Time:     ${events.EventField.fromPath('$.time')}`,
                    `Region:   ${events.EventField.fromPath('$.region')}`,
                    `Account:  ${events.EventField.fromPath('$.account')}`,
                    '',
                    'Tail component logs:',
                    `  aws logs tail /aws/imagebuilder/${recipeName} --since 1h --region ${stack.region}`,
                    '',
                    'Inspect the failed component build:',
                    `  aws imagebuilder get-image --image-build-version-arn ${events.EventField.fromPath('$.resources[0]')} --region ${stack.region}`,
                    '',
                    'Until this is fixed, the Golden AMI SSM parameter still points at',
                    'the previous successful build — downstream EC2 launches will roll',
                    'forward on the older AMI.',
                ].join('\n'),
            ),
        }));
    }
}
