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
 * Steps:
 *   1. Resolve control plane instance ID via SSM
 *   2. Retrieve CI bot token (env ARGOCD_TOKEN or Secrets Manager)
 *   3. Poll ArgoCD API (via SSM) per mode
 *
 * Graceful skip: if instance ID or token is unavailable (Day-0), the
 * script exits 0 with a warning annotation instead of failing.
 *
 * Usage:
 *   npx tsx infra/scripts/cd/verify-argocd-sync.ts \
 *     --environment development --region eu-west-1 --mode sync
 *
 * Called by:
 *   - .github/workflows/gitops-k8s.yml (mode=sync)
 *   - .github/workflows/_deploy-ssm-automation.yml (mode=health)
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
import { parseArgs, buildAwsConfig } from "@nelsonlamounier/cdk-deploy-scripts/aws.js";
import {
  emitAnnotation,
  maskSecret,
  writeSummary,
} from "@nelsonlamounier/cdk-deploy-scripts/github.js";
import logger from "@nelsonlamounier/cdk-deploy-scripts/logger.js";

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
// We resolve the ClusterIP dynamically via kubectl because:
//   1. Nodes can't resolve .svc.cluster.local DNS (VPC DNS only)
//   2. server.insecure=true means ArgoCD serves plain HTTP on port 8080
//      (Service port 80 → targetPort 8080), so we use http:// not https://

const ARGOCD_ROOT_PATH = "/argocd";

/** Build a shell command that resolves the ArgoCD ClusterIP then curls it.
 *
 * ArgoCD is configured with server.insecure=true — it serves plain HTTP on
 * port 8080. The argocd-server Service maps port 80 → targetPort 8080.
 * We therefore use http://:80 (the default for http://) not https://:443.
 * Using https:// against a non-TLS backend causes an immediate TLS handshake
 * failure which curl reports as HTTP status 000.
 */
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
  // Wave 0: Certificate infrastructure
  "cert-manager",
  // Wave 1: TLS configuration
  "cert-manager-config",
  // Wave 2: Ingress controller
  "traefik",
  // Wave 3: Applications & infrastructure
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

/** Track whether self-healing has already been attempted this run. */
let tokenRefreshAttempted = false;

/** Fetch a secret from Secrets Manager, returning undefined if missing. */
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

/** Sleep for a given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a curl command on the control plane node via SSM send-command.
 * Returns the stdout output (curl response body or HTTP code).
 */
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

    // Wait for command to finish (poll up to 15s)
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

/**
 * Resolve a running instance ID by its k8s:bootstrap-role tag.
 *
 * Uses EC2 DescribeInstances filtered by tag + running state.
 * This replaces the previous SSM parameter-based lookup, which
 * was prone to stale IDs when instances were replaced by the ASG.
 */
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

/**
 * Resolve the control plane instance ID via EC2 tags.
 * Used to route ArgoCD API calls via SSM send-command (localhost).
 */
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

/**
 * Retrieve the ArgoCD CI bot token.
 *
 * Priority:
 *   1. ARGOCD_TOKEN env var (set by SSM pipeline from previous step output)
 *   2. Secrets Manager (used by GitOps pipeline)
 *
 * @returns Bearer token or undefined if not available
 */
async function retrieveCIToken(): Promise<string | undefined> {
  // retrieveCIToken is only called in --mode sync (step 2 of 3).
  // Health mode no longer requires a token (uses kubectl readiness instead).
  logger.step(2, 3, "Retrieve CI Bot Token");

  // Check env var first (SSM pipeline passes token from previous step)
  const envToken = process.env.ARGOCD_TOKEN;
  if (envToken) {
    maskSecret(envToken);
    logger.success("CI bot token loaded from ARGOCD_TOKEN env var");
    return envToken;
  }

  // Fall back to Secrets Manager
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

/**
 * Self-heal: regenerate the CI bot token via the ArgoCD REST API.
 *
 * Uses curl + python3 directly on the control plane node (via SSM):
 *   1. Resolve admin password: SSM Parameter Store → argocd-initial-admin-secret
 *   2. POST /argocd/api/v1/session  → obtain a short-lived admin session token
 *   3. POST /argocd/api/v1/account/ci-bot/token → generate a new CI bot API key
 *   4. Validate the new token, then store in Secrets Manager
 *
 * This replaces the previous `kubectl exec argocd account generate-token`
 * approach which is broken: that command does not accept --username/--password
 * flags and requires a prior `argocd login`, so it silently returned empty.
 *
 * @returns The new token, or undefined if regeneration failed
 */
async function refreshCIToken(instanceId: string): Promise<string | undefined> {
  if (tokenRefreshAttempted) {
    logger.warn("  Token refresh already attempted this run — skipping");
    return undefined;
  }
  tokenRefreshAttempted = true;

  logger.info(
    "  → Self-healing: regenerating CI bot token via ArgoCD REST API...",
  );

  // Resolve admin password via SSM → argocd-initial-admin-secret fallback.
  // Mirrors the two-source fallback in bootstrap's _resolve_admin_password.
  const fetchAdminPassCmd = [
    "export KUBECONFIG=/etc/kubernetes/admin.conf",
    // Source 1: SSM Parameter Store (set by Step 10b during bootstrap)
    `ADMIN_PASS=$(aws ssm get-parameter --name "/k8s/${environment}/argocd-admin-password" --with-decryption --query Parameter.Value --output text 2>/dev/null)`,
    // Source 2: argocd-initial-admin-secret (Day-0 — before Step 10b runs)
    "if [ -z \"$ADMIN_PASS\" ]; then ADMIN_PASS=$(kubectl get secret argocd-initial-admin-secret -n argocd -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null); fi",
    'if [ -z "$ADMIN_PASS" ]; then echo "ERROR: no admin password from SSM or initial-admin-secret"; exit 1; fi',
    // Resolve ArgoCD ClusterIP (same strategy as buildArgoCDCurl)
    "ARGOCD_IP=$(kubectl get svc argocd-server -n argocd -o jsonpath='{.spec.clusterIP}' 2>/dev/null)",
    'if [ -z "$ARGOCD_IP" ]; then echo "ERROR: ArgoCD ClusterIP not found"; exit 1; fi',
    // Step 1: Login → obtain a short-lived admin session token
    'ARGOCD_SESSION=$(curl -sf --max-time 15 -X POST "http://${ARGOCD_IP}/argocd/api/v1/session" -H "Content-Type: application/json" -d "{\\"username\\":\\"admin\\",\\"password\\":\\"${ADMIN_PASS}\\"}" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get(\'token\',\'\'))" 2>/dev/null)',
    'if [ -z "$ARGOCD_SESSION" ]; then echo "ERROR: ArgoCD admin login failed"; exit 1; fi',
    // Step 2: Generate a non-expiring CI bot API token
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

  // Validate the new token
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

  // Store in Secrets Manager
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

/**
 * Probe a single ArgoCD application to surface auth/network errors early.
 * Runs via SSM send-command on the control plane node.
 *
 * Self-healing: if the probe returns HTTP 401/403, attempts to regenerate
 * the CI bot token via SSM and returns the refreshed token.
 *
 * @returns Refreshed token if self-healing was triggered, otherwise undefined
 */
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

  // Output format: body\nHTTP_CODE
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

    // Self-healing failed — emit the original error
    emitAnnotation(
      "error",
      "Authentication failed. Self-healing token refresh also failed. Manual fix: just argocd-ci-token",
      "ArgoCD Auth",
    );
  } else if (httpCode && parseInt(httpCode, 10) >= 500) {
    logger.warn("  ArgoCD server returned a server error");
  }

  console.log("");
  return undefined;
}

/**
 * Check the sync and health status of a single ArgoCD application.
 * Runs via SSM send-command on the control plane node.
 */
async function checkApp(
  instanceId: string,
  token: string,
  app: string,
): Promise<AppStatus> {
  // Curl that returns only sync/health status (piped through Python to avoid
  // SSM output truncation — the monitoring app's full JSON exceeds 24KB).
  // NOTE: The python filter must be a single semicolon-separated line because
  // SSM send-command doesn't preserve newlines in the command string.
  // Shell single-quotes wrap the python code so inner double-quotes are safe.
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

/**
 * Poll all expected ArgoCD Applications until all are Synced + Healthy.
 *
 * @returns true if all apps passed, false if timed out
 */
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

  // Grace period: newly-added Applications may not exist in ArgoCD yet
  // because the root App-of-Apps hasn't reconciled. ArgoCD returns
  // "permission denied" for non-existent apps (security: prevents info leak).
  // During the grace window, treat these as "pending discovery" rather than errors.
  const gracePollCount = 3; // ~90s at 30s interval

  // Run diagnostic probe on first app (may self-heal token)
  let activeToken = token;
  const refreshedToken = await diagnosticProbe(instanceId, activeToken);
  if (refreshedToken) {
    activeToken = refreshedToken;
  }

  for (let poll = 1; poll <= maxPolls; poll++) {
    const timestamp = new Date().toISOString().slice(11, 19);
    let allSynced = true;
    const inGracePeriod = poll <= gracePollCount;

    console.log(`--- Poll ${poll}/${maxPolls} (${timestamp}) ---`);

    for (const app of EXPECTED_APPS) {
      const status = await checkApp(instanceId, activeToken, app);

      if (!status.reachable) {
        console.log(`  ${app}: [WARN] API unreachable`);
        allSynced = false;
      } else if (status.error) {
        // "permission denied" means the app doesn't exist in ArgoCD yet
        // (ArgoCD hides 404 behind 403 for security). During grace period,
        // treat as pending; after grace period, treat as error.
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

  // Timed out
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

/**
 * Pod readiness health check: poll K8s until all ArgoCD Deployments are Available.
 *
 * Uses `kubectl wait` on the control-plane node via SSM send-command.
 * Does NOT use the ArgoCD HTTP API — no token required, no ClusterIP dependency.
 *
 * Checks:
 *   1. argocd-server Deployment Available
 *   2. argocd-repo-server Deployment Available
 *   3. argocd-dex-server Deployment Available
 *   4. argocd-redis Deployment Available
 *   5. argocd-application-controller StatefulSet rolled out
 *
 * This is the correct signal for "is ArgoCD alive?" — it asks Kubernetes
 * directly rather than probing the ArgoCD HTTP API layer, which can fail
 * transiently during re-bootstrap even when the cluster is healthy.
 *
 * @param instanceId - Control-plane EC2 instance ID
 * @returns true if all ArgoCD workloads are Available within the timeout
 */
async function healthCheck(instanceId: string): Promise<boolean> {
  const totalWait = maxPolls * pollInterval;

  logger.info(
    `Health check: polling K8s pod readiness (timeout: ${totalWait}s)...`,
  );
  logger.info(
    "  Strategy: kubectl wait --for=condition=Available (no HTTP/token dependency)",
  );
  console.log("");

  /**
   * Build the kubectl readiness probe command.
   *
   * Both sub-commands run with a 30s per-attempt timeout so that a slow
   * K8s API server doesn't stall the entire poll loop. The outer poll
   * loop provides the cumulative retry window.
   *
   * Deployment check: argocd-server, argocd-repo-server, argocd-dex-server, argocd-redis
   * StatefulSet check: argocd-application-controller (rollout status is the correct verb)
   */

  // Split into two separate SSM commands to avoid output truncation
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
    // kubectl wait success: each deployment line prints "deployment.apps/<name> condition met"
    // kubectl rollout success: prints "statefulset rolling update complete" or "successfully rolled out"
    const deployOutput = await ssmCurl(instanceId, deploymentCmd);
    const deploymentReady = !!deployOutput?.includes("condition met");

    // Check StatefulSet separately
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

    // Log both outputs separated for debugging
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

  // Step 1: Resolve control plane instance
  const instanceId = await resolveControlPlaneInstance();
  if (!instanceId) {
    logger.warn("Exiting gracefully -- no control plane instance available");
    process.exit(0);
  }

  // Step 2 (health mode): kubectl pod readiness — no token required.
  // Step 2-3 (sync mode):  retrieve token → poll ArgoCD Application status.
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
