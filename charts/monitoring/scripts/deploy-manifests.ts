#!/usr/bin/env npx tsx
/**
 * Deploy K8s Manifests via SSM
 *
 * Shared script for deploying Kubernetes manifests to the kubeadm cluster
 * via SSM Run Command. Used by the K8s pipeline.
 *
 * Steps:
 *   1. Find the Kubernetes control plane instance (ASG query → SSM fallback)
 *   2. Wait for SSM Agent to be online
 *   3. Show boot diagnostics (user-data.log tail)
 *   4. Send the project-specific SSM deploy-manifests document
 *   5. Poll for completion with progress indicators
 *   6. Trigger ArgoCD sync (best-effort)
 *   7. Collect deployment logs and write to GITHUB_STEP_SUMMARY
 *
 * Usage:
 *   npx tsx kubernetes-app/platform/charts/monitoring/scripts/deploy-manifests.ts kubernetes development
 *   npx tsx kubernetes-app/platform/charts/monitoring/scripts/deploy-manifests.ts kubernetes production --region eu-west-1
 *
 * Environment:
 *   AWS_REGION            Override region (default: eu-west-1)
 *   GITHUB_STEP_SUMMARY   Path to GitHub Actions step summary file
 *   GITHUB_OUTPUT          Path to GitHub Actions output file
 *
 * Exit codes:
 *   0 = manifests deployed successfully (or skipped — no instance found)
 *   1 = deployment failed
 */

import { appendFileSync, existsSync } from 'fs';

import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
} from '@aws-sdk/client-auto-scaling';
import {
  SSMClient,
  DescribeInstanceInformationCommand,
  GetCommandInvocationCommand,
  GetParameterCommand,
  SendCommandCommand,
} from '@aws-sdk/client-ssm';

import log from '@repo/script-utils/logger.js';

// =============================================================================
// Types
// =============================================================================

type Project = 'kubernetes';
type Environment = 'development' | 'production';

interface ProjectConfig {
  /** ASG name pattern: k8s-{env}-asg */
  asgName: string;
  /** SSM parameter for instance-id fallback */
  ssmInstancePath: string;
  /** SSM document name for deploy-manifests */
  ssmDocumentName: string;
  /** ArgoCD app name for sync trigger */
  argoAppName: string;
}

// =============================================================================
// CLI
// =============================================================================

const args = process.argv.slice(2);
const project = args[0] as Project;
const environment = args[1] as Environment;
const regionFlag = args.indexOf('--region');
const region = regionFlag !== -1 ? args[regionFlag + 1] : (process.env.AWS_REGION ?? 'eu-west-1');

if (!project || !environment) {
  console.error('Usage: deploy-manifests.ts <project> <environment> [--region <region>]');
  console.error('  project:     kubernetes');
  console.error('  environment: development | production');
  process.exit(1);
}

if (!['kubernetes'].includes(project)) {
  console.error(`Unknown project: ${project}. Must be "kubernetes".`);
  process.exit(1);
}

if (!['development', 'production'].includes(environment)) {
  console.error(`Unknown environment: ${environment}. Must be "development" or "production".`);
  process.exit(1);
}

// =============================================================================
// Project Config
// =============================================================================

function getProjectConfig(project: Project, env: Environment): ProjectConfig {
  const asgName = `k8s-${env}-asg`;
  const ssmInstancePath = `/k8s/${env}/instance-id`;

  return {
    asgName,
    ssmInstancePath,
    ssmDocumentName: `k8s-${env}-deploy-app-manifests`,
    argoAppName: 'kubernetes',
  };
}

// =============================================================================
// AWS Clients
// =============================================================================

const ssmClient = new SSMClient({ region });
const asgClient = new AutoScalingClient({ region });

// =============================================================================
// Constants
// =============================================================================

const SSM_AGENT_TIMEOUT = 300;
const SSM_AGENT_POLL = 5;
const DEPLOY_TIMEOUT = 600;
const DEPLOY_POLL = 10;
const BOOT_LOG_TIMEOUT = 30;

// =============================================================================
// Step 1: Find Instance
// =============================================================================

async function findInstance(config: ProjectConfig): Promise<string | null> {
  log.task('Finding Kubernetes control plane instance...');
  log.keyValue('ASG', config.asgName);

  try {
    const response = await asgClient.send(
      new DescribeAutoScalingGroupsCommand({
        AutoScalingGroupNames: [config.asgName],
      }),
    );

    const instances = response.AutoScalingGroups?.[0]?.Instances ?? [];
    const inService = instances.find((i) => i.LifecycleState === 'InService');

    if (inService?.InstanceId) {
      log.success(`Instance found via ASG: ${inService.InstanceId}`);
      return inService.InstanceId;
    }

    log.warn('No InService instance in ASG — trying SSM fallback');
  } catch (err) {
    log.warn(`ASG query failed: ${(err as Error).message}`);
  }

  log.keyValue('SSM path', config.ssmInstancePath);
  try {
    const response = await ssmClient.send(
      new GetParameterCommand({ Name: config.ssmInstancePath }),
    );

    const instanceId = response.Parameter?.Value;
    if (instanceId) {
      log.success(`Instance found via SSM: ${instanceId}`);
      return instanceId;
    }
  } catch {
    // Parameter not found
  }

  return null;
}

// =============================================================================
// Step 2: Wait for SSM Agent
// =============================================================================

async function waitForSsmAgent(instanceId: string): Promise<void> {
  log.task(`Waiting for SSM Agent on ${instanceId}...`);

  let waited = 0;

  while (true) {
    try {
      const response = await ssmClient.send(
        new DescribeInstanceInformationCommand({
          Filters: [{ Key: 'InstanceIds', Values: [instanceId] }],
        }),
      );

      const status = response.InstanceInformationList?.[0]?.PingStatus;
      if (status === 'Online') {
        log.success(`SSM Agent online (waited ${waited}s)`);
        return;
      }
    } catch {
      // Ignore — agent not registered yet
    }

    if (waited >= SSM_AGENT_TIMEOUT) {
      throw new Error(`SSM Agent not online after ${SSM_AGENT_TIMEOUT}s`);
    }

    await sleep(SSM_AGENT_POLL * 1000);
    waited += SSM_AGENT_POLL;
  }
}

// =============================================================================
// Step 3: Show Boot Diagnostics
// =============================================================================

async function showBootDiagnostics(instanceId: string): Promise<void> {
  log.task('Fetching boot diagnostics (user-data.log)...');

  try {
    const sendResponse = await ssmClient.send(
      new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: 'AWS-RunShellScript',
        Parameters: { commands: ['cat /var/log/user-data.log | tail -80'] },
      }),
    );

    const commandId = sendResponse.Command?.CommandId;
    if (!commandId) {
      log.warn('Failed to send boot diagnostics command');
      return;
    }

    let waited = 0;
    while (waited < BOOT_LOG_TIMEOUT) {
      await sleep(2000);
      waited += 2;

      try {
        const result = await ssmClient.send(
          new GetCommandInvocationCommand({
            CommandId: commandId,
            InstanceId: instanceId,
          }),
        );

        if (result.Status === 'Success' || result.Status === 'Failed') {
          if (result.StandardOutputContent) {
            log.verbose('=== User-Data Log (last 80 lines) ===');
            for (const line of result.StandardOutputContent.split('\n').slice(-30)) {
              log.debug(line);
            }
            log.verbose('=== End User-Data Log ===');
          }
          return;
        }
      } catch {
        // Not ready yet
      }
    }

    log.warn('Boot diagnostics timed out — continuing');
  } catch (err) {
    log.warn(`Could not retrieve boot logs: ${(err as Error).message}`);
  }
}

// =============================================================================
// Step 4: Deploy Manifests via SSM
// =============================================================================

async function deployManifests(
  instanceId: string,
  config: ProjectConfig,
): Promise<string> {
  log.task(`Deploying manifests via SSM: ${config.ssmDocumentName}`);
  log.keyValue('Instance', instanceId);
  log.keyValue('Document', config.ssmDocumentName);

  const sendResponse = await ssmClient.send(
    new SendCommandCommand({
      DocumentName: config.ssmDocumentName,
      Targets: [{ Key: 'instanceids', Values: [instanceId] }],
      TimeoutSeconds: DEPLOY_TIMEOUT,
    }),
  );

  const commandId = sendResponse.Command?.CommandId;
  if (!commandId) {
    throw new Error('Failed to send SSM command — no CommandId returned');
  }

  log.keyValue('Command ID', commandId);
  setOutput('command_id', commandId);

  let waited = 0;

  while (true) {
    await sleep(DEPLOY_POLL * 1000);
    waited += DEPLOY_POLL;

    let status = 'InProgress';

    try {
      const result = await ssmClient.send(
        new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: instanceId,
        }),
      );
      status = result.Status ?? 'InProgress';

      if (status === 'Success') {
        log.success('Manifest deployment completed successfully');
        return commandId;
      }

      if (['Failed', 'Cancelled', 'TimedOut'].includes(status)) {
        log.error(`SSM command ${status}`);

        if (result.StandardOutputContent) {
          log.info('--- SSM stdout ---');
          console.log(result.StandardOutputContent);
        }
        if (result.StandardErrorContent) {
          log.info('--- SSM stderr ---');
          console.log(result.StandardErrorContent);
        }

        throw new Error(`SSM command ${status}`);
      }
    } catch (err) {
      if ((err as Error).message.startsWith('SSM command')) {
        throw err;
      }
    }

    if (waited >= DEPLOY_TIMEOUT) {
      throw new Error(`SSM command timed out after ${DEPLOY_TIMEOUT}s`);
    }

    log.info(`  ⏳ Status: ${status} (${waited}s / ${DEPLOY_TIMEOUT}s)`);
  }
}

// =============================================================================
// Step 5: Trigger ArgoCD Sync
// =============================================================================

async function triggerArgoSync(
  instanceId: string,
  appName: string,
): Promise<void> {
  log.task(`Triggering ArgoCD sync for ${appName}...`);

  try {
    const command = `if command -v argocd &>/dev/null; then argocd app sync ${appName} --grpc-web 2>/dev/null || echo "ArgoCD sync skipped (not configured)"; else echo "ArgoCD not installed — skipping sync"; fi`;

    const response = await ssmClient.send(
      new SendCommandCommand({
        DocumentName: 'AWS-RunShellScript',
        Targets: [{ Key: 'instanceids', Values: [instanceId] }],
        Parameters: { commands: [command] },
        TimeoutSeconds: 60,
      }),
    );

    if (response.Command?.CommandId) {
      log.success(`ArgoCD sync triggered: ${response.Command.CommandId}`);
    } else {
      log.warn('ArgoCD sync skipped (SSM command failed)');
    }
  } catch {
    log.warn('ArgoCD sync skipped');
  }
}

// =============================================================================
// Step 6: Collect Deployment Logs
// =============================================================================

async function collectLogs(
  commandId: string,
  instanceId: string,
): Promise<void> {
  log.task('Collecting deployment logs...');

  try {
    const result = await ssmClient.send(
      new GetCommandInvocationCommand({
        CommandId: commandId,
        InstanceId: instanceId,
      }),
    );

    writeSummary(`### 📋 Manifest Deployment — ${project} (${environment})`);
    writeSummary('```');
    writeSummary(result.StandardOutputContent ?? '(stdout unavailable)');
    writeSummary('```');

    if (result.StandardErrorContent && result.StandardErrorContent !== 'None') {
      writeSummary('### ⚠️ Manifest Deployment — stderr');
      writeSummary('```');
      writeSummary(result.StandardErrorContent);
      writeSummary('```');
    }

    log.success('Deployment logs collected');
  } catch (err) {
    log.warn(`Could not collect logs: ${(err as Error).message}`);
  }
}

// =============================================================================
// Helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeSummary(line: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath && existsSync(summaryPath)) {
    appendFileSync(summaryPath, line + '\n');
  }
}

function setOutput(name: string, value: string): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath && existsSync(outputPath)) {
    appendFileSync(outputPath, `${name}=${value}\n`);
  }
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  log.header(`Deploy K8s Manifests — ${project} (${environment})`);

  const config = getProjectConfig(project, environment);

  log.keyValue('Project', project);
  log.keyValue('Environment', environment);
  log.keyValue('Region', region);
  log.keyValue('SSM Document', config.ssmDocumentName);
  log.blank();

  const instanceId = await findInstance(config);

  if (!instanceId) {
    log.warn('No Kubernetes control plane instance found — skipping manifest deployment');
    log.info('First boot will apply manifests automatically via UserData');
    setOutput('skip', 'true');
    return;
  }

  setOutput('skip', 'false');
  setOutput('instance_id', instanceId);

  await waitForSsmAgent(instanceId);
  await showBootDiagnostics(instanceId);
  const commandId = await deployManifests(instanceId, config);
  await triggerArgoSync(instanceId, config.argoAppName);
  await collectLogs(commandId, instanceId);

  log.blank();
  log.success('Deploy-manifests completed');
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  writeSummary('### ❌ Deploy-Manifests Failed');
  writeSummary(`Error: ${err.message}`);
  process.exit(1);
});
