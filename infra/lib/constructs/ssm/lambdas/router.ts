/**
 * @format
 * Bootstrap Router Lambda
 *
 * Two modes, dispatched by the `mode` field in the event:
 *
 * 1. **Route** (default — triggered by EventBridge on EC2 Instance Launch Successful):
 *    Reads ASG tags to resolve the bootstrap role, instance ID, SSM prefix, and
 *    S3 bucket for the launched instance. Returns these values to the Step Functions
 *    state machine so it can branch on role and run the correct bootstrap script.
 *
 * 2. **trigger_workers** (called from the CP SM-A path after CP bootstrap completes):
 *    Finds all InService worker instances (k8s:bootstrap-role != control-plane,
 *    same k8s:ssm-prefix) and starts a fresh SM-A execution for each. This ensures
 *    workers that were already running when the control plane was replaced will detect
 *    the new CP instance ID in SSM and re-join the cluster automatically.
 */

import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
} from "@aws-sdk/client-auto-scaling";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

// =============================================================================
// Clients — instantiated once per container, reused across warm invocations
// =============================================================================

const asgClient = new AutoScalingClient({});
const ssmClient = new SSMClient({});
const sfnClient = new SFNClient({});

// =============================================================================
// Types
// =============================================================================

interface RouteEvent {
  detail?: {
    EC2InstanceId?: string;
    AutoScalingGroupName?: string;
  };
}

interface TriggerWorkersEvent {
  mode: "trigger_workers";
  ssmPrefix: string;
}

interface LambdaContext {
  invokedFunctionArn: string;
}

interface RouteResult {
  role: string | null;
  instanceId: string;
  asgName: string;
  ssmPrefix: string;
  s3Bucket: string;
  region: string;
  reason: string;
}

interface TriggerResult {
  triggered: Array<{ instanceId: string; role: string }>;
  error?: string;
}

// =============================================================================
// Route mode
// =============================================================================

function skip(reason: string): RouteResult {
  console.log(`Skipping: ${reason}`);
  return {
    role: null,
    instanceId: "",
    asgName: "",
    ssmPrefix: "",
    s3Bucket: "",
    region: "",
    reason,
  };
}

async function route(
  event: RouteEvent,
  context: LambdaContext,
): Promise<RouteResult> {
  const detail = event.detail ?? {};
  const instanceId = detail.EC2InstanceId ?? "";
  const asgName = detail.AutoScalingGroupName ?? "";

  if (!instanceId || !asgName) return skip("Missing instance or ASG info");

  console.log(`Instance launched: ${instanceId} in ASG ${asgName}`);

  const resp = await asgClient.send(
    new DescribeAutoScalingGroupsCommand({ AutoScalingGroupNames: [asgName] }),
  );
  const group = resp.AutoScalingGroups?.[0];
  if (!group) return skip(`ASG ${asgName} not found`);

  const tags = Object.fromEntries(
    (group.Tags ?? []).map((t) => [t.Key ?? "", t.Value ?? ""]),
  );
  const role = tags["k8s:bootstrap-role"] ?? null;
  const ssmPrefix = tags["k8s:ssm-prefix"] ?? "";

  if (!role || !ssmPrefix) return skip(`No k8s tags on ASG ${asgName}`);

  const param = await ssmClient.send(
    new GetParameterCommand({ Name: `${ssmPrefix}/scripts-bucket` }),
  );
  const s3Bucket = param.Parameter?.Value ?? "";
  const region = context.invokedFunctionArn.split(":")[3];

  const result: RouteResult = {
    role,
    instanceId,
    asgName,
    ssmPrefix,
    s3Bucket,
    region,
    reason: "ok",
  };
  console.log("Router result:", JSON.stringify(result));
  return result;
}

// =============================================================================
// Trigger-workers mode
// =============================================================================

async function triggerWorkers(
  event: TriggerWorkersEvent,
): Promise<TriggerResult> {
  const { ssmPrefix } = event;

  let smArn: string;
  try {
    const param = await ssmClient.send(
      new GetParameterCommand({
        Name: `${ssmPrefix}/bootstrap/state-machine-arn`,
      }),
    );
    smArn = param.Parameter?.Value ?? "";
    if (!smArn) throw new Error("Empty SM ARN in SSM");
  } catch (e) {
    console.error("trigger_workers: could not resolve SM ARN from SSM:", e);
    return { triggered: [], error: String(e) };
  }

  const resp = await asgClient.send(
    new DescribeAutoScalingGroupsCommand({
      Filters: [{ Name: "tag:k8s:ssm-prefix", Values: [ssmPrefix] }],
    }),
  );

  const triggered: Array<{ instanceId: string; role: string }> = [];

  for (const group of resp.AutoScalingGroups ?? []) {
    const tags = Object.fromEntries(
      (group.Tags ?? []).map((t) => [t.Key ?? "", t.Value ?? ""]),
    );
    const role = tags["k8s:bootstrap-role"];
    if (!role || role === "control-plane") continue;

    for (const inst of group.Instances ?? []) {
      if (inst.LifecycleState !== "InService") continue;

      const instanceId = inst.InstanceId!;
      const asgName = group.AutoScalingGroupName!;
      // Timestamp in ms ensures unique execution names across concurrent CP replacements.
      const execName = `cp-rejoin-${role}-${Date.now()}`;
      const payload = JSON.stringify({
        detail: { EC2InstanceId: instanceId, AutoScalingGroupName: asgName },
      });

      try {
        await sfnClient.send(
          new StartExecutionCommand({
            stateMachineArn: smArn,
            name: execName,
            input: payload,
          }),
        );
        triggered.push({ instanceId, role });
        console.log(`Started worker rejoin: ${instanceId} (${role})`);
      } catch (e) {
        // Non-fatal — CP bootstrap already succeeded. Log and continue.
        console.error(
          `Failed to start rejoin execution for ${instanceId} (${role}):`,
          e,
        );
      }
    }
  }

  console.log("Worker rejoin dispatch complete:", JSON.stringify(triggered));
  return { triggered };
}

// =============================================================================
// Handler
// =============================================================================

export async function handler(
  event: RouteEvent | TriggerWorkersEvent,
  context: LambdaContext,
): Promise<RouteResult | TriggerResult> {
  if ("mode" in event && event.mode === "trigger_workers") {
    return triggerWorkers(event);
  }
  return route(event as RouteEvent, context);
}
