"""Steps 4–4d: ArgoCD install, default project, server config, and health checks."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from helpers.config import Config
from helpers.runner import log, run


# ---------------------------------------------------------------------------
# Step 3b-restore: Restore ArgoCD signing key (after install.yaml)
# ---------------------------------------------------------------------------
def restore_argocd_secret(cfg: Config, signing_key: str | None) -> None:
    """Patch the preserved JWT signing key back into argocd-secret.

    Called immediately after install_argocd() to ensure the signing key
    is restored before any token validation occurs. This makes bootstrap
    re-runs non-disruptive to existing CI bot tokens.
    """
    log("=== Step 3b-restore: Restoring ArgoCD JWT signing key ===")

    if signing_key is None:
        log("  ℹ No signing key to restore — first install or dry-run\n")
        return

    if cfg.dry_run:
        log("  [DRY-RUN] Would patch server.secretkey into argocd-secret\n")
        return

    patch = json.dumps({"data": {"server.secretkey": signing_key}})
    result = subprocess.run(
        ["kubectl", "patch", "secret", "argocd-secret", "-n", "argocd",
         "--type", "merge", "-p", patch],
        env={**os.environ, "KUBECONFIG": cfg.kubeconfig},
        capture_output=True, text=True,
    )

    if result.returncode == 0:
        log("  ✓ JWT signing key restored — existing tokens remain valid")
        # Restart argocd-server so it picks up the restored key
        subprocess.run(
            ["kubectl", "rollout", "restart", "deployment/argocd-server", "-n", "argocd"],
            env={**os.environ, "KUBECONFIG": cfg.kubeconfig},
            check=False,
        )
        log("  ✓ argocd-server restarted to load restored key\n")
    else:
        log(f"  ⚠ Failed to restore signing key — {result.stderr}")
        log("    CI bot tokens will need to be regenerated: just argocd-ci-token\n")


# ---------------------------------------------------------------------------
# Step 4: Install ArgoCD (non-HA)
# ---------------------------------------------------------------------------
def install_argocd(cfg: Config) -> None:
    """Apply the vendored install.yaml with server-side apply."""
    log("=== Step 4: Installing ArgoCD ===")
    install_yaml = Path(cfg.argocd_dir) / "install.yaml"
    # --server-side: ArgoCD CRDs (applicationsets.argoproj.io) exceed the 262KB
    # annotation limit imposed by client-side kubectl apply. Server-side apply
    # avoids the last-applied-configuration annotation entirely.
    # --force-conflicts: Required on re-apply to take ownership of fields that
    # were previously managed by client-side apply.
    run(
        ["kubectl", "apply", "-n", "argocd", "-f", str(install_yaml),
         "--server-side", "--force-conflicts"],
        cfg=cfg,
    )
    log("✓ ArgoCD core installed\n")


# ---------------------------------------------------------------------------
# Step 4b: Create default AppProject (ArgoCD v3.x dropped auto-creation)
# ---------------------------------------------------------------------------
def create_default_project(cfg: Config) -> None:
    """Apply the default AppProject manifest."""
    log("=== Step 4b: Creating default AppProject ===")
    project_yaml = Path(cfg.argocd_dir) / "default-project.yaml"
    if project_yaml.exists():
        run(["kubectl", "apply", "-f", str(project_yaml)], cfg=cfg)
        log("✓ default AppProject created\n")
    else:
        log(f"  ⚠ default-project.yaml not found at {project_yaml}")
        log("  → Creating inline default AppProject...")
        run(
            ["kubectl", "apply", "-f", "-"],
            cfg=cfg,
        ) if cfg.dry_run else subprocess.run(
            ["kubectl", "apply", "-f", "-"],
            input=(
                'apiVersion: argoproj.io/v1alpha1\n'
                'kind: AppProject\n'
                'metadata:\n'
                '  name: default\n'
                '  namespace: argocd\n'
                'spec:\n'
                '  description: Default project for all applications\n'
                '  sourceRepos:\n'
                '    - "*"\n'
                '  destinations:\n'
                '    - namespace: "*"\n'
                '      server: https://kubernetes.default.svc\n'
                '  clusterResourceWhitelist:\n'
                '    - group: "*"\n'
                '      kind: "*"\n'
            ),
            env={**os.environ, "KUBECONFIG": cfg.kubeconfig},
            text=True, check=True,
        )
        log("✓ default AppProject created (inline)\n")


# ---------------------------------------------------------------------------
# Step 4c: Configure ArgoCD Server (rootpath + insecure)
# ---------------------------------------------------------------------------
def configure_argocd_server(cfg: Config) -> None:
    """Patch argocd-cmd-params-cm so ArgoCD works behind Traefik at /argocd.

    The vendored install.yaml ships an empty argocd-cmd-params-cm.
    Two keys are required for the Traefik IngressRoute to work:
      - server.rootpath=/argocd   — ArgoCD serves UI assets at /argocd/*
      - server.insecure=true      — disable TLS on argocd-server (Traefik terminates TLS)

    After patching the ConfigMap, the argocd-server deployment is restarted
    so its pods pick up the new configuration.
    """
    log("=== Step 4c: Configuring ArgoCD Server (rootpath + insecure) ===")

    if cfg.dry_run:
        log("  [DRY-RUN] Would patch argocd-cmd-params-cm and restart argocd-server\n")
        return

    patch = json.dumps({"data": {
        "server.rootpath": "/argocd",
        "server.insecure": "true",
    }})

    result = run(
        ["kubectl", "patch", "configmap", "argocd-cmd-params-cm",
         "-n", "argocd", "--type", "merge", "-p", patch],
        cfg=cfg, check=False,
    )

    if result.returncode == 0:
        log("  ✓ argocd-cmd-params-cm patched (rootpath=/argocd, insecure=true)")
    else:
        log("  ⚠ Failed to patch argocd-cmd-params-cm")

    # Restart argocd-server so pods pick up the new ConfigMap values
    result = run(
        ["kubectl", "rollout", "restart", "deployment/argocd-server",
         "-n", "argocd"],
        cfg=cfg, check=False,
    )

    if result.returncode == 0:
        log("  ✓ argocd-server deployment restarted")
    else:
        log("  ⚠ Failed to restart argocd-server")

    log("")


# ---------------------------------------------------------------------------
# Step 4d: Configure custom resource health checks in argocd-cm
# ---------------------------------------------------------------------------
def configure_health_checks(cfg: Config) -> None:
    """Patch argocd-cm with custom Lua health checks.

    ArgoCD's default Deployment health check considers a Deployment "Healthy"
    when at least one replica is available. This is too lenient — the monitoring
    Application (wave 3) could be marked Healthy while Tempo is still rolling out.

    Custom health checks ensure:
      - Deployments: ALL replicas must be available AND the rollout must be
        complete (NewReplicaSetAvailable).
      - ConfigMaps: Always Healthy (prevents ArgoCD from blocking sync-waves
        on ConfigMap-only changes like Tempo/Grafana config updates).
    """
    log("=== Step 4d: Configuring custom resource health checks ===")

    if cfg.dry_run:
        log("  [DRY-RUN] Would patch argocd-cm with custom health checks\n")
        return

    # Lua health check: Deployment is Healthy only when ALL replicas are available
    # and the rollout is complete (Progressing condition = NewReplicaSetAvailable)
    deployment_health_lua = """\
hs = {}
if obj.status ~= nil then
  if obj.status.availableReplicas ~= nil and obj.spec.replicas ~= nil then
    if obj.status.availableReplicas == obj.spec.replicas then
      -- All replicas available, check rollout completion
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
return hs"""

    # ConfigMap: always Healthy (no runtime state to check)
    configmap_health_lua = """\
hs = {}
hs.status = "Healthy"
hs.message = ""
return hs"""

    # Argo Rollouts Rollout: map phase/status to ArgoCD health
    rollout_health_lua = """\
hs = {}
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
return hs"""

    patch = json.dumps({"data": {
        "resource.customizations.health.apps_Deployment": deployment_health_lua,
        "resource.customizations.health._ConfigMap": configmap_health_lua,
        "resource.customizations.health.argoproj.io_Rollout": rollout_health_lua,
        "timeout.session": "24h",
    }})

    result = run(
        ["kubectl", "patch", "configmap", "argocd-cm", "-n", "argocd",
         "--type", "merge", "-p", patch],
        cfg=cfg, check=False,
    )

    if result.returncode == 0:
        log("  ✓ Custom health checks added to argocd-cm:")
        log("    - apps/Deployment: requires ALL replicas available + rollout complete")
        log("    - ConfigMap: always Healthy (prevents sync-wave blocking)")
        log("    - argoproj.io/Rollout: maps phase to ArgoCD health status")
    else:
        log("  ⚠ Failed to patch argocd-cm with health checks")

    log("")
