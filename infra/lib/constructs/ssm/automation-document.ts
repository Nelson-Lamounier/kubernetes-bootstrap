/**
 * @format
 * SSM Automation Document Construct
 *
 * Reusable construct for creating SSM **Automation** documents (schema 0.3).
 * Supports two categories:
 *   - `bootstrap`: K8s node bootstrap (scripts read from /opt/k8s-bootstrap/ — baked into AMI)
 *   - `deploy`:    App secret deployment (S3 sync from app-deploy/<app>/)
 *
 * Distinct from `SsmRunCommandDocument` which creates **Command** documents
 * (schema 2.2) for ad-hoc execution via `aws ssm send-command`.
 *
 * @example
 * ```typescript
 * const cpDoc = new SsmAutomationDocument(this, 'ControlPlane', {
 *     documentName: 'k8s-bootstrap-control-plane',
 *     description: 'Orchestrates Kubernetes control plane bootstrap',
 *     documentCategory: 'bootstrap',
 *     steps: [{ name: 'bootstrapControlPlane', scriptPath: 'sm-a/boot/steps/control_plane.py', timeoutSeconds: 1800, description: '...' }],
 *     ssmPrefix: '/k8s/development',
 *     s3Bucket: 'my-scripts-bucket',
 *     automationRoleArn: role.roleArn,
 * });
 * ```
 */

import * as ssm from "aws-cdk-lib/aws-ssm";
import * as cdk from "aws-cdk-lib/core";

import { Construct } from "constructs";

// =============================================================================
// TYPES & INTERFACES
// =============================================================================

/**
 * A single step in an SSM Automation document.
 * Each step maps to an `aws:runCommand` action targeting the instance.
 */
export interface AutomationStep {
  /** Step name (unique, alphanumeric + camelCase) */
  readonly name: string;

  /** Relative path to the TypeScript script inside S3 / the AMI */
  readonly scriptPath: string;

  /** Maximum execution time in seconds */
  readonly timeoutSeconds: number;

  /** Human-readable description of what this step does */
  readonly description: string;
}

/**
 * Document category determines S3 sync paths and CW log groups:
 * - `bootstrap`: syncs from `k8s-bootstrap/sm-a/boot/steps/`, logs to `/ssm<prefix>/bootstrap`
 * - `deploy`:    syncs from the script's parent directory, logs to `/ssm<prefix>/deploy`
 */
export type AutomationDocumentCategory = "bootstrap" | "deploy";

/**
 * Props for SsmAutomationDocument construct.
 */
export interface SsmAutomationDocumentProps {
  /** Document name — must be unique within account/region */
  readonly documentName: string;

  /** Human-readable description */
  readonly description: string;

  /** Determines S3 sync strategy and CW log group path */
  readonly documentCategory: AutomationDocumentCategory;

  /** Ordered list of automation steps */
  readonly steps: AutomationStep[];

  /** SSM parameter prefix (e.g. `/k8s/development`) */
  readonly ssmPrefix: string;

  /** S3 bucket containing scripts */
  readonly s3Bucket: string;

  /** IAM role ARN assumed by the Automation execution */
  readonly automationRoleArn: string;
}

// =============================================================================
// CONSTRUCT
// =============================================================================

export class SsmAutomationDocument extends Construct {
  /** The underlying SSM CfnDocument resource */
  public readonly document: ssm.CfnDocument;

  /** The document name (used with `ssm:StartAutomationExecution`) */
  public readonly documentName: string;

  constructor(scope: Construct, id: string, props: SsmAutomationDocumentProps) {
    super(scope, id);

    this.documentName = props.documentName;

    const content =
      props.documentCategory === "bootstrap"
        ? this.buildBootstrapContent(props)
        : this.buildDeployContent(props);

    this.document = new ssm.CfnDocument(this, "Document", {
      documentType: "Automation",
      name: props.documentName,
      content,
      documentFormat: "JSON",
      updateMethod: "NewVersion",
    });
  }

  // =========================================================================
  // Bootstrap Document Content (k8s-bootstrap/sm-a/boot/steps/)
  // =========================================================================

  private buildBootstrapContent(
    opts: SsmAutomationDocumentProps,
  ): Record<string, unknown> {
    const stack = cdk.Stack.of(this);
    return {
      schemaVersion: "0.3",
      description: opts.description,
      assumeRole: opts.automationRoleArn,
      parameters: this.buildParameters(opts, stack),
      mainSteps: opts.steps.map((step) => ({
        name: step.name,
        action: "aws:runCommand",
        timeoutSeconds: step.timeoutSeconds,
        onFailure: "Abort",
        inputs: {
          DocumentName: "AWS-RunShellScript",
          InstanceIds: ["{{ InstanceId }}"],
          CloudWatchOutputConfig: {
            CloudWatchOutputEnabled: true,
            CloudWatchLogGroupName: `/ssm${opts.ssmPrefix}/bootstrap`,
          },
          Parameters: {
            commands: [
              `# Step: ${step.name} — ${step.description}`,
              ``,
              `# Ensure PATH includes all standard binary locations`,
              `export PATH="/opt/k8s-venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"`,
              `set -euo pipefail`,
              ``,
              `# Scripts are baked into the AMI at /opt/k8s-bootstrap/ by BakeBootstrapScripts.`,
              `STEPS_DIR="/opt/k8s-bootstrap/${step.scriptPath.replace(/\/[^/]+$/, "")}"`,
              `SCRIPT="/opt/k8s-bootstrap/${step.scriptPath}"`,
              ``,
              `# Clear retryable step markers so failed/incomplete steps are`,
              `# always re-attempted on re-execution.`,
              `#`,
              `# Preserved (destructive one-time operations):`,
              `#   .dr-restored  — restoring etcd twice corrupts the cluster`,
              `#   admin.conf    — kubeadm init guard (second-run path handles re-runs safely)`,
              `#`,
              `# Cleared (safe to re-run, idempotent operations):`,
              `#   .calico-installed — re-runs to create kubernetes-services-endpoint ConfigMap`,
              `#   .ccm-installed    — re-runs to remove uninitialized taint`,
              `echo "Clearing retryable step markers..."`,
              `rm -f /etc/kubernetes/.calico-installed`,
              `rm -f /etc/kubernetes/.ccm-installed`,
              `echo "Retryable markers cleared"`,
              ``,
              `echo "=== Executing: ${step.name} ==="`,
              ``,
              `# Source CDK-configured env vars (HOSTED_ZONE_ID, API_DNS_NAME,`,
              `# K8S_VERSION, NODE_LABEL, etc.) set by EC2 user-data at boot.`,
              `if [ -f /etc/profile.d/k8s-env.sh ]; then`,
              `  source /etc/profile.d/k8s-env.sh`,
              `fi`,
              ``,
              `# Override with SSM Automation parameters (takes precedence)`,
              `export SSM_PREFIX="{{ SsmPrefix }}"`,
              `export AWS_REGION="{{ Region }}"`,
              `export S3_BUCKET="{{ S3Bucket }}"`,
              `export MOUNT_POINT="/data"`,
              `export KUBECONFIG="/etc/kubernetes/admin.conf"`,
              ``,
              `cd "$STEPS_DIR"`,
              `npx --prefix /opt/k8s-bootstrap tsx "$SCRIPT" 2>&1`,
              `echo "=== Completed: ${step.name} ==="`,
            ],
            workingDirectory: ["/tmp"],
            executionTimeout: [String(step.timeoutSeconds)],
          },
        },
      })),
      outputs: opts.steps.map((step) => `${step.name}.CommandId`),
    };
  }

  // =========================================================================
  // Deploy Document Content (app-deploy/<app>/)
  // =========================================================================

  private buildDeployContent(
    opts: SsmAutomationDocumentProps,
  ): Record<string, unknown> {
    const stack = cdk.Stack.of(this);
    return {
      schemaVersion: "0.3",
      description: opts.description,
      assumeRole: opts.automationRoleArn,
      parameters: this.buildParameters(opts, stack),
      mainSteps: opts.steps.map((step) => ({
        name: step.name,
        action: "aws:runCommand",
        timeoutSeconds: step.timeoutSeconds,
        onFailure: "Abort",
        inputs: {
          DocumentName: "AWS-RunShellScript",
          InstanceIds: ["{{ InstanceId }}"],
          CloudWatchOutputConfig: {
            CloudWatchOutputEnabled: true,
            CloudWatchLogGroupName: `/ssm${opts.ssmPrefix}/deploy`,
          },
          Parameters: {
            commands: [
              `# Step: ${step.name} — ${step.description}`,
              ``,
              `# Ensure PATH includes all standard binary locations`,
              `export PATH="/opt/k8s-venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"`,
              `set -euo pipefail`,
              ``,
              `# Step 1: Sync shared k8s-bootstrap libraries (deploy_helpers, system)`,
              `mkdir -p "/data/k8s-bootstrap"`,
              `aws s3 sync "s3://{{ S3Bucket }}/k8s-bootstrap/" "/data/k8s-bootstrap/" --region {{ Region }} --quiet`,
              ``,
              `# Step 2: Sync app-specific deploy scripts`,
              `DEPLOY_DIR="/data/${step.scriptPath.replace(/\/[^/]+$/, "")}"`,
              `SCRIPT="/data/${step.scriptPath}"`,
              ``,
              `mkdir -p "$DEPLOY_DIR"`,
              `aws s3 sync "s3://{{ S3Bucket }}/${step.scriptPath.replace(/\/[^/]+$/, "")}/" "$DEPLOY_DIR/" --region {{ Region }} --quiet`,
              ``,
              `# Install Python dependencies if requirements.txt exists`,
              `if [ -f "$DEPLOY_DIR/requirements.txt" ]; then`,
              `  /opt/k8s-venv/bin/pip install -q -r "$DEPLOY_DIR/requirements.txt" 2>/dev/null`,
              `fi`,
              ``,
              `echo "=== Executing: ${step.name} ==="`,
              `export KUBECONFIG="/etc/kubernetes/admin.conf"`,
              `export SSM_PREFIX="{{ SsmPrefix }}"`,
              `export AWS_REGION="{{ Region }}"`,
              `export S3_BUCKET="{{ S3Bucket }}"`,
              ``,
              `cd "$DEPLOY_DIR"`,
              `python3 "$SCRIPT" 2>&1`,
              `echo "=== Completed: ${step.name} ==="`,
            ],
            workingDirectory: ["/tmp"],
            executionTimeout: [String(step.timeoutSeconds)],
          },
        },
      })),
      outputs: opts.steps.map((step) => `${step.name}.CommandId`),
    };
  }

  // =========================================================================
  // Shared Helpers
  // =========================================================================

  private buildParameters(
    opts: SsmAutomationDocumentProps,
    stack: cdk.Stack,
  ): Record<string, unknown> {
    return {
      InstanceId: {
        type: "String",
        description: "Target EC2 instance ID",
      },
      SsmPrefix: {
        type: "String",
        description: "SSM parameter prefix for cluster info",
        default: opts.ssmPrefix,
      },
      S3Bucket: {
        type: "String",
        description: `S3 bucket containing ${opts.documentCategory} scripts`,
        default: opts.s3Bucket,
      },
      Region: {
        type: "String",
        description: "AWS region",
        default: stack.region,
      },
    };
  }
}
