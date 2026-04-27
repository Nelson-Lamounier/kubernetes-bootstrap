// @format
// Steps 5–5e: App-of-Apps roots, monitoring Helm params, Prometheus auth, ECR creds, Crossplane, TLS, cert-manager, notifications.

import type { Config } from '../helpers/config.js';
import {
    kubectlApplyStdin,
    log,
    run,
    sleep,
    ssmGet,
    secretsManagerGet,
} from '../helpers/runner.js';
import { restoreCert } from '../helpers/tls-cert.js';

// ─── Step 5 ──────────────────────────────────────────────────────────────────

export const applyRootApp = (cfg: Config): void => {
    log('=== Step 5: Applying App-of-Apps root (platform-root) ===');
    const name = 'platform-root-app.yaml';
    log(`  → Applying ${name}`);
    const result = run(['kubectl', 'apply', '-f', `${cfg.argocdDir}/${name}`], cfg, { check: false });
    log(result.ok ? `  ✓ ${name} applied` : `  ⚠ Failed to apply ${name}: ${result.stderr}`);
    log('✓ App-of-Apps root applied\n');
};

// ─── Step 5b ─────────────────────────────────────────────────────────────────

export const injectMonitoringHelmParams = async (cfg: Config): Promise<void> => {
    log('=== Step 5b: Injecting Monitoring Helm Parameters ===');

    const parameters: Array<{ name: string; value: string }> = [];

    if (!cfg.dryRun) {
        // SNS topic: try pool path first, then fallback
        const topicPool = await ssmGet(cfg, `${cfg.ssmPrefix}/monitoring/alerts-topic-arn-pool`);
        const topicFallback = topicPool ?? await ssmGet(cfg, `${cfg.ssmPrefix}/monitoring/alerts-topic-arn`);
        if (topicFallback) {
            log(`  ✓ SNS topic ARN found: ${topicFallback}`);
            parameters.push({ name: 'grafana.alerting.snsTopicArn', value: topicFallback });
        } else {
            log('  ⚠ SNS topic ARN not found in SSM (tried pool + fallback paths)');
        }

        const ipv4 = await ssmGet(cfg, `${cfg.ssmPrefix}/monitoring/allow-ipv4`);
        if (ipv4) {
            log(`  ✓ IPv4 allow found: ${ipv4}`);
            parameters.push({ name: 'adminAccess.allowedIps[0]', value: ipv4 });
        } else {
            log('  ⚠ IPv4 allow not found in SSM');
        }

        const ipv6 = await ssmGet(cfg, `${cfg.ssmPrefix}/monitoring/allow-ipv6`);
        if (ipv6) {
            log(`  ✓ IPv6 allow found: ${ipv6}`);
            parameters.push({ name: 'adminAccess.allowedIps[1]', value: ipv6 });
        } else {
            log('  ⚠ IPv6 allow not found in SSM');
        }
    }

    if (cfg.dryRun) {
        log('  [DRY-RUN] Would inject Helm parameters into monitoring Application');
        return;
    }

    if (parameters.length === 0) {
        log('  ⚠ No Helm parameters to inject — skipping patch');
        return;
    }

    // Wait up to 120s for monitoring Application to exist
    let found = false;
    for (let attempt = 1; attempt <= 24; attempt++) {
        const result = run(
            ['kubectl', 'get', 'application', 'monitoring', '-n', 'argocd'],
            cfg,
            { check: false, capture: true },
        );
        if (result.ok) {
            log(`  ✓ monitoring Application exists (attempt ${attempt}/24)`);
            found = true;
            break;
        }
        if (attempt % 6 === 0) {
            log(`  … waiting for monitoring Application (attempt ${attempt}/24)`);
        }
        if (attempt < 24) await sleep(5000);
    }

    if (!found) {
        log('  ⚠ monitoring Application not found after 120s — skipping Helm param injection (non-fatal)');
        return;
    }

    const patch = JSON.stringify({ spec: { source: { helm: { parameters } } } });
    const patchResult = run(
        ['kubectl', 'patch', 'application', 'monitoring', '-n', 'argocd', '--type', 'merge', '-p', patch],
        cfg,
        { check: false },
    );
    if (patchResult.ok) {
        log(`  ✓ monitoring Application patched with ${parameters.length} Helm parameter(s)`);
    } else {
        log(`  ⚠ Failed to patch monitoring Application: ${patchResult.stderr}`);
    }
};

// ─── Step 5b-auth ────────────────────────────────────────────────────────────

export const seedPrometheusBasicAuth = async (cfg: Config): Promise<void> => {
    log('=== Step 5b-auth: Seeding Prometheus Basic Auth Secret ===');

    const ssmPath = `${cfg.ssmPrefix}/monitoring/prometheus-basic-auth`;

    if (cfg.dryRun) {
        log(`  [DRY-RUN] Would read ${ssmPath} and apply prometheus-basic-auth-secret`);
        return;
    }

    const htpasswdLine = await ssmGet(cfg, ssmPath, true);
    if (!htpasswdLine || !htpasswdLine.includes(':')) {
        log(`  ⚠ prometheus-basic-auth not found or invalid — store htpasswd line at: ${ssmPath}`);
        log(`    aws ssm put-parameter --name "${ssmPath}" --value "user:hash" --type SecureString`);
        return;
    }
    log('  ✓ htpasswd entry retrieved from SSM');

    const indented = htpasswdLine.trimEnd().split('\n').map(l => `    ${l}`).join('\n');
    const yaml = `apiVersion: v1
kind: Secret
metadata:
  name: prometheus-basic-auth-secret
  namespace: monitoring
  labels:
    app.kubernetes.io/managed-by: bootstrap
    app.kubernetes.io/part-of: monitoring
type: Opaque
stringData:
  users: |
${indented}
`;
    const result = kubectlApplyStdin(yaml, cfg, { check: false });
    if (result.ok) {
        log('  ✓ prometheus-basic-auth-secret applied in monitoring namespace');
    } else {
        log(`  ⚠ Failed to apply prometheus-basic-auth-secret: ${result.stderr}`);
    }
};

// ─── Step 5c ─────────────────────────────────────────────────────────────────

export const seedEcrCredentials = (cfg: Config): void => {
    log('=== Step 5c: Seeding ECR Credentials (Day-1) ===');

    const ecrRegistry = `771826808455.dkr.ecr.${cfg.awsRegion}.amazonaws.com`;

    if (cfg.dryRun) {
        log(`  [DRY-RUN] Would seed ECR credentials for registry: ${ecrRegistry}`);
        return;
    }

    const tokenResult = run(
        ['aws', 'ecr', 'get-login-password', '--region', cfg.awsRegion],
        cfg,
        { check: false, capture: true },
    );
    if (!tokenResult.ok || !tokenResult.stdout) {
        log(`  ⚠ Failed to fetch ECR login token — skipping ECR credential seed`);
        return;
    }

    const ecrToken = tokenResult.stdout;
    log('  ✓ ECR authorization token obtained');
    const authStr = Buffer.from(`AWS:${ecrToken}`).toString('base64');
    const dockerConfig = JSON.stringify({ auths: { [ecrRegistry]: { auth: authStr } } });
    const configB64 = Buffer.from(dockerConfig).toString('base64');

    const yaml = `apiVersion: v1
kind: Secret
metadata:
  name: ecr-credentials
  namespace: argocd
  labels:
    app.kubernetes.io/managed-by: ecr-token-refresh
    app.kubernetes.io/part-of: argocd
type: kubernetes.io/dockerconfigjson
data:
  .dockerconfigjson: ${configB64}
`;
    const result = kubectlApplyStdin(yaml, cfg, { check: false });
    if (result.ok) {
        log(`  ✓ ECR credentials seeded for registry: ${ecrRegistry}`);
    } else {
        log(`  ⚠ Failed to apply ECR credentials secret: ${result.stderr}`);
    }
};

// ─── Step 5c-cp ──────────────────────────────────────────────────────────────

export const provisionCrossplaneCredentials = async (cfg: Config): Promise<void> => {
    log('=== Step 5c-cp: Provisioning Crossplane AWS Credentials ===');

    const secretName = `shared-${cfg.env.slice(0, 3)}/crossplane/aws-credentials`;

    if (cfg.dryRun) {
        log(`  [DRY-RUN] Would read Secrets Manager secret: ${secretName}`);
        return;
    }

    const secretStr = await secretsManagerGet(cfg, secretName);
    if (secretStr === null) {
        log(`  ⚠ Crossplane credentials not found in Secrets Manager: ${secretName}`);
        return;
    }
    log(`  ✓ Retrieved credentials from Secrets Manager (${secretName})`);

    let creds: Record<string, string>;
    try {
        creds = JSON.parse(secretStr) as Record<string, string>;
    } catch {
        log(`  ⚠ Crossplane secret is not valid JSON — check format of: ${secretName}`);
        return;
    }
    const keyId = creds['aws_access_key_id'];
    const secretKey = creds['aws_secret_access_key'];

    if (!keyId || !secretKey) {
        log('  ⚠ Missing aws_access_key_id or aws_secret_access_key in secret JSON');
        return;
    }

    // Ensure crossplane-system namespace exists
    const nsYaml = `apiVersion: v1
kind: Namespace
metadata:
  name: crossplane-system
`;
    kubectlApplyStdin(nsYaml, cfg, { check: false });

    const credsIni = `[default]\naws_access_key_id = ${keyId}\naws_secret_access_key = ${secretKey}\n`;
    const credsB64 = Buffer.from(credsIni).toString('base64');

    const secretYaml = `apiVersion: v1
kind: Secret
metadata:
  name: crossplane-aws-creds
  namespace: crossplane-system
  labels:
    app.kubernetes.io/managed-by: bootstrap
    app.kubernetes.io/part-of: crossplane
    platform.engineering/component: infrastructure-abstraction
type: Opaque
data:
  credentials: ${credsB64}
`;
    const result = kubectlApplyStdin(secretYaml, cfg, { check: false });
    if (result.ok) {
        log('  ✓ Crossplane AWS credentials provisioned in crossplane-system');
    } else {
        log(`  ⚠ Failed to apply crossplane-aws-creds: ${result.stderr}`);
    }
};

// ─── Step 5c-arc ─────────────────────────────────────────────────────────────
// Materialise the ARC controller's GitHub App credentials from Secrets Manager
// into the in-cluster Secret the gha-runner-scale-set chart expects.
//
// Without this Secret the controller cannot:
//   1. Initialise the GitHub Actions service client
//   2. Register the runner scale set with GitHub
//   3. Spawn the listener pod that translates workflow_job events into
//      ephemeral runner pods
//
// Result: every workflow with `runs-on: k8s-runner` queues forever and never
// runs (which is what bit us on 2026-04-27 — the manual prerequisite was
// never automated).
//
// Source secret JSON shape (in AWS Secrets Manager):
//   {
//     "github_app_id":              "<app id>",
//     "github_app_installation_id": "<installation id>",
//     "github_app_private_key":     "<PEM-encoded private key>"
//   }
//
// The K8s Secret keys mirror those JSON fields exactly — that is the layout
// required by the gha-runner-scale-set chart (githubConfigSecret prop).

export const provisionArcGithubSecret = async (cfg: Config): Promise<void> => {
    log('=== Step 5c-arc: Provisioning ARC GitHub App credentials ===');

    const secretName = `k8s/${cfg.env}/arc-github-app`;

    if (cfg.dryRun) {
        log(`  [DRY-RUN] Would read Secrets Manager secret: ${secretName}`);
        return;
    }

    const secretStr = await secretsManagerGet(cfg, secretName);
    if (secretStr === null) {
        log(`  ⚠ ARC GitHub App credentials not found in Secrets Manager: ${secretName}`);
        log('     ARC controller will continue retrying — workflows with runs-on: k8s-runner will queue.');
        return;
    }
    log(`  ✓ Retrieved credentials from Secrets Manager (${secretName})`);

    let creds: Record<string, string>;
    try {
        creds = JSON.parse(secretStr) as Record<string, string>;
    } catch {
        log(`  ⚠ ARC secret is not valid JSON — check format of: ${secretName}`);
        return;
    }
    const appId          = creds['github_app_id'];
    const installationId = creds['github_app_installation_id'];
    const privateKey     = creds['github_app_private_key'];

    if (!appId || !installationId || !privateKey) {
        log('  ⚠ Missing one of: github_app_id, github_app_installation_id, github_app_private_key');
        return;
    }

    // Ensure arc-runners namespace exists. The chart sets CreateNamespace=true
    // but ArgoCD's RBAC reconcile runs before the namespace exists on a fresh
    // cluster, so we create it imperatively here. Idempotent.
    const nsYaml = `apiVersion: v1
kind: Namespace
metadata:
  name: arc-runners
`;
    kubectlApplyStdin(nsYaml, cfg, { check: false });

    // Base64-encode each field once. Using `data:` (not `stringData:`) keeps
    // the multi-line PEM intact without YAML block-scalar indentation issues.
    const b64 = (s: string): string => Buffer.from(s).toString('base64');

    const secretYaml = `apiVersion: v1
kind: Secret
metadata:
  name: arc-github-secret
  namespace: arc-runners
  labels:
    app.kubernetes.io/managed-by: bootstrap
    app.kubernetes.io/part-of: arc
type: Opaque
data:
  github_app_id: ${b64(appId)}
  github_app_installation_id: ${b64(installationId)}
  github_app_private_key: ${b64(privateKey)}
`;
    const result = kubectlApplyStdin(secretYaml, cfg, { check: false });
    if (result.ok) {
        log('  ✓ arc-github-secret provisioned in arc-runners');
    } else {
        log(`  ⚠ Failed to apply arc-github-secret: ${result.stderr}`);
    }
};

// ─── Step 5d-pre ─────────────────────────────────────────────────────────────

export const restoreTlsCert = async (cfg: Config): Promise<void> => {
    log('=== Step 5d-pre: Restoring TLS certificate + ACME key from SSM ===');
    for (const [secret, ns] of [['ops-tls-cert', 'kube-system'], ['letsencrypt-account-key', 'cert-manager']] as const) {
        await restoreCert(cfg, secret, ns);
    }
};

// ─── Step 5d ─────────────────────────────────────────────────────────────────

export const applyCertManagerIssuer = async (cfg: Config): Promise<void> => {
    log('=== Step 5d: Applying cert-manager ClusterIssuer (DNS-01) ===');

    if (cfg.dryRun) {
        log('  [DRY-RUN] Would apply letsencrypt ClusterIssuer with DNS-01/Route53');
        return;
    }

    // Read SSM params in parallel
    const [publicHzId, dnsRoleArn] = await Promise.all([
        ssmGet(cfg, `${cfg.ssmPrefix}/public-hosted-zone-id`),
        ssmGet(cfg, `${cfg.ssmPrefix}/cross-account-dns-role-arn`),
    ]);

    if (!publicHzId) {
        log(`  ⚠ Missing SSM param: ${cfg.ssmPrefix}/public-hosted-zone-id`);
    }
    if (!dnsRoleArn) {
        log(`  ⚠ Missing SSM param: ${cfg.ssmPrefix}/cross-account-dns-role-arn`);
    }
    if (!publicHzId || !dnsRoleArn) {
        throw new Error('Missing DNS-01 SSM params: public-hosted-zone-id or cross-account-dns-role-arn');
    }

    // Check ArgoCD pods are running
    const podsResult = run(
        ['kubectl', 'get', 'pods', '-n', 'argocd', '--field-selector=status.phase=Running', '-o', 'name'],
        cfg,
        { check: false, capture: true },
    );
    if (!podsResult.ok || !podsResult.stdout) {
        throw new Error('No ArgoCD pods running — cert-manager issuer apply deferred');
    }

    // Wait for CRD clusterissuers.cert-manager.io (up to 60s)
    let crdFound = false;
    for (let attempt = 1; attempt <= 12; attempt++) {
        const crdResult = run(
            ['kubectl', 'get', 'crd', 'clusterissuers.cert-manager.io'],
            cfg,
            { check: false, capture: true },
        );
        if (crdResult.ok) {
            log(`  ✓ CRD ready (attempt ${attempt}/12)`);
            crdFound = true;
            break;
        }
        log(`  … waiting for clusterissuers.cert-manager.io CRD (attempt ${attempt}/12)`);
        if (attempt < 12) await sleep(5000);
    }

    if (!crdFound) {
        throw new Error('CRD clusterissuers.cert-manager.io not found after 60s — cert-manager not ready');
    }

    const issuerYaml = `apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt
  annotations:
    kubernetes.io/description: "Let's Encrypt production issuer via DNS-01 challenge (Route 53)"
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: lamounierleao2025@outlook.com
    privateKeySecretRef:
      name: letsencrypt-account-key
    solvers:
      - dns01:
          route53:
            region: ${cfg.awsRegion}
            hostedZoneID: ${publicHzId}
            role: ${dnsRoleArn}
`;
    const issuerResult = kubectlApplyStdin(issuerYaml, cfg, { check: false });
    if (issuerResult.ok) {
        log('  ✓ letsencrypt ClusterIssuer applied');
    } else {
        log(`  ⚠ Failed to apply letsencrypt ClusterIssuer: ${issuerResult.stderr}`);
    }

    // Remove ArgoCD tracking annotation to prevent ArgoCD from overwriting
    run(
        ['kubectl', 'annotate', 'clusterissuer', 'letsencrypt', 'argocd.argoproj.io/tracking-id-', '--overwrite'],
        cfg,
        { check: false },
    );

    // Check if ops-tls-cert secret already exists in kube-system
    const tlsCheck = run(
        ['kubectl', 'get', 'secret', 'ops-tls-cert', '-n', 'kube-system'],
        cfg,
        { check: false, capture: true },
    );

    if (tlsCheck.ok) {
        log('  ✓ ops-tls-cert exists — annotating with cert-manager ownership');
        run(
            [
                'kubectl', 'annotate', 'secret', 'ops-tls-cert', '-n', 'kube-system',
                'cert-manager.io/issuer-name=letsencrypt',
                'cert-manager.io/issuer-kind=ClusterIssuer',
                'cert-manager.io/issuer-group=cert-manager.io',
                '--overwrite',
            ],
            cfg,
            { check: false },
        );
        return;
    }

    // TLS secret missing — clean up stale ACME resources
    log('  ℹ ops-tls-cert not found — cleaning up stale challenge/order/certificaterequest resources');
    for (const kind of ['challenge', 'order', 'certificaterequest'] as const) {
        const listResult = run(
            ['kubectl', 'get', kind, '-n', 'kube-system', '-o', 'name'],
            cfg,
            { check: false, capture: true },
        );
        if (!listResult.ok || !listResult.stdout) {
            continue;
        }
        for (const resource of listResult.stdout.split('\n').filter(Boolean)) {
            const resourceName = resource.split('/')[1];
            if (!resourceName) continue;
            // Patch out finalizers
            run(
                ['kubectl', 'patch', kind, resourceName, '-n', 'kube-system', '--type', 'merge', '-p', '{"metadata":{"finalizers":[]}}'],
                cfg,
                { check: false },
            );
            // Delete
            run(
                ['kubectl', 'delete', kind, resourceName, '-n', 'kube-system', '--ignore-not-found'],
                cfg,
                { check: false },
            );
        }
        log(`  ✓ Cleaned up stale ${kind} resources in kube-system`);
    }
};

// ─── Step 5e ─────────────────────────────────────────────────────────────────

export const provisionArgocdNotificationsSecret = async (cfg: Config): Promise<void> => {
    log('=== Step 5e: Provisioning ArgoCD Notifications Secret ===');

    const ssmMap: Array<[string, string]> = [
        ['github-appID',          `${cfg.ssmPrefix}/argocd/github-app-id`],
        ['github-installationID', `${cfg.ssmPrefix}/argocd/github-installation-id`],
        ['github-privateKey',     `${cfg.ssmPrefix}/argocd/github-private-key`],
    ];

    if (cfg.dryRun) {
        for (const [key, path] of ssmMap) {
            log(`  [DRY-RUN] Would read ${path} → secret key '${key}'`);
        }
        return;
    }

    const secretData: Array<[string, string]> = [];
    const missing: string[] = [];

    for (const [key, path] of ssmMap) {
        const value = await ssmGet(cfg, path, true);
        if (value !== null) {
            secretData.push([key, value]);
            log(`  ✓ Retrieved '${key}'`);
        } else {
            log(`  ⚠ SSM parameter not found (${path})`);
            missing.push(path);
        }
    }

    if (missing.length > 0) {
        log(`  ⚠ ${missing.length} SSM parameter(s) missing — ArgoCD Notifications will not post GitHub statuses`);
        for (const path of missing) {
            log(`      aws ssm put-parameter --name '${path}' --type SecureString --value '<value>'`);
        }
        return;
    }

    const stringDataEntries = secretData
        .map(([k, v]) => `  ${k}: |\n    ${v.trimEnd().replace(/\n/g, '\n    ')}`)
        .join('\n');

    const yaml = `apiVersion: v1
kind: Secret
metadata:
  name: argocd-notifications-secret
  namespace: argocd
  labels:
    app.kubernetes.io/managed-by: bootstrap
    app.kubernetes.io/part-of: argocd
type: Opaque
stringData:
${stringDataEntries}
`;
    const result = kubectlApplyStdin(yaml, cfg, { check: false });
    if (result.ok) {
        log('  ✓ argocd-notifications-secret applied');
        log('  ℹ Hint: restart notifications-controller to pick up new credentials:');
        log('    kubectl rollout restart deployment/argocd-notifications-controller -n argocd');
    } else {
        log(`  ⚠ Failed to apply argocd-notifications-secret: ${result.stderr}`);
    }
};
