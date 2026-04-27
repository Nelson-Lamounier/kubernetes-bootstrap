// @format
// Steps 1–3b: Namespace, deploy key, repo secret, JWT signing key preservation.

import { kubectlApplyStdin, log, run, ssmGet } from '../helpers/runner.js';
import type { Config } from '../helpers/config.js';

// Step 1: Apply namespace.yaml from argocdDir
export const createNamespace = (cfg: Config): void => {
    log('=== Step 1: Creating argocd namespace ===');
    if (cfg.dryRun) {
        log('  [DRY-RUN] Would apply namespace.yaml\n');
        return;
    }
    run(['kubectl', 'apply', '-f', `${cfg.argocdDir}/namespace.yaml`], cfg);
    log('✓ argocd namespace ready\n');
};

// Step 2: Read SSH deploy key from SSM (or DEPLOY_KEY env override)
// Returns '' on dry-run or if key not found
export const resolveDeployKey = async (cfg: Config): Promise<string> => {
    log('=== Step 2: Resolving SSH Deploy Key from SSM ===');
    const envKey = process.env['DEPLOY_KEY'];
    if (envKey) {
        log('  ✓ Using environment override\n');
        return envKey;
    }
    const ssmPath = `${cfg.ssmPrefix}/deploy-key`;
    log(`  → Resolving from SSM: ${ssmPath}`);
    if (cfg.dryRun) {
        log('  [DRY-RUN] Would resolve deploy key from SSM\n');
        return '';
    }
    const key = await ssmGet(cfg, ssmPath, true);
    if (key) {
        log('  ✓ SSH Deploy Key resolved from SSM\n');
        return key;
    }
    log(`  ⚠ Deploy Key not found in SSM — store at: ${ssmPath}\n`);
    return '';
};

// Step 3: Create repo-cdk-monitoring secret via kubectlApplyStdin with stringData
// (stringData lets the API server handle base64 encoding — no manual encoding)
// Skip if no deployKey
export const createRepoSecret = (cfg: Config, deployKey: string): void => {
    log('=== Step 3: Creating repo credentials (SSH Deploy Key) ===');
    if (!deployKey) {
        log('  ⚠ Skipping — no Deploy Key available\n');
        return;
    }
    if (cfg.dryRun) {
        log('  [DRY-RUN] Would create repo-cdk-monitoring and repo-kubernetes-bootstrap secrets in argocd namespace\n');
        return;
    }
    // Indent each line of the private key for YAML block scalar
    const indentedKey = deployKey.trimEnd().split('\n').map(l => `    ${l}`).join('\n');

    const makeRepoSecret = (name: string, url: string): string => `apiVersion: v1
kind: Secret
metadata:
  name: ${name}
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repository
type: Opaque
stringData:
  type: git
  url: ${url}
  sshPrivateKey: |
${indentedKey}
`;

    // cdk-monitoring: legacy workloads ApplicationSet (if still referenced).
    kubectlApplyStdin(makeRepoSecret('repo-cdk-monitoring', 'git@github.com:Nelson-Lamounier/cdk-monitoring.git'), cfg);

    // kubernetes-bootstrap: hosts bootstrap scripts (sm-a/) AND, after the
    // 2026-04-27 migration from the now-archived kubernetes-platform repo,
    // hosts argocd-apps/ + charts/ as well. platform-root-app.yaml sources
    // from this repo. Without this secret ArgoCD cannot list refs and every
    // Application stays at sync status Unknown.
    kubectlApplyStdin(makeRepoSecret('repo-kubernetes-bootstrap', 'git@github.com:Nelson-Lamounier/kubernetes-bootstrap.git'), cfg);

    log('  ✓ SSH Deploy Key repo credentials applied (cdk-monitoring + kubernetes-bootstrap)\n');
};

// Step 3b: Preserve JWT signing key before ArgoCD re-install blanks argocd-secret
// Source 1: in-cluster kubectl get secret
// Source 2: SSM backup (DR — fresh cluster)
// Returns null on first install (no key exists anywhere)
export const preserveArgocdSecret = async (cfg: Config): Promise<string | null> => {
    log('=== Step 3b: Preserving ArgoCD JWT signing key ===');
    if (cfg.dryRun) {
        log('  [DRY-RUN] Would extract server.secretkey from argocd-secret\n');
        return null;
    }
    // Source 1: in-cluster
    const result = run(
        ['kubectl', 'get', 'secret', 'argocd-secret', '-n', 'argocd',
         '-o', 'jsonpath={.data.server\\.secretkey}'],
        cfg, { check: false, capture: true },
    );
    if (result.ok && result.stdout) {
        log('  ✓ JWT signing key preserved from in-cluster secret\n');
        return result.stdout;
    }
    // Source 2: SSM fallback (DR recovery — fresh cluster)
    log('  ℹ No in-cluster argocd-secret — attempting SSM fallback (DR recovery)');
    const ssmPath = `${cfg.ssmPrefix}/argocd/server-secret-key`;
    const key = await ssmGet(cfg, ssmPath, true);
    if (key) {
        log(`  ✓ JWT signing key recovered from SSM: ${ssmPath}`);
        log('    Existing CI bot tokens will remain valid after install\n');
        return key;
    }
    log(`  ℹ SSM fallback not available (${ssmPath}) — first install\n`);
    return null;
};
