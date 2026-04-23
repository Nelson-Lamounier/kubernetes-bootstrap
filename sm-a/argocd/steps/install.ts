// @format
import { existsSync } from 'node:fs';
import type { Config } from '../helpers/config.js';
import { kubectlApplyStdin, log, run } from '../helpers/runner.js';

const ARGOCD_SERVER = 'deployment/argocd-server';

export const restoreArgocdSecret = (cfg: Config, signingKey: string | null): void => {
    log('=== Step 3b-restore: Restoring ArgoCD JWT signing key ===');
    if (signingKey === null) {
        log('No signing key to restore — first install or dry-run');
        return;
    }
    if (cfg.dryRun) {
        log('  [DRY-RUN] restoreArgocdSecret');
        return;
    }

    const patch = JSON.stringify({ data: { 'server.secretkey': signingKey } });
    const patchResult = run(
        ['kubectl', 'patch', 'secret', 'argocd-secret', '-n', 'argocd', '--type', 'merge', '-p', patch],
        cfg,
        { check: false },
    );
    if (!patchResult.ok) {
        log(`  WARN: Failed to patch argocd-secret: ${patchResult.stderr}`);
        log('  WARN: CI bot tokens will be invalidated — users must re-login');
        return;
    }

    const verifyResult = run(
        ['kubectl', 'get', 'secret', 'argocd-secret', '-n', 'argocd', '-o', 'jsonpath={.data.server\\.secretkey}'],
        cfg,
        { check: false, capture: true },
    );
    if (!verifyResult.ok || verifyResult.stdout !== signingKey) {
        const actual = verifyResult.ok ? verifyResult.stdout.slice(0, 20) : '(read failed)';
        log(`  ✗ Post-patch verification FAILED — got: ${actual}...\n`);
        return;
    }

    run(['kubectl', 'rollout', 'restart', ARGOCD_SERVER, '-n', 'argocd'], cfg, { check: false });

    const rolloutResult = run(
        ['kubectl', 'rollout', 'status', ARGOCD_SERVER, '-n', 'argocd', `--timeout=${cfg.argoTimeout}s`],
        cfg,
        { check: false },
    );
    if (rolloutResult.ok) {
        log('  ✓ argocd-server restarted with restored signing key');
    } else {
        log('  WARN: argocd-server rollout timed out after signing key restore');
    }
};

export const installArgocd = (cfg: Config): void => {
    log('=== Step 4: Installing ArgoCD ===');
    run(
        [
            'kubectl', 'apply', '-n', 'argocd',
            '-f', `${cfg.argocdDir}/install.yaml`,
            '--server-side',
            '--force-conflicts',
        ],
        cfg,
    );
    log('✓ ArgoCD core installed');
};

export const createDefaultProject = async (cfg: Config): Promise<void> => {
    log('=== Step 4b: Creating default AppProject ===');
    const projectFile = `${cfg.argocdDir}/default-project.yaml`;
    if (existsSync(projectFile)) {
        run(['kubectl', 'apply', '-f', projectFile], cfg);
        log('✓ default AppProject created\n');
        return;
    }

    const yaml = `apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: default
  namespace: argocd
spec:
  description: Default project for all applications
  sourceRepos:
    - "*"
  destinations:
    - namespace: "*"
      server: https://kubernetes.default.svc
  clusterResourceWhitelist:
    - group: "*"
      kind: "*"
`;
    kubectlApplyStdin(yaml, cfg);
    log('✓ default AppProject created (inline)\n');
};

export const configureArgocdServer = (cfg: Config): void => {
    log('=== Step 4c: Configuring ArgoCD Server (rootpath + insecure) ===');
    if (cfg.dryRun) {
        log('  [DRY-RUN] configureArgocdServer');
        return;
    }

    const patch = JSON.stringify({ data: { 'server.rootpath': '/argocd', 'server.insecure': 'true' } });
    const patchResult = run(
        ['kubectl', 'patch', 'configmap', 'argocd-cmd-params-cm', '-n', 'argocd', '--type', 'merge', '-p', patch],
        cfg,
        { check: false },
    );
    if (!patchResult.ok) {
        log(`  WARN: Failed to patch argocd-cmd-params-cm: ${patchResult.stderr}`);
        log('  WARN: Skipping restart — config patch failed, server left unchanged');
        return;
    }
    log('  ✓ argocd-cmd-params-cm patched (rootpath=/argocd, insecure=true)');
    const restartResult = run(
        ['kubectl', 'rollout', 'restart', ARGOCD_SERVER, '-n', 'argocd'],
        cfg,
        { check: false },
    );
    log(restartResult.ok ? '  ✓ argocd-server restart triggered' : `  WARN: Failed to restart argocd-server: ${restartResult.stderr}`);
    log('');
};

export const configureHealthChecks = (cfg: Config): void => {
    log('=== Step 4d: Configuring custom resource health checks ===');
    if (cfg.dryRun) {
        log('  [DRY-RUN] configureHealthChecks');
        return;
    }

    const deploymentLua = `hs = {}
if obj.status ~= nil then
  if obj.status.availableReplicas ~= nil and obj.spec.replicas ~= nil then
    if obj.status.availableReplicas == obj.spec.replicas then
      if obj.status.conditions ~= nil then
        for _, condition in ipairs(obj.status.conditions) do
          if condition.type == "Progressing" and condition.reason == "NewReplicaSetAvailable" then
            hs.status = "Healthy"
            hs.message = "All replicas available and rollout complete"
            return hs
          end
        end
      end
      hs.status = "Progressing"
      hs.message = "Waiting for rollout to complete"
      return hs
    end
  end
  hs.status = "Progressing"
  hs.message = "Waiting for all replicas to be available"
  return hs
end
hs.status = "Progressing"
hs.message = "Waiting for status"
return hs
`;

    const configMapLua = `hs = {}
hs.status = "Healthy"
hs.message = ""
return hs
`;

    const rolloutLua = `hs = {}
if obj.status ~= nil then
  if obj.status.phase == "Healthy" then
    hs.status = "Healthy"
    hs.message = "Rollout is fully promoted"
    return hs
  end
  if obj.status.phase == "Paused" then
    hs.status = "Suspended"
    hs.message = obj.status.message or "Rollout is paused"
    return hs
  end
  if obj.status.phase == "Degraded" or obj.status.phase == "Abort" then
    hs.status = "Degraded"
    hs.message = obj.status.message or "Rollout failed"
    return hs
  end
  hs.status = "Progressing"
  hs.message = obj.status.message or "Rollout in progress"
  return hs
end
hs.status = "Progressing"
hs.message = "Waiting for rollout status"
return hs
`;

    const patch = JSON.stringify({
        data: {
            'resource.customizations.health.apps_Deployment': deploymentLua,
            'resource.customizations.health._ConfigMap': configMapLua,
            'resource.customizations.health.argoproj.io_Rollout': rolloutLua,
            'timeout.session': '24h',
        },
    });

    const result = run(
        ['kubectl', 'patch', 'configmap', 'argocd-cm', '-n', 'argocd', '--type', 'merge', '-p', patch],
        cfg,
        { check: false },
    );
    if (result.ok) {
        log('  ✓ Health checks added: apps/Deployment, ConfigMap, argoproj.io/Rollout');
    } else {
        log(`  WARN: Failed to patch argocd-cm with health checks: ${result.stderr}`);
    }
};
