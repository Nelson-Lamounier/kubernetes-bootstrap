/**
 * @format
 * Config Orchestrator Construct (SM-B — No-Op)
 *
 * All app secrets are now managed declaratively by ESO ExternalSecrets in
 * kubernetes-platform. SM-B is kept as a deployed shell (state machine +
 * EventBridge rule) so existing CDK stack references and the EventBridge
 * trigger remain intact without a destroy/redeploy cycle.
 *
 * The state machine does nothing operationally:
 *   ReadCpInstanceId → ExtractInstanceId → Succeed
 *
 * ## Migration history
 *   - monitoring secrets  → ESO ExternalSecrets (first migration)
 *   - nextjs secrets      → ESO ExternalSecrets
 *   - start-admin secrets → ESO ExternalSecrets
 *   - admin-api secrets   → ESO ExternalSecrets
 *   - public-api secrets  → ESO ExternalSecrets
 *   - wiki-mcp            → decommissioned in ai-applications
 */

import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

// =============================================================================
// TYPES
// =============================================================================

export interface ConfigOrchestratorProps {
    readonly prefix: string;
    readonly ssmPrefix: string;
    readonly region?: string;
}

// Custom EventBridge event emitted by SM-A at the end of the CP path only.
// SM-B listens on this instead of SM-A's generic SUCCEEDED so it fires exactly
// once per CP bootstrap, never on worker SM-A executions.
export const CP_BOOTSTRAP_EVENT_SOURCE      = 'custom.k8s-bootstrap';
export const CP_BOOTSTRAP_EVENT_DETAIL_TYPE = 'ControlPlaneBootstrapCompleted';

// =============================================================================
// CONSTRUCT
// =============================================================================

export class ConfigOrchestratorConstruct extends Construct {
    /** The Step Functions state machine (SM-B — no-op shell) */
    public readonly stateMachine: sfn.StateMachine;

    constructor(scope: Construct, id: string, props: ConfigOrchestratorProps) {
        super(scope, id);

        const stack = cdk.Stack.of(this);

        // =====================================================================
        // Read Control Plane Instance ID from SSM (kept for observability —
        // execution context shows which instance triggered the run)
        // =====================================================================

        const readInstanceId = new sfnTasks.CallAwsService(this, 'ReadCpInstanceId', {
            comment: 'Read control-plane instance ID written by SM-A UpdateInstanceId',
            service: 'ssm',
            action: 'getParameter',
            parameters: {
                Name: `${props.ssmPrefix}/bootstrap/control-plane-instance-id`,
            },
            iamResources: [
                `arn:aws:ssm:${stack.region}:${stack.account}:parameter${props.ssmPrefix}/*`,
            ],
            resultPath: '$.cpParam',
        });

        const extractInstanceId = new sfn.Pass(this, 'ExtractInstanceId', {
            comment: 'No-op — all app secrets now managed by ESO ExternalSecrets',
            parameters: {
                'instanceId.$': '$.cpParam.Parameter.Value',
                'trigger.$':    '$.trigger',
                'source.$':     '$.source',
            },
        });

        const succeed = new sfn.Succeed(this, 'NoOpComplete', {
            comment: 'SM-B is a no-op: ESO ExternalSecrets manage all app secrets declaratively',
        });

        readInstanceId.next(extractInstanceId);
        extractInstanceId.next(succeed);

        // =====================================================================
        // State Machine (SM-B)
        // =====================================================================

        const smLogGroup = new logs.LogGroup(this, 'ConfigOrchestratorLogs', {
            logGroupName:    `/aws/vendedlogs/states/${props.prefix}-config-orchestrator`,
            retention:       logs.RetentionDays.ONE_WEEK,
            removalPolicy:   cdk.RemovalPolicy.DESTROY,
        });

        this.stateMachine = new sfn.StateMachine(this, 'ConfigStateMachine', {
            stateMachineName: `${props.prefix}-config-orchestrator`,
            definitionBody:   sfn.DefinitionBody.fromChainable(
                sfn.Chain.start(readInstanceId),
            ),
            stateMachineType: sfn.StateMachineType.STANDARD,
            timeout:          cdk.Duration.hours(1),
            tracingEnabled:   true,
            comment:          'SM-B no-op shell. All app secrets managed by ESO ExternalSecrets.',
            logs: {
                destination:          smLogGroup,
                level:                sfn.LogLevel.ALL,
                includeExecutionData: true,
            },
        });

        // =====================================================================
        // EventBridge Rule — Self-Healing Trigger (kept for infrastructure
        // continuity; SM-B completes immediately since it's a no-op)
        // =====================================================================

        new events.Rule(this, 'PostBootstrapTrigger', {
            ruleName:    `${props.prefix}-post-bootstrap-config-trigger`,
            description: 'Triggers SM-B when CP bootstrap completes (no-op — ESO manages secrets)',
            eventPattern: {
                source:     [CP_BOOTSTRAP_EVENT_SOURCE],
                detailType: [CP_BOOTSTRAP_EVENT_DETAIL_TYPE],
            },
            targets: [
                new targets.SfnStateMachine(this.stateMachine, {
                    input: events.RuleTargetInput.fromObject({
                        trigger: 'post-bootstrap',
                        source:  'eventbridge',
                    }),
                }),
            ],
        });
    }
}
