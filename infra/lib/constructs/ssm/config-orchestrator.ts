/**
 * @format
 * Config Orchestrator Construct (SM-B — App Config Injection)
 *
 * Step Functions state machine responsible for injecting runtime application
 * configuration (SSM parameters → Kubernetes Secrets and ConfigMaps) after
 * the cluster infrastructure is confirmed healthy.
 *
 * ## Separation of Concerns
 * SM-B owns everything that touches application configuration:
 *   - nextjs/deploy.py       — nextjs-secrets K8s Secret + IngressRoute originSecret
 *   - monitoring/deploy.py   — grafana + github K8s Secrets + Helm chart (Grafana reset)
 *   - start-admin/deploy.py  — start-admin-secrets K8s Secret (Cognito / DynamoDB / Bedrock)
 *   - admin-api/deploy.py    — admin-api K8s Secret + ConfigMap + IngressRoute
 *   - public-api/deploy.py   — public-api K8s Secret + ConfigMap + IngressRoute
 *   - wiki-mcp/deploy.py     — wiki-mcp-config ConfigMap + wiki-mcp-basicauth Secret
 *
 * ## Self-Healing Trigger (Primary Path)
 * An EventBridge rule listens for `ExecutionSucceeded` events from SM-A
 * (BootstrapOrchestratorConstruct). When SM-A completes, SM-B starts
 * automatically — ensuring every cluster rebuild re-injects all app secrets
 * without manual intervention or a GHA run.
 */

import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import { JsonPath } from 'aws-cdk-lib/aws-stepfunctions';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as cdk from 'aws-cdk-lib/core';

import { Construct } from 'constructs';

// =============================================================================
// TYPES
// =============================================================================

export interface ConfigStep {
    name: string;
    scriptPath: string;
    timeoutSeconds: number;
    description: string;
}

export interface ConfigOrchestratorProps {
    readonly prefix: string;
    readonly ssmPrefix: string;
    readonly scriptsBucketName: string;
    readonly deployRunnerName: string;
    readonly deployLogGroupName: string;
    readonly region?: string;
}

// Custom EventBridge event emitted by SM-A at the end of the CP path only.
// SM-B listens on this instead of SM-A's generic SUCCEEDED so it fires exactly
// once per CP bootstrap, never on worker SM-A executions.
export const CP_BOOTSTRAP_EVENT_SOURCE      = 'custom.k8s-bootstrap';
export const CP_BOOTSTRAP_EVENT_DETAIL_TYPE = 'ControlPlaneBootstrapCompleted';

// =============================================================================
// STEP DEFINITIONS
// =============================================================================

/**
 * Ordered list of app config deploy scripts.
 *
 * Sequential order is intentional:
 *   1. nextjs     — public-facing app, highest priority
 *   2. monitoring — Grafana/Prometheus secrets (independent of app secrets)
 *   3. start-admin — admin panel (internal tooling)
 *   4. admin-api  — BFF service (depends on start-admin Cognito pool)
 *   5. public-api — BFF service (depends on DynamoDB/Bedrock config)
 *   6. wiki-mcp   — FastMCP server (ConfigMap + basicauth Secret from SSM)
 */
const DEPLOY_STEPS: ConfigStep[] = [
    {
        name: 'DeployNextjsSecrets',
        scriptPath: 'app-deploy/nextjs/deploy.py',
        timeoutSeconds: 300,
        description: 'nextjs-secrets K8s Secret + IngressRoute originSecret',
    },
    {
        name: 'DeployMonitoringSecrets',
        scriptPath: 'app-deploy/monitoring/deploy.py',
        timeoutSeconds: 600,
        description: 'Monitoring K8s Secrets + Helm chart install',
    },
    {
        name: 'DeployStartAdminSecrets',
        scriptPath: 'app-deploy/start-admin/deploy.py',
        timeoutSeconds: 300,
        description: 'start-admin-secrets K8s Secret (Cognito/DynamoDB/Bedrock)',
    },
    {
        name: 'DeployAdminApiSecrets',
        scriptPath: 'app-deploy/admin-api/deploy.py',
        timeoutSeconds: 300,
        description: 'admin-api K8s Secret + ConfigMap + IngressRoute',
    },
    {
        name: 'DeployPublicApiSecrets',
        scriptPath: 'app-deploy/public-api/deploy.py',
        timeoutSeconds: 300,
        description: 'public-api K8s Secret + ConfigMap + IngressRoute',
    },
    {
        name: 'DeployWikiMcpConfig',
        scriptPath: 'app-deploy/wiki-mcp/deploy.py',
        timeoutSeconds: 120,
        description: 'wiki-mcp-config ConfigMap + wiki-mcp-basicauth Secret',
    },
];

// =============================================================================
// CONSTRUCT
// =============================================================================

export class ConfigOrchestratorConstruct extends Construct {
    /** The Step Functions state machine that drives app config injection (SM-B) */
    public readonly stateMachine: sfn.StateMachine;

    constructor(scope: Construct, id: string, props: ConfigOrchestratorProps) {
        super(scope, id);

        const stack = cdk.Stack.of(this);
        const region = props.region ?? stack.region;

        // =====================================================================
        // Step 1: Read Control Plane Instance ID from SSM
        //
        // SM-A writes the CP instance ID to SSM during UpdateInstanceId.
        // SM-B reads it here at execution start — no router Lambda needed.
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
            comment: 'Flatten SSM response and seed execution context for all deploy steps',
            parameters: {
                'instanceId.$': '$.cpParam.Parameter.Value',
                // ssmPrefix and s3Bucket are static at synth time but must be in the
                // execution context so each deploy step's sendCommand can read them
                // via JsonPath.stringAt('$.ssmPrefix') / JsonPath.stringAt('$.s3Bucket').
                ssmPrefix:      props.ssmPrefix,
                s3Bucket:       props.scriptsBucketName,
                'trigger.$':    '$.trigger',
                'source.$':     '$.source',
            },
        });

        readInstanceId.next(extractInstanceId);

        // =====================================================================
        // Step 2-N: Build send → wait → poll chain per deploy step
        //
        // Each step follows the same pattern as BootstrapOrchestratorConstruct:
        //   sendCommand → initCounter → wait → poll → checkStatus → (next step | Fail)
        // =====================================================================

        interface StepChain { start: sfn.State; successPass: sfn.Pass }

        const buildDeployStep = (step: ConfigStep): StepChain => {
            const id = step.name;
            const safeId = id.replace(/-/g, '');

            const sendFailed = new sfn.Fail(this, `${id}SendFailed`, {
                error: `${id}SendFailed`,
                cause: `SSM SendCommand failed for ${step.scriptPath}`,
            });
            const stepFailed = new sfn.Fail(this, `${id}Failed`, {
                error: `${id}Failed`,
                cause: `${step.scriptPath}: ${step.description}`,
            });

            // 1. Send SSM RunCommand
            const sendCommand = new sfnTasks.CallAwsService(this, `${id}Send`, {
                comment: step.description,
                service: 'ssm',
                action: 'sendCommand',
                parameters: {
                    DocumentName: props.deployRunnerName,
                    InstanceIds:  JsonPath.array(JsonPath.stringAt('$.instanceId')),
                    Parameters: {
                        ScriptPath: JsonPath.array(step.scriptPath),
                        SsmPrefix:  JsonPath.array(JsonPath.stringAt('$.ssmPrefix')),
                        S3Bucket:   JsonPath.array(JsonPath.stringAt('$.s3Bucket')),
                        Region:     JsonPath.array(region),
                    },
                    CloudWatchOutputConfig: {
                        CloudWatchLogGroupName:  props.deployLogGroupName,
                        CloudWatchOutputEnabled: true,
                    },
                    TimeoutSeconds: step.timeoutSeconds,
                },
                iamResources: ['*'],
                resultSelector: {
                    'CommandId.$': '$.Command.CommandId',
                },
                resultPath: `$.${safeId}Result`,
            });
            sendCommand.addCatch(sendFailed, { errors: ['States.ALL'] });

            // 2. Init poll counter
            const pollCountPath = `$.${safeId}PollCount`;
            const initCounter = new sfn.CustomState(this, `${id}InitCounter`, {
                stateJson: {
                    Type: 'Pass',
                    Result: { value: 0 },
                    ResultPath: pollCountPath,
                },
            });

            // 3. Wait 30 s
            const waitState = new sfn.Wait(this, `${id}Wait`, {
                time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
            });

            // 4. Poll
            const pollStatus = new sfnTasks.CallAwsService(this, `${id}Poll`, {
                service: 'ssm',
                action: 'getCommandInvocation',
                parameters: {
                    CommandId:  JsonPath.stringAt(`$.${safeId}Result.CommandId`),
                    InstanceId: JsonPath.stringAt('$.instanceId'),
                },
                iamResources: ['*'],
                resultSelector: { 'Status.$': '$.Status' },
                resultPath: `$.${safeId}Status`,
            });

            // 5. Increment counter
            const MAX_POLL = Math.ceil(step.timeoutSeconds / 30) + 10;
            const incrCounter = new sfn.CustomState(this, `${id}IncrCounter`, {
                stateJson: {
                    Type: 'Pass',
                    Parameters: {
                        'value.$': `States.MathAdd(${pollCountPath}.value, 1)`,
                    },
                    ResultPath: pollCountPath,
                },
            });

            // 6. Timeout guard
            const pollFailed = new sfn.Fail(this, `${id}Timeout`, {
                error: `${id}Timeout`,
                cause: `${step.scriptPath} did not complete within ${step.timeoutSeconds}s`,
            });

            const timeoutGuard = new sfn.Choice(this, `${id}TimeoutCheck`)
                .when(
                    sfn.Condition.numberGreaterThanEquals(`${pollCountPath}.value`, MAX_POLL),
                    pollFailed,
                )
                .otherwise(waitState);

            // 7. Success pass
            const successPass = new sfn.Pass(this, `${id}Succeeded`, {
                parameters: {
                    'instanceId.$': '$.instanceId',
                    'ssmPrefix.$':  '$.ssmPrefix',
                    's3Bucket.$':   '$.s3Bucket',
                    'trigger.$':    '$.trigger',
                    'source.$':     '$.source',
                },
            });

            // 8. Status branch
            const checkStatus = new sfn.Choice(this, `${id}CheckStatus`)
                .when(
                    sfn.Condition.stringEquals(`$.${safeId}Status.Status`, 'Success'),
                    successPass,
                )
                .when(
                    sfn.Condition.or(
                        sfn.Condition.stringEquals(`$.${safeId}Status.Status`, 'InProgress'),
                        sfn.Condition.stringEquals(`$.${safeId}Status.Status`, 'Pending'),
                        sfn.Condition.stringEquals(`$.${safeId}Status.Status`, 'Delayed'),
                    ),
                    incrCounter,
                )
                .otherwise(stepFailed);

            sendCommand
                .next(initCounter)
                .next(waitState)
                .next(pollStatus)
                .next(checkStatus);
            incrCounter.next(timeoutGuard);

            return { start: sendCommand, successPass };
        };

        // =====================================================================
        // Build parallel deploy branches
        //
        // Steps are grouped into 4 concurrent branches. Max wall-clock time
        // drops from sum(all timeouts)=1920s to max(branch times)=900s.
        //
        // Branch A: nextjs (300s) — independent
        // Branch B: monitoring (600s) — independent
        // Branch C: start-admin→admin-api→public-api (300+300+300=900s) — sequential
        //           admin-api/public-api are downstream of start-admin's Cognito config
        // Branch D: wiki-mcp (120s) — independent
        // =====================================================================

        const [
            nextjsStep,
            monitoringStep,
            startAdminStep,
            adminApiStep,
            publicApiStep,
            wikiMcpStep,
        ] = DEPLOY_STEPS.map(buildDeployStep);

        // Branch C: start-admin → admin-api → public-api (preserve ordering)
        startAdminStep!.successPass.next(adminApiStep!.start);
        adminApiStep!.successPass.next(publicApiStep!.start);

        const deployParallel = new sfn.Parallel(this, 'DeployAllConfig', {
            resultPath: sfn.JsonPath.DISCARD,
            comment: 'Deploy all app config concurrently — independent branches run in parallel',
        });

        deployParallel.branch(sfn.Chain.start(nextjsStep!.start));
        deployParallel.branch(sfn.Chain.start(monitoringStep!.start));
        deployParallel.branch(sfn.Chain.start(startAdminStep!.start));
        deployParallel.branch(sfn.Chain.start(wikiMcpStep!.start));

        const succeed = new sfn.Succeed(this, 'ConfigApplied', {
            comment: 'All app config deploy scripts completed successfully',
        });
        deployParallel.next(succeed);

        // Entry: ReadCpInstanceId → ExtractInstanceId → parallel deploy
        extractInstanceId.next(deployParallel);

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
            // STANDARD (not EXPRESS) — Express Workflows cap at 5 minutes.
            // SM-B may run up to 1 hour across 5 sequential deploy scripts.
            stateMachineType: sfn.StateMachineType.STANDARD,
            timeout:          cdk.Duration.hours(1),
            tracingEnabled:   true,
            comment:          'Injects SSM-sourced app config into K8s. Triggered by SM-A SUCCEEDED for self-healing.',
            logs: {
                destination:          smLogGroup,
                level:                sfn.LogLevel.ALL,
                includeExecutionData: true,
            },
        });

        // =====================================================================
        // EventBridge Rule — Self-Healing Trigger
        //
        // Listens for a custom event emitted by SM-A's NotifyConfigOrchestrator
        // state, which fires ONLY at the end of the control-plane path — never
        // on worker SM-A executions. This prevents SM-B from running 3× per
        // deployment (once per SM-A SUCCEEDED, i.e. CP + 2 workers).
        // =====================================================================

        new events.Rule(this, 'PostBootstrapTrigger', {
            ruleName:    `${props.prefix}-post-bootstrap-config-trigger`,
            description: 'Triggers SM-B when CP bootstrap completes (custom event, not generic SM-A SUCCEEDED)',
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
