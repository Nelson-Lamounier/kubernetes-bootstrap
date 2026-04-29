/**
 * @format
 * Resource Cleanup Provider Construct
 *
 * Reusable CDK construct that pre-emptively deletes orphaned AWS resources
 * (log groups, SSM parameters, SNS topics) before CloudFormation attempts
 * to CREATE or UPDATE them.
 *
 * ## Why This Exists
 *
 * Resources with hardcoded physical names (e.g. a CloudWatch Log Group with
 * an explicit `logGroupName`) become orphans after CloudFormation
 * `UPDATE_ROLLBACK_COMPLETE`. CloudFormation removes the resource from its
 * state but often fails to delete the actual AWS resource. On the next
 * deployment, CloudFormation tries to CREATE a resource whose name already
 * exists — and fails with "already exists".
 *
 * ## How It Works
 *
 * 1. A single shared Lambda per stack handles all cleanup requests.
 * 2. Each resource to protect gets a `cdk.CustomResource` that runs
 *    **before** the real CDK resource (via `addDependency`).
 * 3. On CloudFormation `Create` or `Update`: the Lambda checks whether
 *    the resource is an orphan and deletes it if so.
 * 4. On `Delete`: no-op.
 * 5. A rotating `DeploymentId` property ensures CloudFormation always
 *    sends an `Update` event on redeployments.
 */

import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';

import { Construct } from 'constructs';

// =============================================================================
// TYPES
// =============================================================================

type CleanupResourceType = 'LOG_GROUP' | 'SSM_PARAMETER' | 'SNS_TOPIC';

// =============================================================================
// INLINE LAMBDA CODE
// =============================================================================

const CLEANUP_HANDLER_CODE = `
import logging
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

logs_client = boto3.client("logs")
ssm_client = boto3.client("ssm")
sns_client = boto3.client("sns")
cfn_client = boto3.client("cloudformation")


def handler(event, context):
    """Delete orphaned resource on Create/Update; no-op on Delete."""
    request_type = event.get("RequestType", "")
    props = event.get("ResourceProperties", {})
    resource_type = props.get("ResourceType", "")
    resource_name = props.get("ResourceName", "")
    stack_id = event.get("StackId", "")

    logger.info(
        "RequestType=%s ResourceType=%s ResourceName=%s StackId=%s",
        request_type, resource_type, resource_name, stack_id,
    )

    computed_id = f"cleanup-{resource_type}-{resource_name}"
    # Always preserve the PhysicalResourceId assigned at Create time.
    # CF rejects any change to PhysicalResourceId during Delete (rollback
    # sends the old ID; returning a different one causes ROLLBACK_FAILED).
    physical_id = event.get("PhysicalResourceId") or computed_id

    # Only run cleanup on Create — skip Update and Delete.
    # UPDATE is excluded because CloudFormation's ListStackResources
    # is not a consistent snapshot during in-flight updates: the old
    # resource may briefly disappear, causing _is_managed_by_stack()
    # to return False and the Lambda to delete a healthy resource.
    if request_type in ("Update", "Delete"):
        return {"PhysicalResourceId": physical_id}

    # ── Orphan detection ──────────────────────────────────────────
    # Check if the resource is currently managed by this CF stack.
    # If it is, skip deletion — the resource is healthy.
    if _is_managed_by_stack(stack_id, resource_type, resource_name):
        logger.info(
            "Resource is managed by stack — skipping cleanup: %s",
            resource_name,
        )
        return {"PhysicalResourceId": physical_id}

    # ── Orphan cleanup ────────────────────────────────────────────
    try:
        if resource_type == "LOG_GROUP":
            _delete_log_group(resource_name)
        elif resource_type == "SSM_PARAMETER":
            _delete_ssm_parameter(resource_name)
        elif resource_type == "SNS_TOPIC":
            _delete_sns_topic(resource_name)
        else:
            logger.warning("Unknown resource type: %s", resource_type)
    except Exception as e:
        # Log but do NOT fail — cleanup is best-effort.
        # If the resource doesn't exist, that's the happy path.
        logger.info("Cleanup result: %s", str(e))

    return {"PhysicalResourceId": physical_id}


# ── CloudFormation introspection ──────────────────────────────────

# Map our resource types to CloudFormation resource types
_CFN_TYPE_MAP = {
    "LOG_GROUP": "AWS::Logs::LogGroup",
    "SSM_PARAMETER": "AWS::SSM::Parameter",
    "SNS_TOPIC": "AWS::SNS::Topic",
}


def _is_managed_by_stack(stack_id, resource_type, resource_name):
    """Check if a resource with this physical name exists in the CF stack."""
    cfn_type = _CFN_TYPE_MAP.get(resource_type, "")
    if not stack_id or not cfn_type:
        return False

    try:
        paginator = cfn_client.get_paginator("list_stack_resources")
        for page in paginator.paginate(StackName=stack_id):
            for summary in page.get("StackResourceSummaries", []):
                if (
                    summary.get("ResourceType") == cfn_type
                    and summary.get("PhysicalResourceId") == resource_name
                ):
                    return True
    except Exception as e:
        logger.warning("Could not introspect stack resources: %s", str(e))
        # If we can't check, err on the safe side — don't delete.
        return True

    return False


# ── Resource deletion helpers ─────────────────────────────────────

def _delete_log_group(name):
    try:
        logs_client.delete_log_group(logGroupName=name)
        logger.info("Deleted orphaned log group: %s", name)
    except logs_client.exceptions.ResourceNotFoundException:
        logger.info("Log group does not exist (clean state): %s", name)


def _delete_ssm_parameter(name):
    try:
        ssm_client.delete_parameter(Name=name)
        logger.info("Deleted orphaned SSM parameter: %s", name)
    except ssm_client.exceptions.ParameterNotFound:
        logger.info("SSM parameter does not exist (clean state): %s", name)


def _delete_sns_topic(name):
    """Delete SNS topic by name. Resolves to ARN via region/account."""
    try:
        sts = boto3.client("sts")
        identity = sts.get_caller_identity()
        account_id = identity["Account"]
        region = boto3.session.Session().region_name
        arn = f"arn:aws:sns:{region}:{account_id}:{name}"
        sns_client.delete_topic(TopicArn=arn)
        logger.info("Deleted orphaned SNS topic: %s", arn)
    except Exception as e:
        if "NotFound" in str(e):
            logger.info("SNS topic does not exist (clean state): %s", name)
        else:
            raise
`;

// =============================================================================
// CONSTRUCT
// =============================================================================

export class ResourceCleanupProvider extends Construct {
    private readonly provider: cr.Provider;
    private readonly cleanupFunction: lambda.Function;
    private readonly addedPermissions = new Set<CleanupResourceType>();

    constructor(scope: Construct, id: string) {
        super(scope, id);

        this.cleanupFunction = new lambda.Function(this, 'CleanupFn', {
            runtime: lambda.Runtime.PYTHON_3_13,
            handler: 'index.handler',
            code: lambda.Code.fromInline(CLEANUP_HANDLER_CODE),
            timeout: cdk.Duration.seconds(60),
            memorySize: 128,
            description: 'Pre-emptive cleanup of orphaned AWS resources before CloudFormation CREATE',
        });

        // The Lambda needs to introspect the calling stack to determine
        // whether a resource is managed (healthy) or orphaned (leftover).
        this.cleanupFunction.addToRolePolicy(new iam.PolicyStatement({
            sid: 'IntrospectStack',
            effect: iam.Effect.ALLOW,
            actions: ['cloudformation:ListStackResources'],
            resources: [
                `arn:aws:cloudformation:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:stack/*`,
            ],
        }));

        const providerLogGroup = new logs.LogGroup(this, 'ProviderLogs', {
            retention: logs.RetentionDays.THREE_DAYS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        this.provider = new cr.Provider(this, 'Provider', {
            onEventHandler: this.cleanupFunction,
            logGroup: providerLogGroup,
        });
    }

    public addLogGroup(logGroupName: string, realResource: Construct): void {
        this.ensurePermissions('LOG_GROUP');

        const cleanupId = this.toCleanupId(logGroupName);
        const cleanup = new cdk.CustomResource(this, `Cleanup-${cleanupId}`, {
            serviceToken: this.provider.serviceToken,
            properties: {
                ResourceType: 'LOG_GROUP',
                ResourceName: logGroupName,
                DeploymentId: Date.now().toString(),
            },
        });

        realResource.node.addDependency(cleanup);
    }

    public addSsmParameter(parameterName: string, realResource: Construct): void {
        this.ensurePermissions('SSM_PARAMETER');

        const cleanupId = this.toCleanupId(parameterName);
        const cleanup = new cdk.CustomResource(this, `Cleanup-${cleanupId}`, {
            serviceToken: this.provider.serviceToken,
            properties: {
                ResourceType: 'SSM_PARAMETER',
                ResourceName: parameterName,
                DeploymentId: Date.now().toString(),
            },
        });

        realResource.node.addDependency(cleanup);
    }

    public addSnsTopic(topicName: string, realResource: Construct): void {
        this.ensurePermissions('SNS_TOPIC');

        const cleanupId = this.toCleanupId(topicName);
        const cleanup = new cdk.CustomResource(this, `Cleanup-${cleanupId}`, {
            serviceToken: this.provider.serviceToken,
            properties: {
                ResourceType: 'SNS_TOPIC',
                ResourceName: topicName,
                DeploymentId: Date.now().toString(),
            },
        });

        realResource.node.addDependency(cleanup);
    }

    private ensurePermissions(type: CleanupResourceType): void {
        if (this.addedPermissions.has(type)) return;
        this.addedPermissions.add(type);

        const stack = cdk.Stack.of(this);

        switch (type) {
            case 'LOG_GROUP':
                this.cleanupFunction.addToRolePolicy(new iam.PolicyStatement({
                    sid: 'CleanupLogGroups',
                    effect: iam.Effect.ALLOW,
                    actions: ['logs:DeleteLogGroup'],
                    resources: [
                        `arn:aws:logs:${stack.region}:${stack.account}:log-group:*`,
                    ],
                }));
                break;

            case 'SSM_PARAMETER':
                this.cleanupFunction.addToRolePolicy(new iam.PolicyStatement({
                    sid: 'CleanupSsmParameters',
                    effect: iam.Effect.ALLOW,
                    actions: ['ssm:DeleteParameter'],
                    resources: [
                        `arn:aws:ssm:${stack.region}:${stack.account}:parameter/*`,
                    ],
                }));
                break;

            case 'SNS_TOPIC':
                this.cleanupFunction.addToRolePolicy(new iam.PolicyStatement({
                    sid: 'CleanupSnsTopics',
                    effect: iam.Effect.ALLOW,
                    actions: ['sns:DeleteTopic'],
                    resources: [
                        `arn:aws:sns:${stack.region}:${stack.account}:*`,
                    ],
                }));
                break;
        }
    }

    private toCleanupId(resourceName: string): string {
        return resourceName
            .replace(/^\/+/, '')
            .split(/[/\-:]+/)
            .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
            .join('');
    }
}
