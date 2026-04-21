#!/usr/bin/env npx tsx
/**
 * Verify ArgoCD Sync (via SSM send-command)
 *
 * Polls the ArgoCD API to verify all expected Applications have reached
 * Synced + Healthy state after a Git push. Instead of calling ArgoCD
 * directly (blocked by ingress SG), runs curl on the control plane
 * node via SSM send-command.
 *
 * Modes:
 *   --mode sync   (default)  Full sync polling until all apps are Synced + Healthy
 *   --mode health            Quick reachability check — poll until HTTP 200
 *
 * Usage:
 *   npx tsx scripts/cd/verify-argocd-sync.ts \
 *     --environment development --region eu-west-1 --mode sync
 */

import { DescribeInstancesCommand, EC2Client } from "@aws-sdk/client-ec2";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand,
} from "@aws-sdk/client-ssm";
import { parseArgs, buildAwsConfig } from "../lib/aws.js";
import {
  emitAnnotation,
  maskSecret,
  writeSummary,
} from "../lib/github.js";
import logger from "../lib/logger.js";

// =============================================================================
// CLI argument parsing
// =============================================================================

const args = parseArgs(
  [
    {
      name: "environment",
      description: "Deployment environment",
      hasValue: true,
      default: "development",
    },
    {
      name: "region",
      description: "AWS region",
      hasValue: true,
      default: "eu-west-1",
    },
    {
      name: "profile",
      description: "AWS profile (local only)",
      hasValue: true,
    },
    {
      name: "mode",
      description:
        "Verification mode: sync (full polling) or health (reachability only)",
      hasValue: true,
      default: "sync",
    },
    {
      name: "poll-interval",
      description: "Seconds between polls",
      hasValue: true,
      default: "30",
    },
    {
      name: "max-polls",
      description: "Maximum number of poll attempts",
      hasValue: true,
      default: "12",
    },
  ],
  "Verify ArgoCD sync/health status via SSM send-command.",
);

const environment = args.environment as string;
const mode = (args.mode as string) || "sync";
const awsConfig = buildAwsConfig(args);
const pollInterval = parseInt(args["poll-interval"] as string, 10) || 30;
const maxPolls = parseInt(args["max-polls"] as string, 10) || 12;

// ArgoCD API path builder.
// server.rootpath=/argocd is set in argocd-cmd-params-cm, so ALL API
// endpoints (including via ClusterIP) are served under /argocd/...
const ARGOCD_ROOT_PATH = "/argocd";

function buildArgoCDCurl(
  curlFlags: string,
  apiPath: string,
  extraHeaders: string = "",
): string {
  return [
    "export KUBECONFIG=/etc/kubernetes/admin.conf",
    "ARGOCD_IP=$(kubectl get svc argocd-server -n argocd -o jsonpath='{.spec.clusterIP}' 2>/dev/null)",
    'if [ -z "$ARGOCD_IP" ]; then echo "UNREACHABLE"; exit 0; fi',
    `curl ${curlFlags} ${extraHeaders} "http://\${ARGOCD_IP}${ARGOCD_ROOT_PATH}${apiPath}" 2>/dev/null`,
  ].join(" && ");
}

// =============================================================================
// Expected ArgoCD Applications
// =============================================================================

const EXPECTED_APPS = [
  "cert-manager",
  "cert-manager-config",
  "traefik",
  "nextjs",
  "monitoring",
  "metrics-server",
  "local-path-provisioner",
  "ecr-token-refresh",
  "argocd-image-updater",
  "argocd-notifications",
];

// =============================================================================
// AWS Clients
// =============================================================================

const ssm = new SSMClient({
  region: awsConfig.region,
  credentials: awsConfig.credentials,
});

const secretsManager = new SecretsManagerClient({
  region: awsConfig.region,
  credentials: awsConfig.credentials,
});

const ec2 = new EC2Client({
  region: awsConfig.region,
  credentials: awsConfig.credentials,
});

// =============================================================================
// Helpers
// =============================================================================

let tokenRefreshAttempted = false;

async function getSecret(secretId: string): Promise<string | undefined> {
  try {
    const result = await secretsManager.send(
      new GetSecretValueCommand({ SecretId: secretId }),
    );
    return result.SecretString || undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ssmCurl(
  instanceId: string,
  curlCommand: string,
): Promise<string | undefined> {
  try {
    const sendResult = await ssm.send(
      new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: "AWS-RunShellScript",
        Parameters: { commands: [curlCommand] },
        TimeoutSeconds: 30,
      }),
    );

    const commandId = sendResult.Command?.CommandId;
    if (!commandId) return undefined;

    for (let wait = 0; wait < 5; wait++) {
      await sleep(3000);
      try {
        const invocation = await ssm.send(
          new GetCommandInvocationCommand({
            CommandId: commandId,
            InstanceId: instanceId,
          }),
        );

        if (invocation.Status === "Success" || invocation.Status === "Failed") {
          return invocation.StandardOutputContent?.trim() || undefined;
        }
      } catch {
        // InvocationDoesNotExist — command still pending
      }
    }

    return undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`SSM send-command error: ${message}`);
    return undefined;
  }
}

// =============================================================================
// ArgoCD API Types
// =============================================================================

interface AppStatus {
  app: string;
  syncStatus: string;
  healthStatus: string;
  error?: string;
  reachable: boolean;
}

// =============================================================================
// Core Functions
// =============================================================================

async function resolveInstanceByTag(
  tagValue: string,
): Promise<string | undefined> {
  try {
    const result = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: "tag:k8s:bootstrap-role", Values: [tagValue] },
          { Name: "instance-state-name", Values: ["running"] },
        ],
      }),
    );

    const instances =
      result.Reservations?.flatMap((r) => r.Instances ?? []) ?? [];
    if (instances.length === 0) return undefined;
    return instances[0].InstanceId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `EC2 describe-instances failed for tag k8s:bootstrap-role=${tagValue}: ${message}`,
    );
    return undefined;
  }
}

async function resolveControlPlaneInstance(): Promise<string | undefined> {
  const totalSteps = mode === "health" ? 2 : 3;
  logger.step(1, totalSteps, "Resolve Control Plane Instance");

  const instanceId = await resolveInstanceByTag("control-plane");
  if (!instanceId) {
    emitAnnotation(
      "warning",
      "No running control-plane instance found -- ArgoCD verification skipped",
      "ArgoCD Endpoint",
    );
    logger.warn(
      "No running instance with tag k8s:bootstrap-role=control-plane -- skipping verification",
    );
    return undefined;
  }

  maskSecret(instanceId);
  logger.info("Control plane instance resolved");
  return instanceId;
}

async function retrieveCIToken(): Promise<string | undefined> {
  logger.step(2, 3, "Retrieve CI Bot Token");

  const envToken = process.env.ARGOCD_TOKEN;
  if (envToken) {
    maskSecret(envToken);
    logger.success("CI bot token loaded from ARGOCD_TOKEN env var");
    return envToken;
  }

  const secretId = `k8s/${environment}/argocd-ci-token`;
  const token = await getSecret(secretId);

  if (!token) {
    emitAnnotation(
      "warning",
      "ArgoCD CI token not found -- skipping verification",
      "ArgoCD Token",
    );
    logger.warn("ArgoCD CI token not found in Secrets Manager -- skipping");
    return undefined;
  }

  maskSecret(token);
  logger.success("CI bot token retrieved from Secrets Manager");
  return token;
}

async function refreshCIToken(instanceId: string): Promise<string | undefined> {
  if (tokenRefreshAttempted) {
    logger.warn("  Token refresh already attempted this run — skipping");
    return undefined;
  }
  tokenRefreshAttempted = true;

  logger.info(
    "  → Self-healing: regenerating CI bot token via ArgoCD REST API...",
  );

  const fetchAdminPassCmd = [
    "export KUBECONFIG=/etc/kubernetes/admin.conf",
    `ADMIN_PASS=$(aws ssm get-parameter --name "/k8s/${environment}/argocd-admin-password" --with-decryption --query Parameter.Value --output text 2>/dev/null)`,
    "if [ -z \"$ADMIN_PASS\" ]; then ADMIN_PASS=$(kubectl get secret argocd-initial-admin-secret -n argocd -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null); fi",
    'if [ -z "$ADMIN_PASS" ]; then echo "ERROR: no admin password from SSM or initial-admin-secret"; exit 1; fi',
    "ARGOCD_IP=$(kubectl get svc argocd-server -n argocd -o jsonpath='{.spec.clusterIP}' 2>/dev/null)",
    'if [ -z "$ARGOCD_IP" ]; then echo "ERROR: ArgoCD ClusterIP not found"; exit 1; fi',
    'ARGOCD_SESSION=$(curl -sf --max-time 15 -X POST "http://${ARGOCD_IP}/argocd/api/v1/session" -H "Content-Type: application/json" -d "{\\"username\\":\\"admin\\",\\"password\\":\\"${ADMIN_PASS}\\"}" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get(\'token\',\'\'))" 2>/dev/null)',
    'if [ -z "$ARGOCD_SESSION" ]; then echo "ERROR: ArgoCD admin login failed"; exit 1; fi',
    'NEW_TOKEN=$(curl -sf --max-time 15 -X POST "http://${ARGOCD_IP}/argocd/api/v1/account/ci-bot/token" -H "Authorization: Bearer ${ARGOCD_SESSION}" -H "Content-Type: application/json" --data-raw \'{"expiresIn":0,"id":""}\' 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get(\'token\',\'\'))" 2>/dev/null)',
    'if [ -z "$NEW_TOKEN" ]; then echo "ERROR: CI bot token generation failed"; exit 1; fi',
    'echo "$NEW_TOKEN"',
  ].join(" && ");

  const newToken = await ssmCurl(instanceId, fetchAdminPassCmd);

  if (!newToken || newToken.startsWith("ERROR") || newToken.length < 20) {
    logger.error(
      `  ✗ Token regeneration failed: ${newToken || "empty response"}`,
    );
    return undefined;
  }

  const validateCmd = buildArgoCDCurl(
    `-s -o /dev/null -w '%{http_code}' --max-time 10`,
    "/api/v1/applications",
    `-H 'Authorization: Bearer ${newToken}'`,
  );

  const httpCode = await ssmCurl(instanceId, validateCmd);
  if (httpCode?.trim() !== "200") {
    logger.error(
      `  ✗ Regenerated token validation failed (HTTP ${httpCode?.trim() || "000"})`,
    );
    return undefined;
  }

  logger.success("  ✓ Regenerated token validated (HTTP 200)");

  const secretId = `k8s/${environment}/argocd-ci-token`;
  try {
    await secretsManager.send(
      new PutSecretValueCommand({ SecretId: secretId, SecretString: newToken }),
    );
    logger.success("  ✓ Token updated in Secrets Manager");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`  ⚠ Failed to update Secrets Manager: ${message}`);
  }

  maskSecret(newToken);
  return newToken;
}

async function diagnosticProbe(
  instanceId: string,
  token: string,
): Promise<string | undefined> {
  const probeApp = EXPECTED_APPS[0];
  const curlCmd = buildArgoCDCurl(
    `-s -w '\\n%{http_code}' --max-time 10`,
    `/api/v1/applications/${probeApp}`,
    `-H 'Authorization: Bearer ${token}'`,
  );

  logger.info(
    `Diagnostic probe: ArgoCD API /applications/${probeApp} (via SSM)`,
  );

  const output = await ssmCurl(instanceId, curlCmd);

  if (!output || output.includes("UNREACHABLE")) {
    emitAnnotation(
      "error",
      "ArgoCD API is unreachable via SSM send-command",
      "ArgoCD Connectivity",
    );
    logger.error("  ArgoCD API unreachable via SSM");
    return undefined;
  }

  const lines = output.split("\n");
  const httpCode = lines[lines.length - 1]?.trim();
  logger.info(`  HTTP Status: ${httpCode}`);

  if (httpCode === "401" || httpCode === "403") {
    logger.warn(
      "  Authentication failed — attempting self-healing token refresh...",
    );

    const refreshedToken = await refreshCIToken(instanceId);
    if (refreshedToken) {
      logger.success("  ✓ Self-healing successful — using refreshed token");
      emitAnnotation(
        "notice",
        "CI bot token was stale and has been automatically regenerated",
        "ArgoCD Token Refresh",
      );
      console.log("");
      return refreshedToken;
    }

    emitAnnotation(
      "error",
      "Authentication failed. Self-healing token refresh also failed.",
      "ArgoCD Auth",
    );
  } else if (httpCode && parseInt(httpCode, 10) >= 500) {
    logger.warn("  ArgoCD server returned a server error");
  }

  console.log("");
  return undefined;
}

async function checkApp(
  instanceId: string,
  token: string,
  app: string,
): Promise<AppStatus> {
  const pythonFilter =
    "import json,sys;" +
    "d=json.loads(sys.stdin.read());" +
    'print(json.dumps({"error":d.get("error",""),' +
    '"sync":d.get("status",{}).get("sync",{}).get("status","Unknown"),' +
    '"health":d.get("status",{}).get("health",{}).get("status","Unknown")}))';
  const curlCmd =
    buildArgoCDCurl(
      "-s --max-time 10",
      `/api/v1/applications/${app}`,
      `-H 'Authorization: Bearer ${token}'`,
    ) + ` | python3 -c '${pythonFilter}'`;

  const output = await ssmCurl(instanceId, curlCmd);

  if (!output) {
    return {
      app,
      syncStatus: "Unknown",
      healthStatus: "Unknown",
      reachable: false,
    };
  }

  try {
    const data = JSON.parse(output) as {
      error?: string;
      sync?: string;
      health?: string;
    };

    if (data.error && data.error !== "") {
      return {
        app,
        syncStatus: "Unknown",
        healthStatus: "Unknown",
        error: data.error,
        reachable: true,
      };
    }

    return {
      app,
      syncStatus: data.sync || "Unknown",
      healthStatus: data.health || "Unknown",
      reachable: true,
    };
  } catch {
    return {
      app,
      syncStatus: "Unknown",
      healthStatus: "Unknown",
      error: "Invalid JSON response",
      reachable: true,
    };
  }
}

async function waitForSync(
  instanceId: string,
  token: string,
): Promise<boolean> {
  logger.step(3, 3, "Wait for ArgoCD Sync");

  console.log("## ArgoCD Sync Verification (via SSM)");
  console.log("");
  console.log(`Expected Applications: ${EXPECTED_APPS.join(", ")}`);
  console.log(`Poll interval: ${pollInterval}s, max polls: ${maxPolls}`);
  console.log("");

  const gracePollCount = 3;

  let activeToken = token;
  const refreshedToken = await diagnosticProbe(instanceId, activeToken);
  if (refreshedToken) {
    activeToken = refreshedToken;
  }

  for (let poll = 1; poll <= maxPolls; poll++) {
    const ts = new Date().toISOString().slice(11, 19);
    let allSynced = true;
    const inGracePeriod = poll <= gracePollCount;

    console.log(`--- Poll ${poll}/${maxPolls} (${ts}) ---`);

    for (const app of EXPECTED_APPS) {
      const status = await checkApp(instanceId, activeToken, app);

      if (!status.reachable) {
        console.log(`  ${app}: [WARN] API unreachable`);
        allSynced = false;
      } else if (status.error) {
        const isNotFound = status.error
          .toLowerCase()
          .includes("permission denied");
        if (isNotFound && inGracePeriod) {
          console.log(
            `  ${app}: [WAIT] Not yet discovered by ArgoCD (grace period ${poll}/${gracePollCount})`,
          );
        } else if (isNotFound) {
          console.log(
            `  ${app}: [ERROR] Not found in ArgoCD — check root App-of-Apps sync`,
          );
        } else {
          console.log(`  ${app}: [ERROR] ${status.error}`);
        }
        allSynced = false;
      } else if (
        status.syncStatus === "Synced" &&
        status.healthStatus === "Healthy"
      ) {
        console.log(`  ${app}: [PASS] Synced + Healthy`);
      } else {
        console.log(
          `  ${app}: [WAIT] Sync=${status.syncStatus} Health=${status.healthStatus}`,
        );
        allSynced = false;
      }
    }

    if (allSynced) {
      console.log("");
      console.log(
        `## [PASS] All ${EXPECTED_APPS.length} Applications are Synced and Healthy`,
      );

      writeSummary("## ArgoCD Sync Verification");
      writeSummary("");
      writeSummary(
        `✅ All ${EXPECTED_APPS.length} Applications are **Synced + Healthy**`,
      );
      writeSummary("");
      writeSummary("### Deployment Map");
      writeSummary("");
      writeSummary("| Wave | Application | Sync | Health | ArgoCD |");
      writeSummary("|:---|:---|:---|:---|:---|");

      const waveMap: Record<string, string> = {
        "cert-manager": "0",
        "cert-manager-config": "1",
        traefik: "2",
      };

      for (const app of EXPECTED_APPS) {
        const wave = waveMap[app] || "3";
        const argoLink = `[View](ArgoCD UI)`;
        writeSummary(
          `| ${wave} | ${app} | ✅ Synced | ✅ Healthy | ${argoLink} |`,
        );
      }

      return true;
    }

    if (poll < maxPolls) {
      await sleep(pollInterval * 1000);
    }
  }

  const totalWait = maxPolls * pollInterval;
  console.log("");
  console.log(
    `## [WARN] Some Applications did not reach Synced+Healthy within ${totalWait}s`,
  );
  console.log("This is informational -- ArgoCD will continue retrying.");

  writeSummary("## ArgoCD Sync Verification");
  writeSummary("");
  writeSummary(
    `⚠️ Some Applications did not reach Synced+Healthy within ${totalWait}s`,
  );

  return false;
}

// =============================================================================
// Health Check Mode
// =============================================================================

async function healthCheck(instanceId: string): Promise<boolean> {
  const totalWait = maxPolls * pollInterval;

  logger.info(
    `Health check: polling K8s pod readiness (timeout: ${totalWait}s)...`,
  );
  logger.info(
    "  Strategy: kubectl wait --for=condition=Available (no HTTP/token dependency)",
  );
  console.log("");

  const deploymentCmd = [
    "export KUBECONFIG=/etc/kubernetes/admin.conf",
    "kubectl wait deployment/argocd-server deployment/argocd-repo-server" +
      " deployment/argocd-dex-server deployment/argocd-redis" +
      " -n argocd --for=condition=Available --timeout=30s 2>&1",
  ].join(" && ");

  const controllerCmd = [
    "export KUBECONFIG=/etc/kubernetes/admin.conf",
    "kubectl rollout status statefulset/argocd-application-controller" +
      " -n argocd --timeout=30s 2>&1",
  ].join(" && ");

  for (let attempt = 1; attempt <= maxPolls; attempt++) {
    const deployOutput = await ssmCurl(instanceId, deploymentCmd);
    const deploymentReady = !!deployOutput?.includes("condition met");

    const controllerOutput = await ssmCurl(instanceId, controllerCmd);
    const controllerReady =
      controllerOutput != null &&
      (controllerOutput.includes("successfully rolled out") ||
        controllerOutput.includes("rolling update complete") ||
        controllerOutput.includes("partitioned roll out complete") ||
        controllerOutput.includes("roll out complete"));

    if (deploymentReady && controllerReady) {
      logger.success("All ArgoCD workloads are Available and rolled out");
      writeSummary("## ArgoCD Health Check");
      writeSummary("");
      writeSummary(
        "All ArgoCD workloads are **Running and Available** (kubectl readiness)",
      );
      writeSummary("");
      writeSummary("| Workload | Kind | Check |");
      writeSummary("|---|---|---|");
      writeSummary("| argocd-server | Deployment | Available |");
      writeSummary("| argocd-repo-server | Deployment | Available |");
      writeSummary("| argocd-dex-server | Deployment | Available |");
      writeSummary("| argocd-redis | Deployment | Available |");
      writeSummary(
        "| argocd-application-controller | StatefulSet | Rolled out |",
      );

      return true;
    }

    logger.info(
      ` Attempt ${attempt}/${maxPolls} -- ArgoCD pods not yet ready, retrying in ${pollInterval}s...`,
    );
    logger.info(
      `  Deployment output: ${deployOutput?.slice(0, 300).replaceAll("\n", " | ") || "No output"}`,
    );
    logger.info(
      `  Controller output: ${controllerOutput?.slice(0, 300).replaceAll("\n", " | ") || "No output"}`,
    );

    if (attempt < maxPolls) {
      await sleep(pollInterval * 1000);
    }
  }

  emitAnnotation(
    "error",
    `ArgoCD pods not Available after ${totalWait}s — bootstrap may have failed`,
    "ArgoCD Health",
  );
  return false;
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const modeLabel = mode === "health" ? "Health Check" : "Sync Verification";
  logger.header(`Verify ArgoCD (${modeLabel})`);
  logger.info(`Environment: ${environment}`);
  logger.info(`Region:      ${awsConfig.region}`);
  logger.info(`Mode:        ${mode}`);
  console.log("");

  const instanceId = await resolveControlPlaneInstance();
  if (!instanceId) {
    logger.warn("Exiting gracefully -- no control plane instance available");
    process.exit(0);
  }

  if (mode === "health") {
    const reachable = await healthCheck(instanceId);
    if (!reachable) {
      process.exit(1);
    }
  } else {
    const token = await retrieveCIToken();
    if (!token) {
      logger.warn("Exiting gracefully -- no CI bot token available");
      process.exit(0);
    }
    const success = await waitForSync(instanceId, token);
    if (!success) {
      emitAnnotation(
        "warning",
        "Some ArgoCD Applications did not reach Synced+Healthy -- ArgoCD will continue retrying",
        "ArgoCD Sync Timeout",
      );
      process.exit(1);
    }
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  emitAnnotation(
    "error",
    `ArgoCD sync verification failed: ${message}`,
    "ArgoCD Sync Error",
  );
  logger.fatal(`ArgoCD sync verification failed: ${message}`);
});
