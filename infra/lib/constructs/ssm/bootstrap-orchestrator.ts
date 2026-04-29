/**
 * @format
 * Bootstrap Orchestrator Construct (SM-A — Cluster Infrastructure Only)
 *
 * Step Functions state machine that orchestrates K8s cluster infrastructure:
 *   1. Router Lambda reads ASG tags and resolves instance constraints
 *   2. Updates instance-id SSM parameter
 *   3. Triggers targeted SSM RunCommand scripts natively
 *   4. Polls for completion (wait → check → loop)
 *   5. For control-plane: waits for CA hash publication, then re-joins all worker pools in parallel
 *
 * ## Scope
 * SM-A is responsible for cluster infrastructure only:
 *   - control_plane.ts — kubeadm init, Calico, CCM, ArgoCD bootstrap
 *   - worker.ts — kubeadm join, CloudWatch, EIP association
 *
 * Application config (Secrets, ConfigMaps) is owned declaratively by ESO
 * (External Secrets Operator) and ArgoCD reconciliation — no post-bootstrap
 * orchestrator runs. After SM-A SUCCEEDS, ESO syncs Secrets from AWS Secrets
 * Manager / SSM, and ArgoCD reconciles all Application manifests from Git.
 *
 * Non-K8s ASGs are silently ignored (no `k8s:bootstrap-role` tag).
 */

import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { JsonPath } from "aws-cdk-lib/aws-stepfunctions";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as sfnTasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import * as cdk from "aws-cdk-lib/core";

import { Construct } from "constructs";

// =============================================================================
// TYPES
// =============================================================================

export interface BootstrapOrchestratorProps {
  readonly prefix: string;
  readonly ssmPrefix: string;
  readonly automationRoleArn: string;
  readonly scriptsBucketName: string;
  /** SSM Run Command document name for bootstrap scripts (control_plane.ts, worker.ts) */
  readonly bootstrapRunnerName: string;
  /** CloudWatch Log Group name for bootstrap RunCommand output */
  readonly bootstrapLogGroupName: string;
}

export interface BootstrapStep {
  name: string;
  scriptPath: string;
  timeoutSeconds: number;
  description: string;
}

// =============================================================================
// STEP DEFINITIONS
// =============================================================================

const CONTROL_PLANE_STEPS: BootstrapStep[] = [
  {
    name: "BootstrapControlPlane",
    scriptPath: "sm-a/boot/steps/control_plane.ts",
    timeoutSeconds: 1800,
    description: "Run consolidated control plane bootstrap",
  },
];

const WORKER_STEPS: BootstrapStep[] = [
  {
    name: "BootstrapWorker",
    scriptPath: "sm-a/boot/steps/worker.ts",
    timeoutSeconds: 900,
    description: "Run consolidated worker bootstrap",
  },
];

// =============================================================================
// CONSTRUCT
// =============================================================================

export class BootstrapOrchestratorConstruct extends Construct {
  /** The Step Functions state machine that drives the entire bootstrap flow */
  public readonly stateMachine: sfn.StateMachine;

  /** Thin router Lambda that reads ASG tags and resolves role/instanceId/s3Bucket */
  public readonly routerFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: BootstrapOrchestratorProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    // =====================================================================
    // Router Lambda
    // =====================================================================

    const routerLogGroup = new logs.LogGroup(this, "RouterLogs", {
      logGroupName: `/aws/lambda/${props.prefix}-bootstrap-router`,
      retention: logs.RetentionDays.THREE_DAYS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.routerFunction = new lambda.Function(this, "RouterFn", {
      functionName: `${props.prefix}-bootstrap-router`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "index.handler",
      logGroup: routerLogGroup,
      code: lambda.Code.fromInline(`
import logging, boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

asg_client = boto3.client("autoscaling")
ssm_client = boto3.client("ssm")

def _skip(reason):
    logger.info("Skipping: %s", reason)
    return {
        "role": None,
        "instanceId": "",
        "asgName": "",
        "ssmPrefix": "",
        "s3Bucket": "",
        "region": "",
        "reason": reason,
    }

def handler(event, context):
    detail = event.get("detail", {})
    instance_id = detail.get("EC2InstanceId", "")
    asg_name = detail.get("AutoScalingGroupName", "")

    if not instance_id or not asg_name:
        return _skip("Missing instance or ASG info")

    logger.info("Instance launched: %s in ASG %s", instance_id, asg_name)

    resp = asg_client.describe_auto_scaling_groups(AutoScalingGroupNames=[asg_name])
    groups = resp.get("AutoScalingGroups", [])
    if not groups:
        return _skip(f"ASG {asg_name} not found")

    tags = {t["Key"]: t["Value"] for t in groups[0].get("Tags", [])}
    role = tags.get("k8s:bootstrap-role")
    ssm_prefix = tags.get("k8s:ssm-prefix")

    if not role or not ssm_prefix:
        return _skip(f"No k8s tags on ASG {asg_name}")

    s3_bucket = ssm_client.get_parameter(Name=f"{ssm_prefix}/scripts-bucket")["Parameter"]["Value"]

    result = {
        "role": role,
        "instanceId": instance_id,
        "asgName": asg_name,
        "ssmPrefix": ssm_prefix,
        "s3Bucket": s3_bucket,
        "region": context.invoked_function_arn.split(":")[3],
        "reason": "ok",
    }
    logger.info("Router result: %s", result)
    return result
`),
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      tracing: lambda.Tracing.ACTIVE,
      description:
        "Thin router: reads ASG tags and resolves details for Step Functions",
    });

    this.routerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "RouterDescribeAsg",
        effect: iam.Effect.ALLOW,
        actions: ["autoscaling:DescribeAutoScalingGroups"],
        resources: ["*"],
      }),
    );

    this.routerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "RouterReadSsmParams",
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${stack.region}:${stack.account}:parameter${props.ssmPrefix}/*`,
        ],
      }),
    );

    // =====================================================================
    // Step Functions State Machine
    // =====================================================================

    const invokeRouter = new sfnTasks.LambdaInvoke(this, "InvokeRouter", {
      lambdaFunction: this.routerFunction,
      resultSelector: {
        "role.$": "$.Payload.role",
        "instanceId.$": "$.Payload.instanceId",
        "asgName.$": "$.Payload.asgName",
        "ssmPrefix.$": "$.Payload.ssmPrefix",
        "s3Bucket.$": "$.Payload.s3Bucket",
        "region.$": "$.Payload.region",
      },
      resultPath: "$.router",
      comment: "Read ASG tags to identify role",
    });

    const skipNonK8s = new sfn.Succeed(this, "SkipNonK8s", {
      comment: "Not a K8s ASG — no bootstrap role tag",
    });

    const updateInstanceId = new sfnTasks.CallAwsService(
      this,
      "UpdateInstanceId",
      {
        service: "ssm",
        action: "putParameter",
        parameters: {
          Name: JsonPath.format(
            "{}/bootstrap/{}-instance-id",
            JsonPath.stringAt("$.router.ssmPrefix"),
            JsonPath.stringAt("$.router.role"),
          ),
          Value: JsonPath.stringAt("$.router.instanceId"),
          Type: "String",
          Overwrite: true,
        },
        iamResources: [
          `arn:aws:ssm:${stack.region}:${stack.account}:parameter${props.ssmPrefix}/*`,
        ],
        resultPath: JsonPath.DISCARD,
        comment: "Update logical role SSM instance ID mapping",
      },
    );

    const chainSteps = (
      steps: BootstrapStep[],
      runnerDocName: string,
      logGroupName: string,
    ) => {
      if (steps.length === 0) throw new Error("Cannot chain empty steps array");
      const builtSteps = steps.map((step) =>
        this.buildRunCommandChain(
          step,
          runnerDocName,
          logGroupName,
          "$.router.instanceId",
          "$.router.ssmPrefix",
          "$.router.s3Bucket",
          "$.router.region",
        ),
      );

      for (let i = 0; i < builtSteps.length - 1; i++) {
        builtSteps[i].end.next(builtSteps[i + 1].start);
      }

      return {
        start: builtSteps[0].start,
        end: builtSteps[builtSteps.length - 1].end,
      };
    };

    const cpSteps = chainSteps(
      CONTROL_PLANE_STEPS,
      props.bootstrapRunnerName,
      props.bootstrapLogGroupName,
    );
    const workerSteps = chainSteps(
      WORKER_STEPS,
      props.bootstrapRunnerName,
      props.bootstrapLogGroupName,
    );

    // ── Poll SSM for join-token instead of a fixed 15-minute sleep ──────────
    //
    // control_plane.py writes /k8s/{env}/join-token after kubeadm init.
    // Workers need this token to join the cluster. Instead of sleeping a
    // fixed 15 minutes, poll SSM every 30s for up to 20 minutes (40 attempts).
    const CA_POLL_MAX = 40; // 40 × 30s = 20 min

    const initCaPollCount = new sfn.CustomState(this, "InitCaPollCount", {
      stateJson: {
        Type: "Pass",
        Result: { value: 0 },
        ResultPath: "$.CaPollCount",
      },
    });

    const checkCaParam = new sfnTasks.CallAwsService(this, "CheckCaParam", {
      service: "ssm",
      action: "getParameter",
      parameters: {
        Name: JsonPath.format(
          "{}/join-token",
          JsonPath.stringAt("$.router.ssmPrefix"),
        ),
      },
      iamResources: [
        `arn:aws:ssm:${stack.region}:${stack.account}:parameter${props.ssmPrefix}/*`,
      ],
      resultPath: JsonPath.DISCARD,
      comment: "Poll SSM for join-token written by control_plane.py after kubeadm init",
    });

    const waitForCaPoll = new sfn.Wait(this, "WaitForCaPublish", {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
      comment: "Wait 30s before re-checking join-token in SSM",
    });

    const incrCaPollCount = new sfn.CustomState(this, "IncrCaPollCount", {
      stateJson: {
        Type: "Pass",
        Parameters: {
          "value.$": "States.MathAdd($.CaPollCount.value, 1)",
        },
        ResultPath: "$.CaPollCount",
      },
    });

    const caPublishTimeout = new sfn.Fail(this, "CaPublishTimeout", {
      error: "CaPublishTimeout",
      cause:
        "join-token not published to SSM within 20 min of CP completion — " +
        "check control_plane.py CloudWatch logs for kubeadm init failure",
    });

    const checkCaPollMax = new sfn.Choice(this, "CaPollMaxCheck", {
      comment: "Abort if join-token still absent after 20 min",
    })
      .when(
        sfn.Condition.numberGreaterThanEquals("$.CaPollCount.value", CA_POLL_MAX),
        caPublishTimeout,
      )
      .otherwise(waitForCaPoll);

    checkCaParam.addCatch(incrCaPollCount, {
      errors: ["States.ALL"],
      resultPath: JsonPath.DISCARD,
    });
    incrCaPollCount.next(checkCaPollMax);
    waitForCaPoll.next(checkCaParam);

    const cpSucceed = new sfn.Succeed(this, "ControlPlaneBootstrapped", {
      comment: "CP bootstrap complete — workers start via their own SM-A executions",
    });

    checkCaParam.next(cpSucceed);
    cpSteps.end.next(initCaPollCount);
    initCaPollCount.next(checkCaParam);

    const cpChain = sfn.Chain.start(cpSteps.start);
    const workerChain = sfn.Chain.start(workerSteps.start);

    const roleBranch = new sfn.Choice(this, "RoleBranch")
      .when(
        sfn.Condition.stringEquals("$.router.role", "control-plane"),
        cpChain,
      )
      .otherwise(workerChain);

    const hasRole = new sfn.Choice(this, "HasRole")
      .when(
        sfn.Condition.isPresent("$.router.role"),
        new sfn.Choice(this, "RoleNotNull")
          .when(sfn.Condition.isNull("$.router.role"), skipNonK8s)
          .otherwise(updateInstanceId.next(roleBranch)),
      )
      .otherwise(skipNonK8s);

    const definition = sfn.Chain.start(invokeRouter).next(hasRole);

    const sfnLogGroup = new logs.LogGroup(this, "OrchestratorLogs", {
      logGroupName: `/aws/vendedlogs/states/${props.prefix}-bootstrap-orchestrator`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.stateMachine = new sfn.StateMachine(this, "StateMachine", {
      stateMachineName: `${props.prefix}-bootstrap-orchestrator`,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.hours(2),
      tracingEnabled: true,
      comment:
        "Orchestrates K8s instance bootstrap using native SSM SendCommand",
      logs: {
        destination: sfnLogGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
    });

    new events.Rule(this, "AutoBootstrapRule", {
      ruleName: `${props.prefix}-auto-bootstrap`,
      description:
        "Trigger Step Functions orchestrator when an ASG launches an instance",
      eventPattern: {
        source: ["aws.autoscaling"],
        detailType: ["EC2 Instance Launch Successful"],
        detail: {
          AutoScalingGroupName: [
            {
              prefix: `${props.prefix}-`,
            },
          ],
        },
      },
      targets: [new targets.SfnStateMachine(this.stateMachine)],
    });
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private buildRunCommandChain(
    step: BootstrapStep,
    runnerDocName: string,
    logGroupName: string,
    instanceIdPath: string,
    ssmPrefixPath: string,
    s3BucketPath: string,
    regionPath: string,
  ): { start: sfn.IChainable; end: sfn.Pass } {
    const id = step.name;
    // Step Functions intrinsic functions require dot-notation JSONPath.
    // Keys containing hyphens are invalid in dot-notation — strip them.
    const safeId = id.replace(/-/g, "");

    const MAX_POLL_ITERATIONS = Math.ceil(step.timeoutSeconds / 30);
    const pollCountPath = `$.${safeId}PollCount`;

    const sendFailed = new sfn.Fail(this, `${id}SendFailed`, {
      error: "SendCommandFailed",
      cause: `SSM SendCommand failed for step ${id}`,
    });

    const pollApiFailed = new sfn.Fail(this, `${id}PollApiFailed`, {
      error: "PollApiFailed",
      cause: `SSM getCommandInvocation API error for step ${id} — check CloudWatch log group: ${logGroupName}`,
    });

    const pollFailed = new sfn.Fail(this, `${id}PollFailed`, {
      causePath: `$.${safeId}FailCause.cause`,
      errorPath: `$.${safeId}FailCause.error`,
    });

    // Failure enrichment: fetch stdout/stderr, format a rich error cause string
    const fetchFailureOutput = new sfnTasks.CallAwsService(
      this,
      `${id}FetchOutput`,
      {
        service: "ssm",
        action: "getCommandInvocation",
        parameters: {
          CommandId: JsonPath.stringAt(`$.${id}Result.CommandId`),
          InstanceId: JsonPath.stringAt(instanceIdPath),
        },
        iamResources: ["*"],
        resultSelector: {
          "StatusDetails.$": "$.StatusDetails",
          "StandardOutputContent.$": "$.StandardOutputContent",
          "StandardErrorContent.$": "$.StandardErrorContent",
        },
        resultPath: `$.${safeId}FailureOutput`,
        comment: `Fetch SSM stdout/stderr for failure diagnostics (step ${id})`,
      },
    );
    fetchFailureOutput.addCatch(pollApiFailed, { errors: ["States.ALL"] });

    // Failure formatter: prioritise actionable pointers over inline log text.
    // Step Functions truncates the Cause field on display, and SSM stdout
    // already caps at ~24k chars upstream — embedding both means the most
    // useful part (stderr tail + the exact aws logs command) gets cut. So:
    //   1. Lead with the CommandId, InstanceId, and a ready-to-paste
    //      `aws logs tail` invocation pointing at the precise stream.
    //   2. Include stderr only (more diagnostic than stdout, typically short).
    //   3. Drop stdout from the Cause entirely — operators tail CloudWatch.
    const formatFailureCause = new sfn.CustomState(this, `${id}FormatCause`, {
      stateJson: {
        Type: "Pass",
        Parameters: {
          error: "CommandFailed",
          "cause.$": `States.Format('⚠ Bootstrap step ${id} FAILED.\nSSM status: {}.\nCommandId: {}\nInstanceId: {}\n\nTail full logs:\n  aws logs tail ${logGroupName} --log-stream-name-prefix {} --since 1h --follow\n\nOr fetch invocation directly:\n  aws ssm get-command-invocation --command-id {} --instance-id {}\n\nQuery step status in SSM:\n  aws ssm get-parameter --name {}/bootstrap/status/boot/<step-name>\n  aws ssm get-parameter --name {}/bootstrap/status/argocd/<step-name>\n\n─── stderr (full) ───\n{}', $.${safeId}FailureOutput.StatusDetails, $.${id}Result.CommandId, ${instanceIdPath}, $.${id}Result.CommandId, $.${id}Result.CommandId, ${instanceIdPath}, ${ssmPrefixPath}, ${ssmPrefixPath}, $.${safeId}FailureOutput.StandardErrorContent)`,
        },
        ResultPath: `$.${safeId}FailCause`,
      },
    });
    fetchFailureOutput.next(formatFailureCause);
    formatFailureCause.next(pollFailed);

    const startExec = new sfnTasks.CallAwsService(this, `${id}Start`, {
      service: "ssm",
      action: "sendCommand",
      parameters: {
        DocumentName: runnerDocName,
        InstanceIds: JsonPath.array(JsonPath.stringAt(instanceIdPath)),
        CloudWatchOutputConfig: {
          CloudWatchLogGroupName: logGroupName,
          CloudWatchOutputEnabled: true,
        },
        Parameters: {
          ScriptPath: JsonPath.array(step.scriptPath),
          SsmPrefix: JsonPath.array(JsonPath.stringAt(ssmPrefixPath)),
          S3Bucket: JsonPath.array(JsonPath.stringAt(s3BucketPath)),
          Region: JsonPath.array(JsonPath.stringAt(regionPath)),
        },
      },
      iamResources: ["*"],
      resultSelector: {
        "CommandId.$": "$.Command.CommandId",
      },
      resultPath: `$.${id}Result`,
      comment: step.description,
    });

    startExec.addRetry({
      errors: ["Ssm.InvalidInstanceIdException", "Ssm.SsmException"],
      interval: cdk.Duration.seconds(30),
      maxAttempts: 5,
      backoffRate: 1.5,
    });
    startExec.addCatch(sendFailed, { errors: ["States.ALL"] });

    const initCounter = new sfn.CustomState(this, `${id}InitCount`, {
      stateJson: {
        Type: "Pass",
        Result: { value: 0 },
        ResultPath: pollCountPath,
      },
    });

    const waitStep = new sfn.Wait(this, `${id}Wait`, {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const pollStatus = new sfnTasks.CallAwsService(this, `${id}Poll`, {
      service: "ssm",
      action: "getCommandInvocation",
      parameters: {
        CommandId: JsonPath.stringAt(`$.${id}Result.CommandId`),
        InstanceId: JsonPath.stringAt(instanceIdPath),
      },
      iamResources: ["*"],
      resultSelector: {
        "Status.$": "$.Status",
      },
      resultPath: `$.${id}Status`,
    });

    pollStatus.addCatch(pollApiFailed, { errors: ["States.ALL"] });

    const incrPollCount = new sfn.CustomState(this, `${id}IncrCount`, {
      stateJson: {
        Type: "Pass",
        Parameters: {
          "value.$": `States.MathAdd(${pollCountPath}.value, 1)`,
        },
        ResultPath: pollCountPath,
      },
    });

    const successState = new sfn.Pass(this, `${id}Done`);

    const checkTimeout = new sfn.Choice(this, `${id}CheckTimeout`)
      .when(
        sfn.Condition.numberGreaterThanEquals(
          `${pollCountPath}.value`,
          MAX_POLL_ITERATIONS,
        ),
        fetchFailureOutput,
      )
      .otherwise(waitStep);

    const checkStatus = new sfn.Choice(this, `${id}Check`)
      .when(
        sfn.Condition.stringEquals(`$.${id}Status.Status`, "Success"),
        successState,
      )
      .when(
        sfn.Condition.or(
          sfn.Condition.stringEquals(`$.${id}Status.Status`, "Pending"),
          sfn.Condition.stringEquals(`$.${id}Status.Status`, "InProgress"),
          sfn.Condition.stringEquals(`$.${id}Status.Status`, "Delayed"),
        ),
        incrPollCount,
      )
      .otherwise(fetchFailureOutput);

    startExec.next(initCounter);
    initCounter.next(waitStep);
    waitStep.next(pollStatus);
    pollStatus.next(checkStatus);
    incrPollCount.next(checkTimeout);

    return { start: startExec, end: successState };
  }

}
