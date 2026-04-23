#!/usr/bin/env npx tsx
/**
 * @format
 * Kubernetes Infrastructure Smoke Tests
 *
 * Validates the full kubeadm Kubernetes deployment after a CDK deploy.
 * Covers all stacks (Data, Base, ControlPlane, GeneralPool, MonitoringPool,
 * AppIam, API, Edge, Observability) and their resources.
 *
 * Checks performed:
 *   1. CloudFormation Stack Status (all 10 stacks)
 *   2. EIP HTTP Health (Traefik/Ingress controller responding on control plane)
 *   3. SSM Parameters (/k8s/{env}/*)
 *   4. S3 Scripts Bucket (k8s manifests bucket accessible)
 *   5. API Gateway (subscription endpoint responds)
 *   6. CloudFront HTTPS (edge distribution responds)
 *
 * Usage:
 *   npx tsx scripts/deployment/smoke-tests-kubernetes.ts development
 *   npx tsx scripts/deployment/smoke-tests-kubernetes.ts production --region eu-west-1 \
 *     --cloudfront-domain k8s.example.com
 *
 * Exit codes:
 *   0 = all critical checks passed
 *   1 = critical check failed
 */

import { parseArgs } from 'util';

import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { setOutput, writeSummary } from '@nelsonlamounier/cdk-deploy-scripts/github.js';
import logger from '@nelsonlamounier/cdk-deploy-scripts/logger.js';
import { Agent, fetch as undiciFetch } from 'undici';

import { getProject, type Environment } from '../shared/stacks.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type CheckStatus = 'healthy' | 'unhealthy' | 'degraded' | 'skipped';

interface CheckResult {
  name: string;
  status: CheckStatus;
  critical: boolean;
  details?: string;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const { positionals, values: flags } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    region: { type: 'string', default: process.env.AWS_REGION || 'eu-west-1' },
    'cloudfront-domain': { type: 'string', default: process.env.CLOUDFRONT_DOMAIN || '' },
  },
});

const environment = positionals[0] as Environment;
const region = flags.region!;
const edgeRegion = 'us-east-1';

let cloudfrontDomain = flags['cloudfront-domain']!;

if (!environment) {
  console.error(
    'Usage: smoke-tests-kubernetes.ts <environment> [--region <region>] [--cloudfront-domain <domain>]',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Project Configuration
// ---------------------------------------------------------------------------
const _project = getProject('kubernetes');
if (!_project) {
  console.error('Kubernetes project not found in stacks configuration');
  process.exit(1);
}
// Re-bind after the guard so TypeScript narrowing persists across function boundaries
const project = _project;

// SSM prefix matches the CDK configuration
const k8sSsmPrefix = `/k8s/${environment}`;

// ---------------------------------------------------------------------------
// AWS Clients
// ---------------------------------------------------------------------------
const cfn = new CloudFormationClient({ region });
const cfnEdge = new CloudFormationClient({ region: edgeRegion });
const s3 = new S3Client({ region });
const ssm = new SSMClient({ region });
const ssmEdge = new SSMClient({ region: edgeRegion });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * HTTP check with retry and exponential backoff.
 *
 * Infrastructure takes time to propagate after CloudFormation reports
 * UPDATE_COMPLETE — CloudFront DNS, Traefik pod readiness, and API Gateway
 * edge caches may need 1–3 minutes to fully route traffic.
 *
 * @param url - URL to check
 * @param opts - Options: timeoutMs per attempt, maxAttempts, initialDelayMs, dispatcher
 * @returns HTTP status code, or 0 if all attempts failed
 */
async function httpCheckWithRetry(
  url: string,
  opts: {
    timeoutMs?: number;
    maxAttempts?: number;
    initialDelayMs?: number;
    dispatcher?: Agent;
  } = {},
): Promise<number> {
  const {
    timeoutMs = 15_000,
    maxAttempts = 4,
    initialDelayMs = 2_000,
    dispatcher,
  } = opts;

  let lastError = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await undiciFetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
        ...(dispatcher && { dispatcher }),
      });
      return response.status;
    } catch (err) {
      lastError = (err as Error).message || 'unknown error';

      if (attempt < maxAttempts) {
        const delay = initialDelayMs * Math.pow(2, attempt - 1);
        logger.info(`  Attempt ${attempt}/${maxAttempts} failed (${lastError}), retrying in ${delay / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  logger.warn(`  All ${maxAttempts} attempts failed for ${url}: ${lastError}`);
  return 0;
}

/**
 * TLS-insecure HTTP check for IP-based endpoints.
 *
 * When hitting an Elastic IP directly, the SSL certificate is issued for the
 * domain (e.g., app.example.com), not the IP address. Node.js native fetch
 * enforces strict TLS validation and throws ERR_TLS_CERT_ALTNAME_INVALID.
 *
 * This uses an undici Agent with `connect.rejectUnauthorized = false` to
 * bypass certificate validation for that specific check only.
 */
const tlsInsecureAgent = new Agent({
  connect: { rejectUnauthorized: false },
});

async function httpCheckInsecureTls(
  url: string,
  opts: { timeoutMs?: number; maxAttempts?: number; initialDelayMs?: number } = {},
): Promise<number> {
  return httpCheckWithRetry(url, { ...opts, dispatcher: tlsInsecureAgent });
}

async function getStackOutput(
  stackName: string,
  outputKey: string,
  client: CloudFormationClient = cfn,
): Promise<string | undefined> {
  try {
    const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
    const outputs = response.Stacks?.[0]?.Outputs ?? [];
    return outputs.find((o) => o.OutputKey === outputKey)?.OutputValue;
  } catch {
    return undefined;
  }
}

// ==========================================================================
// AUTO-DISCOVERY: EIP + CloudFront + API Gateway from SSM
// ==========================================================================
let eipAddress = '';
let apiGatewayUrl = '';

async function discoverEndpoints(): Promise<void> {
  logger.task('Auto-discovering endpoints from SSM and stack outputs...');

  const apiStack = project.stacks.find((s) => s.id === 'api');

  const [eipResult, cfResult, apiResult] = await Promise.allSettled([
    // EIP from SSM
    ssm.send(new GetParametersCommand({ Names: [`${k8sSsmPrefix}/elastic-ip`] })),
    // CloudFront domain from Edge SSM (only if not provided via CLI)
    !cloudfrontDomain
      ? ssmEdge.send(
          new GetParametersCommand({
            Names: [`${k8sSsmPrefix}/cloudfront/distribution-domain`],
          }),
        )
      : Promise.resolve(null),
    // API Gateway URL from stack output
    apiStack
      ? getStackOutput(apiStack.getStackName(environment), 'ApiUrl')
      : Promise.resolve(undefined),
  ]);

  // Process EIP
  if (eipResult.status === 'fulfilled') {
    const value = eipResult.value?.Parameters?.[0]?.Value;
    if (value) {
      eipAddress = value;
      logger.success(`EIP discovered: ${eipAddress}`);
    } else {
      logger.warn('EIP not found in SSM');
    }
  } else {
    logger.warn(`EIP discovery failed: ${eipResult.reason}`);
  }

  // Process CloudFront
  if (cfResult.status === 'fulfilled' && cfResult.value) {
    const value = cfResult.value.Parameters?.[0]?.Value;
    if (value) {
      cloudfrontDomain = value;
      logger.success(`CloudFront domain discovered: ${cloudfrontDomain}`);
    } else {
      logger.warn('CloudFront domain not found in SSM (Edge stack may not be deployed)');
    }
  } else if (cfResult.status === 'rejected') {
    logger.warn(`CloudFront domain discovery failed: ${cfResult.reason}`);
  }

  // Process API Gateway
  if (apiResult.status === 'fulfilled' && apiResult.value) {
    apiGatewayUrl = apiResult.value;
    logger.success(`API Gateway discovered: ${apiGatewayUrl}`);
  } else if (apiResult.status === 'fulfilled' && apiStack) {
    logger.warn('API Gateway URL not found in stack outputs');
  } else if (apiResult.status === 'rejected') {
    logger.warn(`API Gateway discovery failed: ${apiResult.reason}`);
  }
}

// ==========================================================================
// CHECK 1: CloudFormation Stack Status
// ==========================================================================
async function checkCloudFormationStacks(): Promise<CheckResult> {
  logger.task('Checking CloudFormation stack statuses...');

  const stacks = project.stacks;

  let allHealthy = true;
  let anyFailed = false;
  const details: string[] = [];

  for (const stack of stacks) {
    const stackName = stack.getStackName(environment);
    const isEdge = stack.id === 'edge';
    const client = isEdge ? cfnEdge : cfn;
    const regionLabel = isEdge ? ` (${edgeRegion})` : '';

    try {
      const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
      const status = response.Stacks?.[0]?.StackStatus ?? 'UNKNOWN';
      const healthy = status.includes('COMPLETE') && !status.includes('ROLLBACK');

      if (healthy) {
        logger.success(`${stack.name}${regionLabel}: ${status}`);
      } else {
        logger.error(`${stack.name}${regionLabel}: ${status}`);
        allHealthy = false;
        if (status.includes('FAILED') || status.includes('ROLLBACK')) {
          anyFailed = true;
        }
      }
      details.push(`${stack.name}: ${status}`);
    } catch {
      // NOT_FOUND — Edge or optional stacks may not be deployed
      if (isEdge || stack.optional) {
        const label = isEdge ? 'Edge stack' : 'Optional stack';
        logger.warn(`${stack.name}${regionLabel}: NOT_FOUND (${label} not deployed — OK)`);
        details.push(`${stack.name}: NOT_FOUND (optional)`);
      } else {
        logger.error(`${stack.name}${regionLabel}: NOT_FOUND`);
        details.push(`${stack.name}: NOT_FOUND`);
        allHealthy = false;
        anyFailed = true;
      }
    }
  }

  return {
    name: 'CloudFormation Stacks',
    status: allHealthy ? 'healthy' : anyFailed ? 'unhealthy' : 'degraded',
    critical: true,
    details: details.join('; '),
  };
}

// ==========================================================================
// CHECK 3: EIP HTTP Health (Traefik/Ingress Controller)
//
// Expected responses:
//   HTTP  root (IP):  404 — Traefik default backend (no IngressRoute matches /)
//   HTTPS root (IP):  404 — same, but requires TLS-insecure fetch because the
//                     cert CN is for the domain, not the IP address.
//   502/503:          Traefik is alive but pods are down (CrashLoopBackOff)
// ==========================================================================
async function checkEipHealth(): Promise<CheckResult> {
  if (!eipAddress) {
    logger.info('No EIP available — skipping');
    return { name: 'EIP HTTP Health', status: 'skipped', critical: false };
  }

  logger.task(`Testing HTTP endpoint on EIP ${eipAddress}...`);
  let passed = 0;
  let failed = 0;
  const details: string[] = [];

  // --- HTTP root (plain TCP — no TLS issues) ---
  // Traefik default backend returns 404 when no IngressRoute matches the root IP.
  // 502/503 means Traefik is alive but upstream pods are unhealthy.
  const EXPECTED_EIP_CODES = [404];
  const ACCEPTABLE_EIP_CODES = [200, 301, 302, 404];

  const rootCode = await httpCheckWithRetry(`http://${eipAddress}/`, { maxAttempts: 4 });

  if (EXPECTED_EIP_CODES.includes(rootCode)) {
    logger.success(`EIP root: HTTP ${rootCode} (Traefik default backend — expected)`);
    passed++;
    details.push(`HTTP ${rootCode}`);
  } else if (ACCEPTABLE_EIP_CODES.includes(rootCode)) {
    logger.success(`EIP root: HTTP ${rootCode} (acceptable)`);
    passed++;
    details.push(`HTTP ${rootCode}`);
  } else if (rootCode === 502 || rootCode === 503) {
    logger.warn(`EIP root: HTTP ${rootCode} (Traefik alive but upstream pods unhealthy)`);
    details.push(`HTTP ${rootCode} (upstream degraded)`);
    // Don't fail — Traefik itself is responding, pods may still be starting
    passed++;
  } else if (rootCode === 0) {
    logger.error(`EIP root: unreachable after retries (ingress not responding)`);
    details.push('unreachable');
    failed++;
  } else {
    logger.error(`EIP root: HTTP ${rootCode} (unexpected)`);
    details.push(`HTTP ${rootCode}`);
    failed++;
  }

  // --- HTTPS root (TLS-insecure — cert is for domain, not IP) ---
  // Uses undici Agent with rejectUnauthorized=false to bypass SNI/CN mismatch.
  const httpsCode = await httpCheckInsecureTls(`https://${eipAddress}/`, {
    timeoutMs: 10_000,
    maxAttempts: 3,
  });

  if (httpsCode > 0 && httpsCode < 500) {
    logger.success(`EIP HTTPS: HTTP ${httpsCode} (TLS-insecure check passed)`);
    passed++;
  } else if (httpsCode === 502 || httpsCode === 503) {
    logger.warn(`EIP HTTPS: HTTP ${httpsCode} (TLS alive but upstream degraded)`);
  } else if (httpsCode === 0) {
    logger.info('EIP HTTPS: unreachable (TLS not configured — OK for dev)');
  } else {
    logger.warn(`EIP HTTPS: HTTP ${httpsCode}`);
  }

  if (failed > 0) {
    return {
      name: 'EIP HTTP Health',
      status: 'unhealthy',
      critical: false,
      details: details.join('; '),
    };
  }

  return {
    name: 'EIP HTTP Health',
    status: passed > 0 ? 'healthy' : 'degraded',
    critical: false,
    details: details.join('; '),
  };
}

// ==========================================================================
// CHECK 4: SSM Parameters
// ==========================================================================
async function checkSsmParameters(): Promise<CheckResult> {
  logger.task('Checking SSM parameters...');

  // Core K8s SSM params (primary region)
  // Control plane + shared infrastructure params
  const k8sParams = [
    `${k8sSsmPrefix}/instance-id`,
    `${k8sSsmPrefix}/elastic-ip`,
    `${k8sSsmPrefix}/security-group-id`,
    `${k8sSsmPrefix}/scripts-bucket`,
  ];

  let totalFound = 0;
  let totalExpected = k8sParams.length;
  const allMissing: string[] = [];

  try {
    // Check primary region
    const primaryResponse = await ssm.send(
      new GetParametersCommand({ Names: k8sParams }),
    );
    const primaryFound = primaryResponse.Parameters?.length ?? 0;
    const primaryMissing = primaryResponse.InvalidParameters ?? [];
    totalFound += primaryFound;
    allMissing.push(...primaryMissing);

    logger.keyValue('Primary region', `${primaryFound}/${k8sParams.length}`);
    for (const param of primaryMissing) {
      logger.warn(`Missing (${region}): ${param}`);
    }

    // Check edge region (CloudFront distribution domain)
    const edgeParams = [
      `${k8sSsmPrefix}/cloudfront/distribution-domain`,
    ];

    try {
      const edgeResponse = await ssmEdge.send(
        new GetParametersCommand({ Names: edgeParams }),
      );
      const edgeFound = edgeResponse.Parameters?.length ?? 0;
      const edgeMissing = edgeResponse.InvalidParameters ?? [];
      totalFound += edgeFound;
      totalExpected += edgeParams.length;
      allMissing.push(...edgeMissing);

      logger.keyValue('Edge region', `${edgeFound}/${edgeParams.length}`);
      for (const param of edgeMissing) {
        logger.warn(`Missing (${edgeRegion}): ${param}`);
      }
    } catch (err) {
      logger.warn(`Edge SSM check failed: ${(err as Error).message}`);
    }

    logger.keyValue('Total', `${totalFound}/${totalExpected}`);

    if (totalFound === totalExpected) {
      logger.success('All SSM parameters exist');
      return { name: 'SSM Parameters', status: 'healthy', critical: false };
    }

    if (totalFound > 0) {
      return {
        name: 'SSM Parameters',
        status: 'degraded',
        critical: false,
        details: `${allMissing.length} missing`,
      };
    }

    return { name: 'SSM Parameters', status: 'unhealthy', critical: false };
  } catch (err) {
    logger.warn(`SSM check failed: ${(err as Error).message}`);
    return { name: 'SSM Parameters', status: 'skipped', critical: false };
  }
}

// ==========================================================================
// CHECK 5: S3 Scripts Bucket
// ==========================================================================
async function checkS3Bucket(): Promise<CheckResult> {
  logger.task('Checking S3 scripts bucket...');

  try {
    const baseStack = project.stacks.find((s) => s.id === 'base');
    if (!baseStack) {
      return { name: 'S3 Scripts Bucket', status: 'skipped', critical: false };
    }

    const baseStackName = baseStack.getStackName(environment);

    // Try stack output first
    let bucket = '';
    try {
      const response = await cfn.send(
        new DescribeStacksCommand({ StackName: baseStackName }),
      );
      const outputs = response.Stacks?.[0]?.Outputs ?? [];
      bucket =
        outputs.find((o) => o.OutputKey === 'ScriptsBucketName')?.OutputValue ?? '';
    } catch {
      // Stack output not available
    }

    if (!bucket) {
      // Fallback: deterministic bucket name pattern
      const accountId = process.env.AWS_ACCOUNT_ID || '';
      if (accountId) {
        bucket = `k8s-${environment}-k8s-scripts-${accountId}`;
      } else {
        logger.warn('Cannot determine bucket name (no stack output or AWS_ACCOUNT_ID)');
        return { name: 'S3 Scripts Bucket', status: 'skipped', critical: false };
      }
    }

    logger.keyValue('Bucket', bucket);

    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    logger.success('S3 scripts bucket is accessible');
    return { name: 'S3 Scripts Bucket', status: 'healthy', critical: false };
  } catch (err) {
    logger.warn(`S3 check failed: ${(err as Error).message}`);
    return { name: 'S3 Scripts Bucket', status: 'unhealthy', critical: false };
  }
}

// ==========================================================================
// CHECK 6: API Gateway (Subscription Endpoint)
// ==========================================================================
async function checkApiGateway(): Promise<CheckResult> {
  if (!apiGatewayUrl) {
    logger.info('No API Gateway URL available — skipping');
    return { name: 'API Gateway', status: 'skipped', critical: false };
  }

  logger.task(`Testing API Gateway at ${apiGatewayUrl}...`);

  // Normalize URL (remove trailing slash)
  const baseUrl = apiGatewayUrl.replace(/\/+$/, '');

  // Test subscriptions endpoint with GET — should return 4xx (method not allowed)
  // or 200/201. Any non-5xx response confirms API Gateway + Lambda are wired.
  // 502/503 specifically means Lambda is failing (CrashLoopBackOff equivalent).
  const subscriptionCode = await httpCheckWithRetry(`${baseUrl}/subscriptions`, {
    timeoutMs: 15_000,
    maxAttempts: 3,
  });

  if (subscriptionCode >= 200 && subscriptionCode < 500) {
    logger.success(`API /subscriptions: HTTP ${subscriptionCode}`);
    return { name: 'API Gateway', status: 'healthy', critical: false, details: `HTTP ${subscriptionCode}` };
  }

  if (subscriptionCode === 502 || subscriptionCode === 503) {
    logger.error(`API /subscriptions: HTTP ${subscriptionCode} (Lambda integration unhealthy)`);
    return {
      name: 'API Gateway',
      status: 'unhealthy',
      critical: false,
      details: `HTTP ${subscriptionCode} — Lambda integration error`,
    };
  }

  if (subscriptionCode >= 500) {
    logger.error(`API /subscriptions: HTTP ${subscriptionCode}`);
    return {
      name: 'API Gateway',
      status: 'unhealthy',
      critical: false,
      details: `HTTP ${subscriptionCode}`,
    };
  }

  logger.warn('API /subscriptions: unreachable after retries');
  return {
    name: 'API Gateway',
    status: 'degraded',
    critical: false,
    details: 'Endpoint unreachable after retries',
  };
}

// ==========================================================================
// CHECK 7: CloudFront HTTPS
// ==========================================================================
async function checkCloudFront(): Promise<CheckResult> {
  if (!cloudfrontDomain) {
    logger.info('No CloudFront domain available — skipping');
    return { name: 'CloudFront', status: 'skipped', critical: false };
  }

  logger.task(`Testing CloudFront at ${cloudfrontDomain}...`);

  // CloudFront root should return:
  //   200 — Application served successfully
  //   301/302 — HTTPS redirect or trailing-slash redirect
  // 502/503 means CloudFront can't reach origin (Traefik/app down)
  const EXPECTED_CF_CODES = [200, 301, 302];

  const rootCode = await httpCheckWithRetry(`https://${cloudfrontDomain}/`, {
    maxAttempts: 5,
    initialDelayMs: 3_000,
  });

  if (EXPECTED_CF_CODES.includes(rootCode)) {
    logger.success(`CloudFront HTTPS root: HTTP ${rootCode}`);
  } else if (rootCode === 403) {
    // CloudFront returns 403 when WAF blocks or origin is misconfigured
    logger.warn(`CloudFront HTTPS root: HTTP 403 (WAF block or origin config issue)`);
    return { name: 'CloudFront', status: 'degraded', critical: false, details: 'HTTP 403' };
  } else if (rootCode === 502 || rootCode === 503) {
    logger.error(`CloudFront HTTPS root: HTTP ${rootCode} (origin unreachable)`);
    return {
      name: 'CloudFront',
      status: 'unhealthy',
      critical: false,
      details: `HTTP ${rootCode} — origin unreachable`,
    };
  } else if (rootCode === 0) {
    logger.error('CloudFront HTTPS root: unreachable after retries');
    return { name: 'CloudFront', status: 'unhealthy', critical: false, details: 'unreachable' };
  } else {
    logger.warn(`CloudFront HTTPS root: HTTP ${rootCode} (unexpected)`);
    return { name: 'CloudFront', status: 'degraded', critical: false, details: `HTTP ${rootCode}` };
  }

  // Test health endpoint if exposed via ingress
  const healthCode = await httpCheckWithRetry(`https://${cloudfrontDomain}/healthz`, {
    timeoutMs: 10_000,
    maxAttempts: 3,
  });

  if (healthCode >= 200 && healthCode < 400) {
    logger.success(`CloudFront /healthz: HTTP ${healthCode}`);
  } else if (healthCode === 404) {
    logger.info('CloudFront /healthz: HTTP 404 (path not configured — OK)');
  } else if (healthCode === 0) {
    logger.info('CloudFront /healthz: unreachable (path may not be configured)');
  } else {
    logger.warn(`CloudFront /healthz: HTTP ${healthCode}`);
  }

  return { name: 'CloudFront', status: 'healthy', critical: false };
}

// ==========================================================================
// Main
// ==========================================================================
async function main(): Promise<void> {
  logger.header(`Kubernetes Infrastructure Smoke Tests (${environment})`);
  logger.keyValue('Region', region);
  logger.keyValue('Edge Region', edgeRegion);
  logger.keyValue('SSM Prefix', k8sSsmPrefix);
  logger.blank();

  // Auto-discover EIP, CloudFront, and API Gateway from SSM / stack outputs
  await discoverEndpoints();

  logger.blank();
  logger.keyValue('EIP', eipAddress || '(not available)');
  logger.keyValue('CloudFront', cloudfrontDomain || '(not available)');
  logger.keyValue('API Gateway', apiGatewayUrl || '(not available)');
  logger.blank();

  // Run all checks
  const results = await Promise.all([
    checkCloudFormationStacks(),
    checkEipHealth(),
    checkSsmParameters(),
    checkS3Bucket(),
    checkApiGateway(),
    checkCloudFront(),
  ]);

  // Determine overall status
  const criticalFailures = results.filter((r) => r.critical && r.status === 'unhealthy');
  const anyDegraded = results.some((r) => r.status === 'degraded');
  const overall = criticalFailures.length > 0 ? 'failure' : anyDegraded ? 'degraded' : 'success';

  // Set GitHub outputs
  setOutput('status', overall);
  for (const result of results) {
    const key = result.name.toLowerCase().replace(/\s+/g, '_') + '_status';
    setOutput(key, result.status);
  }

  // Generate GitHub Step Summary
  const summaryLines = [
    '## 🧪 Kubernetes Infrastructure Smoke Test Results',
    '',
    `**Environment**: \`${environment}\``,
    `**Region**: \`${region}\` | **Edge**: \`${edgeRegion}\``,
    `**EIP**: \`${eipAddress || 'N/A'}\``,
    `**Overall**: ${overall === 'success' ? '✅' : overall === 'degraded' ? '⚠️' : '❌'} ${overall}`,
    '',
    '### Service Health',
    '',
    '| Component | Status | Critical | Details |',
    '|-----------|--------|----------|---------|',
    ...results.map(
      (r) =>
        `| ${r.name} | ${r.status === 'healthy' ? '✅' : r.status === 'skipped' ? '⏭️' : r.status === 'degraded' ? '⚠️' : '❌'} ${r.status} | ${r.critical ? 'Yes' : 'No'} | ${r.details || '-'} |`,
    ),
    '',
  ];

  if (eipAddress || cloudfrontDomain || apiGatewayUrl) {
    summaryLines.push('### Endpoints Tested', '');
    if (eipAddress) summaryLines.push(`- EIP: \`http://${eipAddress}/\``);
    if (apiGatewayUrl) summaryLines.push(`- API: \`${apiGatewayUrl}\``);
    if (cloudfrontDomain) summaryLines.push(`- CloudFront: \`https://${cloudfrontDomain}/\``);
    summaryLines.push('');
  }

  writeSummary(summaryLines.join('\n'));

  // Console summary table
  logger.blank();
  logger.table(
    ['Component', 'Status', 'Critical', 'Details'],
    results.map((r) => [r.name, r.status, r.critical ? 'Yes' : '-', r.details || '-']),
  );

  // Final verdict
  if (criticalFailures.length > 0) {
    logger.error(
      `Smoke tests FAILED — ${criticalFailures.length} critical failure(s): ${criticalFailures.map((r) => r.name).join(', ')}`,
    );
    process.exit(1);
  }

  if (anyDegraded) {
    logger.warn('Smoke tests passed with warnings (some checks degraded)');
  } else {
    logger.success('All smoke tests passed');
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(`Fatal: ${message}`);
  process.exit(1);
});
