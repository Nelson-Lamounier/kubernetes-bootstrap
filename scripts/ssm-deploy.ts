#!/usr/bin/env npx tsx
/**
 * @format
 * SSM Deploy — Run app deploy.py on the K8s control-plane via SSM
 *
 * Replaces the inline bash "Run <app> deploy.py via SSM" steps in
 * deploy-api.yml with a typed, reusable TypeScript script.
 *
 * What it does on the control-plane instance:
 *   1. Resolves the scripts S3 bucket from SSM
 *   2. Syncs k8s-bootstrap helpers and app deploy scripts from S3
 *   3. Installs Python deps (boto3, kubernetes) via pip3
 *   4. Runs deploy.py with KUBECONFIG=/etc/kubernetes/admin.conf
 *
 * Usage (local / CI):
 *   npx tsx kubernetes-app/k8s-bootstrap/scripts/ssm-deploy.ts --app admin-api
 *   npx tsx kubernetes-app/k8s-bootstrap/scripts/ssm-deploy.ts --app public-api
 *   npx tsx ...ssm-deploy.ts --app admin-api --environment development --region eu-west-1
 *   npx tsx ...ssm-deploy.ts --app admin-api --dry-run   # print command, exit 0
 *
 * Exit codes:
 *   0 = deploy.py completed successfully on the instance
 *   1 = failure (instance not found, SSM command failed, or timed out)
 *
 * Environment variables (all optional — override defaults):
 *   ENVIRONMENT   target environment  (default: development)
 *   AWS_REGION    AWS region          (default: eu-west-1)
 */

import {
  EC2Client,
  DescribeInstancesCommand,
  type Filter,
} from '@aws-sdk/client-ec2';
import {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand,
} from '@aws-sdk/client-ssm';

import log from '@repo/script-utils/logger.js';
import { buildAwsConfig, parseArgs, resolveAuth } from '@repo/script-utils/aws.js';

// =============================================================================
// Constants
// =============================================================================

/** How many poll iterations before giving up (18 × 10 s = 3 min). */
const MAX_POLLS = 18;
const POLL_INTERVAL_MS = 10_000;

/** Terminal SSM command statuses. */
const TERMINAL_STATUSES = new Set(['Success', 'Failed', 'TimedOut', 'Cancelled', 'Undeliverable']);

/** Valid app names accepted by this script. */
const VALID_APPS = ['admin-api', 'public-api', 'wiki-mcp'] as const;
type AppName = (typeof VALID_APPS)[number];

// =============================================================================
// CLI
// =============================================================================

const args = parseArgs(
  [
    { name: 'app', description: 'BFF service to deploy (admin-api | public-api)', hasValue: true },
    { name: 'environment', description: 'Target environment', hasValue: true, default: 'development' },
    { name: 'region', description: 'AWS region', hasValue: true, default: 'eu-west-1' },
    { name: 'dry-run', description: 'Print the SSM command and exit without running it', hasValue: false, default: false },
  ],
  'Run the Kubernetes BFF app deploy.py via SSM on the control-plane instance.',
);

const app = args.app as AppName | undefined;
const environment = (args.environment as string) || process.env.ENVIRONMENT || 'development';
const dryRun = Boolean(args['dry-run']);

if (!app || !VALID_APPS.includes(app)) {
  log.fatal(`--app is required and must be one of: ${VALID_APPS.join(', ')}`);
}

// =============================================================================
// AWS clients
// =============================================================================

const awsCfg = buildAwsConfig(args);

const ec2 = new EC2Client({ region: awsCfg.region, credentials: awsCfg.credentials });
const ssm = new SSMClient({ region: awsCfg.region, credentials: awsCfg.credentials });

// =============================================================================
// GitHub Actions helpers
// =============================================================================

const isCI = process.env.GITHUB_ACTIONS === 'true';

/** Mask a value in GitHub Actions log output. No-op outside CI. */
function mask(value: string): void {
  if (isCI) process.stdout.write(`::add-mask::${value}\n`);
}

/** Emit a GitHub Actions error annotation. */
function ghError(message: string): void {
  if (isCI) {
    process.stdout.write(`::error::${message}\n`);
  } else {
    log.error(message);
  }
}

// =============================================================================
// Instance discovery
// =============================================================================

async function findControlPlaneInstanceId(): Promise<string> {
  const filters: Filter[] = [
    { Name: 'tag:k8s:bootstrap-role', Values: ['control-plane'] },
    { Name: 'instance-state-name', Values: ['running'] },
  ];

  const resp = await ec2.send(new DescribeInstancesCommand({ Filters: filters }));
  const instanceId = resp.Reservations?.[0]?.Instances?.[0]?.InstanceId;

  if (!instanceId || instanceId === 'None') {
    throw new Error('Control-plane instance not found (tag k8s:bootstrap-role=control-plane, state=running)');
  }

  return instanceId;
}

// =============================================================================
// SSM command
// =============================================================================

/**
 * Build the shell commands array sent to AWS-RunShellScript.
 *
 * All four steps run in the SAME shell context on the control-plane node —
 * the BUCKET variable set in step 1 is visible in step 2.
 */
function buildCommands(env: string, region: string, targetApp: AppName): string[] {
  return [
    // 1. Resolve the scripts S3 bucket
    `BUCKET=$(aws ssm get-parameter --name /k8s/${env}/scripts-bucket --query Parameter.Value --output text --region ${region} 2>/dev/null || echo "")`,

    // 2. Sync k8s-bootstrap helpers and app-specific deploy scripts from S3
    [
      `[ -n "$BUCKET" ]`,
      `&& aws s3 sync s3://$BUCKET/k8s-bootstrap/ /data/k8s-bootstrap/ --exclude ".venv/*" --region ${region} 2>&1`,
      `&& aws s3 sync s3://$BUCKET/app-deploy/${targetApp}/ /data/app-deploy/${targetApp}/ --region ${region} 2>&1`,
      `&& echo "[S3] scripts refreshed"`,
      `|| echo "[WARN] S3 sync skipped"`,
    ].join(' '),

    // 3. Install Python runtime deps (boto3, kubernetes) — fast no-op if already installed
    `python3 -m pip install -q -r /data/k8s-bootstrap/deploy_helpers/requirements.txt 2>&1 && echo "[pip] deps ready" || echo "[WARN] pip install failed"`,

    // 4. Run the app-specific deploy.py
    `KUBECONFIG=/etc/kubernetes/admin.conf python3 /data/app-deploy/${targetApp}/deploy.py 2>&1`,
  ];
}

// =============================================================================
// Polling
// =============================================================================

async function pollUntilDone(
  commandId: string,
  instanceId: string,
): Promise<{ status: string; output: string; errorOutput: string }> {
  let status = 'Pending';

  for (let i = 1; i <= MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);

    try {
      const inv = await ssm.send(
        new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }),
      );
      status = inv.Status ?? 'Pending';
      log.keyValue(`  [${i}/${MAX_POLLS}] status`, status);

      if (TERMINAL_STATUSES.has(status)) {
        const output = inv.StandardOutputContent ?? '(no output)';
        const errorOutput = inv.StandardErrorContent ?? '';
        return { status, output, errorOutput };
      }
    } catch {
      log.keyValue(`  [${i}/${MAX_POLLS}] status`, 'Pending (invocation not ready yet)');
    }
  }

  return { status, output: '(timed out waiting for command)', errorOutput: '' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  log.header(`SSM Deploy — ${app} (${environment})`);
  log.keyValue('App', app!);
  log.keyValue('Environment', environment);
  log.keyValue('Region', awsCfg.region);
  log.keyValue('Auth', resolveAuth(args.profile as string | undefined).mode);
  if (dryRun) log.warn('DRY RUN — will print command and exit');
  log.blank();

  // ── 1. Resolve control-plane instance ──────────────────────────────────────
  log.task('Locating control-plane instance...');
  let instanceId: string;

  try {
    instanceId = await findControlPlaneInstanceId();
  } catch (err) {
    const msg = `Control-plane instance not found — cannot run ${app} deploy.py`;
    ghError(msg);
    process.exit(1);
  }

  mask(instanceId!);
  log.success(`Found instance (masked)`);

  // ── 2. Build & optionally dry-run the SSM command ──────────────────────────
  const commands = buildCommands(environment, awsCfg.region, app!);

  if (dryRun) {
    log.header('SSM Commands (dry-run)');
    commands.forEach((cmd, i) => log.keyValue(`  [${i + 1}]`, cmd));
    log.blank();
    process.exit(0);
  }

  // ── 3. Send SSM command ────────────────────────────────────────────────────
  log.task(`Sending SSM command to control-plane...`);

  let commandId: string;
  try {
    const resp = await ssm.send(
      new SendCommandCommand({
        InstanceIds: [instanceId!],
        DocumentName: 'AWS-RunShellScript',
        Parameters: { commands },
      }),
    );

    const cmdId = resp.Command?.CommandId;
    if (!cmdId) throw new Error('SSM did not return a CommandId');
    commandId = cmdId;
  } catch (err) {
    ghError(`Failed to send SSM command: ${(err as Error).message}`);
    process.exit(1);
  }

  mask(commandId!);
  log.success(`Command sent (masked)`);
  log.blank();

  // ── 4. Poll ────────────────────────────────────────────────────────────────
  log.task('Polling for completion...');
  const { status, output, errorOutput } = await pollUntilDone(commandId!, instanceId!);

  // ── 5. Print output ────────────────────────────────────────────────────────
  log.blank();
  log.header('deploy.py output');
  console.log(output);

  if (errorOutput.trim()) {
    log.header('stderr');
    console.log(errorOutput);
  }

  // ── 6. Exit ────────────────────────────────────────────────────────────────
  if (status !== 'Success') {
    ghError(`${app} deploy.py failed with status: ${status}`);
    process.exit(1);
  }

  log.summary(`${app} deployed successfully`, {
    Status: status,
    Environment: environment,
    Region: awsCfg.region,
  });
}

main().catch((err) => {
  log.error(`Unexpected error: ${(err as Error).message}`);
  process.exit(1);
});
