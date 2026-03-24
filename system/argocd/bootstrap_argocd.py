#!/usr/bin/env python3
"""bootstrap_argocd.py — Bootstrap ArgoCD on Kubernetes.

Installs ArgoCD and configures it to watch the private GitHub repo.
Run once during first boot (via user-data → Python orchestrator) after kubeadm
cluster is ready.

Converted from bootstrap-argocd.sh (294-line Bash) to Python for:
  - Typed config (dataclass) instead of unvalidated env vars
  - boto3 for SSM / Secrets Manager (proper error handling)
  - kubernetes client for secret upsert (idempotent, base64-safe)
  - --dry-run mode for local development

Steps:
  1.  Create argocd namespace
  2.  Resolve SSH deploy key from SSM
  3.  Create repo credentials secret
  4.  Install ArgoCD (kubectl apply)
  4b. Create default AppProject (required in ArgoCD v3.x)
  4c. Configure ArgoCD server (rootpath + insecure for Traefik)
  5.  Apply App-of-Apps root application
  5c. Seed ECR credentials (Day-1 — CronJob hasn't fired yet)
  6.  Wait for ArgoCD server readiness
  7.  Apply ArgoCD ingress (needs Traefik CRDs from ArgoCD sync)
  8.  Install ArgoCD CLI
  9.  Create CI bot account
  10. Generate API token → Secrets Manager
  11. Summary
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
@dataclass
class Config:
    ssm_prefix: str = field(default_factory=lambda: os.environ.get("SSM_PREFIX", "/k8s/development"))
    aws_region: str = field(default_factory=lambda: os.environ.get("AWS_REGION", "eu-west-1"))
    kubeconfig: str = field(default_factory=lambda: os.environ.get("KUBECONFIG", "/etc/kubernetes/admin.conf"))
    argocd_dir: str = field(default_factory=lambda: os.environ.get(
        "ARGOCD_DIR", "/data/k8s-bootstrap/system/argocd"
    ))
    argocd_cli_version: str = field(default_factory=lambda: os.environ.get("ARGOCD_CLI_VERSION", "v2.14.11"))
    argo_timeout: int = field(default_factory=lambda: int(os.environ.get("ARGO_TIMEOUT", "120")))
    dry_run: bool = False

    @property
    def env(self) -> str:
        """Extract environment from SSM prefix: /k8s/development → development."""
        return self.ssm_prefix.rstrip("/").split("/")[-1]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def log(msg: str) -> None:
    print(msg, flush=True)


def run(cmd: list[str], *, cfg: Config, check: bool = True, capture: bool = False) -> subprocess.CompletedProcess:
    """Run a subprocess with KUBECONFIG set.

    HOME is set as a fallback for SSM Automation sessions where $HOME
    is undefined — the ArgoCD CLI crashes with "$HOME is not defined"
    without it (affects token generation in Step 10).
    """
    env = {**os.environ, "KUBECONFIG": cfg.kubeconfig, "HOME": os.environ.get("HOME", "/root")}
    if cfg.dry_run:
        log(f"  [DRY-RUN] {' '.join(cmd)}")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
    return subprocess.run(cmd, env=env, check=check, capture_output=capture, text=True)


def get_ssm_client(cfg: Config):
    import boto3
    return boto3.client("ssm", region_name=cfg.aws_region)


def get_secrets_client(cfg: Config):
    import boto3
    return boto3.client("secretsmanager", region_name=cfg.aws_region)


# ---------------------------------------------------------------------------
# Step 1: Create argocd namespace
# ---------------------------------------------------------------------------
def create_namespace(cfg: Config) -> None:
    log("=== Step 1: Creating argocd namespace ===")
    namespace_yaml = Path(cfg.argocd_dir) / "namespace.yaml"
    run(["kubectl", "apply", "-f", str(namespace_yaml)], cfg=cfg)
    log("✓ argocd namespace ready\n")


# ---------------------------------------------------------------------------
# Step 2: Resolve SSH Deploy Key from SSM
# ---------------------------------------------------------------------------
def resolve_deploy_key(cfg: Config) -> str:
    log("=== Step 2: Resolving SSH Deploy Key from SSM ===")

    # Allow env override for testing
    deploy_key = os.environ.get("DEPLOY_KEY", "")
    if deploy_key:
        log("  ✓ Using environment override\n")
        return deploy_key

    ssm_path = f"{cfg.ssm_prefix}/deploy-key"
    log(f"  → Resolving from SSM: {ssm_path}")

    if cfg.dry_run:
        log("  [DRY-RUN] Would resolve deploy key from SSM\n")
        return ""

    try:
        ssm = get_ssm_client(cfg)
        resp = ssm.get_parameter(Name=ssm_path, WithDecryption=True)
        log("  ✓ SSH Deploy Key resolved from SSM\n")
        return resp["Parameter"]["Value"]
    except Exception as e:
        log(f"  ⚠ Deploy Key not found in SSM — {e}")
        log(f"  ⚠ Store Deploy Key at: {ssm_path}\n")
        return ""


# ---------------------------------------------------------------------------
# Step 3: Create repo credentials secret (SSH Deploy Key)
# ---------------------------------------------------------------------------
def create_repo_secret(cfg: Config, deploy_key: str) -> None:
    log("=== Step 3: Creating repo credentials (SSH Deploy Key) ===")

    if not deploy_key:
        log("  ⚠ Skipping — no Deploy Key available\n")
        return

    if cfg.dry_run:
        log("  [DRY-RUN] Would create repo-cdk-monitoring secret in argocd namespace\n")
        return

    try:
        from kubernetes import client, config as k8s_config

        k8s_config.load_kube_config(config_file=cfg.kubeconfig)
        v1 = client.CoreV1Api()

        secret_data = {
            "type": base64.b64encode(b"git").decode(),
            "url": base64.b64encode(b"git@github.com:Nelson-Lamounier/cdk-monitoring.git").decode(),
            "sshPrivateKey": base64.b64encode(deploy_key.encode()).decode(),
        }

        secret = client.V1Secret(
            metadata=client.V1ObjectMeta(
                name="repo-cdk-monitoring",
                namespace="argocd",
                labels={"argocd.argoproj.io/secret-type": "repository"},
            ),
            data=secret_data,
            type="Opaque",
        )

        try:
            v1.create_namespaced_secret("argocd", secret)
            log("  ✓ SSH Deploy Key repo credentials created")
        except client.exceptions.ApiException as e:
            if e.status == 409:
                v1.replace_namespaced_secret("repo-cdk-monitoring", "argocd", secret)
                log("  ✓ SSH Deploy Key repo credentials updated")
            else:
                raise
    except Exception as e:
        log(f"  ⚠ Failed to create repo secret: {e}")

    log("")


# ---------------------------------------------------------------------------
# Step 4: Install ArgoCD (non-HA)
# ---------------------------------------------------------------------------
def install_argocd(cfg: Config) -> None:
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


# ---------------------------------------------------------------------------
# Step 5: Apply App-of-Apps root applications (platform + workloads)
# ---------------------------------------------------------------------------
def apply_root_app(cfg: Config) -> None:
    """Apply the two App-of-Apps root applications.

    The monolithic root-app.yaml was split into two root apps:
      - platform-root-app.yaml → discovers platform/argocd-apps/ (waves 0–4)
      - workloads-root-app.yaml → discovers workloads/argocd-apps/ (wave 5+)

    Platform root must be healthy before workloads root triggers business app syncs.
    """
    log("=== Step 5: Applying App-of-Apps roots (platform + workloads) ===")
    argocd_path = Path(cfg.argocd_dir)

    for root_name in ("platform-root-app.yaml", "workloads-root-app.yaml"):
        root_app = argocd_path / root_name
        if root_app.exists():
            log(f"  → Applying {root_name}")
            run(["kubectl", "apply", "-f", str(root_app)], cfg=cfg)
        else:
            log(f"  ⚠ {root_name} not found at {root_app}")

    log("✓ App-of-Apps roots applied\n")


# ---------------------------------------------------------------------------
# Step 5b: Inject Helm parameters into monitoring ArgoCD Application
# ---------------------------------------------------------------------------
def inject_monitoring_helm_params(cfg: Config) -> None:
    """Inject SNS topic ARN and admin IP allowlist into the monitoring Application's Helm parameters.

    Reads the SNS topic ARN from SSM and the admin IPs from SSM,
    then patches the ArgoCD Application with all Helm parameter overrides
    in a single merge patch (ArgoCD replaces the entire parameters array).
    """
    log("=== Step 5b: Injecting Monitoring Helm Parameters ===")

    parameters: list[dict[str, str]] = []

    # --- SNS Topic ARN ---
    ssm_path = f"{cfg.ssm_prefix}/monitoring/alerts-topic-arn"
    log(f"  → Reading SNS ARN from SSM: {ssm_path}")

    if not cfg.dry_run:
        try:
            ssm = get_ssm_client(cfg)
            resp = ssm.get_parameter(Name=ssm_path)
            topic_arn = resp["Parameter"]["Value"]
            log(f"  ✓ SNS Topic ARN: {topic_arn}")
            parameters.append({
                "name": "grafana.alerting.snsTopicArn",
                "value": topic_arn,
            })
        except Exception as e:
            log(f"  ⚠ SNS topic ARN not found in SSM — {e}")

    # --- Admin IP Allowlist ---
    ip_ssm_paths = [
        (f"{cfg.ssm_prefix}/monitoring/allow-ipv4", "adminAccess.allowedIps[0]"),
        (f"{cfg.ssm_prefix}/monitoring/allow-ipv6", "adminAccess.allowedIps[1]"),
    ]

    for ip_ssm_path, param_name in ip_ssm_paths:
        log(f"  → Reading IP from SSM: {ip_ssm_path}")
        if not cfg.dry_run:
            try:
                ssm = get_ssm_client(cfg)
                resp = ssm.get_parameter(Name=ip_ssm_path)
                ip_value = resp["Parameter"]["Value"]
                log(f"  ✓ {param_name}: {ip_value}")
                parameters.append({"name": param_name, "value": ip_value})
            except Exception as e:
                log(f"  ⚠ IP not found in SSM ({ip_ssm_path}) — {e}")

    if cfg.dry_run:
        log("  [DRY-RUN] Would patch monitoring Application with Helm parameters\n")
        return

    if not parameters:
        log("  ⚠ No parameters to inject — skipping patch\n")
        return

    # Patch the monitoring ArgoCD Application with all Helm parameter overrides
    patch = json.dumps({
        "spec": {
            "source": {
                "helm": {
                    "parameters": parameters
                }
            }
        }
    })

    result = run(
        ["kubectl", "patch", "application", "monitoring", "-n", "argocd",
         "--type", "merge", "-p", patch],
        cfg=cfg, check=False,
    )

    if result.returncode == 0:
        log(f"  ✓ Monitoring Application patched with {len(parameters)} Helm parameters")
    else:
        log("  ⚠ Failed to patch monitoring Application")

    log("")


# ---------------------------------------------------------------------------
# Step 5c: Seed ECR credentials (Day-1 bootstrap)
# ---------------------------------------------------------------------------
def seed_ecr_credentials(cfg: Config) -> None:
    """Create the initial ecr-credentials secret for ArgoCD Image Updater.

    The ecr-token-refresh CronJob (deployed by ArgoCD wave 4) refreshes
    ECR credentials every 6 hours, but won't fire until its next schedule
    boundary (up to 6h after creation). ArgoCD Image Updater starts
    immediately and needs valid ECR credentials from its first poll.

    This step seeds the secret once during bootstrap; the CronJob takes
    over ongoing rotation from there.

    Credential source: EC2 instance profile (IMDS) — same as the CronJob.
    """
    log("=== Step 5c: Seeding ECR Credentials (Day-1) ===")

    ecr_registry = f"771826808455.dkr.ecr.{cfg.aws_region}.amazonaws.com"

    if cfg.dry_run:
        log(f"  [DRY-RUN] Would seed ecr-credentials secret for {ecr_registry}\n")
        return

    # 1. Get ECR authorization token via AWS CLI (uses instance profile)
    result = run(
        ["aws", "ecr", "get-login-password", "--region", cfg.aws_region],
        cfg=cfg, check=False, capture=True,
    )
    ecr_token = result.stdout.strip() if result.returncode == 0 else ""

    if not ecr_token:
        log("  ⚠ Failed to get ECR token — Image Updater will 401 until CronJob fires")
        log("    (ecr-token-refresh CronJob will create the secret on its first run)\n")
        return

    log("  ✓ ECR authorization token obtained")

    # 2. Build dockerconfigjson and create the K8s secret
    try:
        from kubernetes import client, config as k8s_config

        k8s_config.load_kube_config(config_file=cfg.kubeconfig)
        v1 = client.CoreV1Api()

        # Build the Docker config JSON structure
        auth_str = base64.b64encode(f"AWS:{ecr_token}".encode()).decode()
        docker_config = json.dumps({
            "auths": {
                ecr_registry: {"auth": auth_str}
            }
        })
        config_b64 = base64.b64encode(docker_config.encode()).decode()

        secret = client.V1Secret(
            metadata=client.V1ObjectMeta(
                name="ecr-credentials",
                namespace="argocd",
                labels={
                    "app.kubernetes.io/managed-by": "ecr-token-refresh",
                    "app.kubernetes.io/part-of": "argocd",
                },
            ),
            data={".dockerconfigjson": config_b64},
            type="kubernetes.io/dockerconfigjson",
        )

        try:
            v1.create_namespaced_secret("argocd", secret)
            log("  ✓ ecr-credentials secret created (seed)")
        except client.exceptions.ApiException as e:
            if e.status == 409:
                v1.replace_namespaced_secret("ecr-credentials", "argocd", secret)
                log("  ✓ ecr-credentials secret updated (seed)")
            else:
                raise

        log(f"  ✓ Image Updater can now authenticate to {ecr_registry}")
    except Exception as e:
        log(f"  ⚠ Failed to seed ecr-credentials: {e}")
        log("    (ecr-token-refresh CronJob will create the secret on its first run)")

    log("")


# ---------------------------------------------------------------------------
# Step 5c-cp: Provision Crossplane AWS credentials (Secrets Manager → K8s)
# ---------------------------------------------------------------------------
def provision_crossplane_credentials(cfg: Config) -> None:
    """Pull Crossplane AWS credentials from Secrets Manager → K8s Secret.

    CDK CrossplaneStack creates an IAM user with tightly scoped permissions
    (S3, SQS, KMS) and stores the access key in Secrets Manager at:
        {namePrefix}/crossplane/aws-credentials

    This step bridges that credential into the crossplane-system namespace
    as the K8s Secret 'crossplane-aws-creds', which ProviderConfig references.

    The Secret format matches what Crossplane's AWS ProviderConfig expects:
        [default]
        aws_access_key_id = AKIA...
        aws_secret_access_key = ...
    """
    log("=== Step 5c-cp: Provisioning Crossplane AWS Credentials ===")

    # Derive the Secrets Manager secret name from environment.
    # CDK uses: {namePrefix}/crossplane/aws-credentials
    # where namePrefix = 'shared-{env}' (e.g. 'shared-dev')
    env_short = cfg.env[:3]  # 'development' → 'dev'
    secret_name = f"shared-{env_short}/crossplane/aws-credentials"

    if cfg.dry_run:
        log(f"  [DRY-RUN] Would provision crossplane-aws-creds from {secret_name}\n")
        return

    # 1. Read credentials from Secrets Manager
    try:
        sm = get_secrets_client(cfg)
        resp = sm.get_secret_value(SecretId=secret_name)
        secret_data = json.loads(resp["SecretString"])

        access_key = secret_data.get("aws_access_key_id", "")
        secret_key = secret_data.get("aws_secret_access_key", "")

        if not access_key or not secret_key:
            log(f"  ⚠ Secrets Manager secret '{secret_name}' has empty credentials")
            log("    Crossplane providers will fail to authenticate to AWS\n")
            return

        log(f"  ✓ Retrieved credentials from Secrets Manager ({secret_name})")
    except Exception as e:
        log(f"  ⚠ Failed to read Secrets Manager secret '{secret_name}': {e}")
        log("    Crossplane providers will fail to authenticate to AWS")
        log("    Deploy the Shared-Crossplane CDK stack first:\n")
        log(f"      npx cdk deploy 'Shared-Crossplane-{cfg.env}'\n")
        return

    # 2. Format as INI-style credentials (ProviderConfig expects this)
    credentials_ini = (
        f"[default]\n"
        f"aws_access_key_id = {access_key}\n"
        f"aws_secret_access_key = {secret_key}\n"
    )

    # 3. Create the K8s Secret in crossplane-system namespace
    try:
        from kubernetes import client, config as k8s_config

        k8s_config.load_kube_config(config_file=cfg.kubeconfig)
        v1 = client.CoreV1Api()

        # Ensure crossplane-system namespace exists
        try:
            v1.read_namespace("crossplane-system")
        except client.exceptions.ApiException as e:
            if e.status == 404:
                v1.create_namespace(client.V1Namespace(
                    metadata=client.V1ObjectMeta(name="crossplane-system"),
                ))
                log("  ✓ Created crossplane-system namespace")
            else:
                raise

        creds_b64 = base64.b64encode(credentials_ini.encode()).decode()

        secret = client.V1Secret(
            metadata=client.V1ObjectMeta(
                name="crossplane-aws-creds",
                namespace="crossplane-system",
                labels={
                    "app.kubernetes.io/managed-by": "bootstrap",
                    "app.kubernetes.io/part-of": "crossplane",
                    "platform.engineering/component": "infrastructure-abstraction",
                },
            ),
            data={"credentials": creds_b64},
            type="Opaque",
        )

        try:
            v1.create_namespaced_secret("crossplane-system", secret)
            log("  ✓ crossplane-aws-creds secret created")
        except client.exceptions.ApiException as e:
            if e.status == 409:
                v1.replace_namespaced_secret(
                    "crossplane-aws-creds", "crossplane-system", secret,
                )
                log("  ✓ crossplane-aws-creds secret updated")
            else:
                raise

        log("  ✓ Crossplane ProviderConfig can now authenticate to AWS")
    except Exception as e:
        log(f"  ⚠ Failed to create crossplane-aws-creds secret: {e}")
        log("    Crossplane providers will fail to authenticate to AWS")

    log("")


# ---------------------------------------------------------------------------
# Step 5d-pre: Restore TLS certificate from SSM (prevents rate-limit exhaustion)
# ---------------------------------------------------------------------------
def restore_tls_cert(cfg: Config) -> None:
    """Restore backed-up TLS certificate AND ACME account key from SSM.

    On instance replacement the etcd data may be lost (DR recovery, fresh EBS),
    including the TLS Secret and the ACME account key. Without this restore:
      - cert-manager requests a new certificate → rate-limit exhaustion
      - A new ACME account is registered → rate limits count from zero

    The persist-tls-cert.py script (in k8s-bootstrap/system/cert-manager/) is
    called with --restore for each Secret. If an SSM backup exists, the Secret
    is created *before* cert-manager syncs, so cert-manager sees the Secret
    already exists and skips issuance.

    Note: When the EBS volume is re-attached cleanly, etcd preserves all
    Secrets and this step becomes a no-op (the script skips existing Secrets).
    """
    log("=== Step 5d-pre: Restoring TLS certificate + ACME key from SSM ===")

    cert_manager_dir = Path(cfg.argocd_dir).parent / "cert-manager"
    persist_script = cert_manager_dir / "persist-tls-cert.py"

    if not persist_script.exists():
        log(f"  ⚠ {persist_script} not found — skipping TLS restore")
        log("    cert-manager will request a new certificate\n")
        return

    env = {
        **os.environ,
        "KUBECONFIG": cfg.kubeconfig,
        "SSM_PREFIX": cfg.ssm_prefix,
        "AWS_REGION": cfg.aws_region,
    }

    # Restore both the TLS cert and the ACME account key.
    # The ACME account key preserves the Let's Encrypt account identity,
    # preventing a new account from being registered on DR recovery.
    secrets_to_restore = [
        ("ops-tls-cert", "kube-system"),
        ("letsencrypt-account-key", "cert-manager"),
    ]

    for secret_name, namespace in secrets_to_restore:
        log(f"  → Restoring {namespace}/{secret_name}...")
        args = [
            sys.executable, str(persist_script),
            "--restore",
            "--secret", secret_name,
            "--namespace", namespace,
        ]
        if cfg.dry_run:
            args.append("--dry-run")

        result = subprocess.run(args, env=env, check=False)

        if result.returncode == 0:
            log(f"  ✓ {secret_name} restore completed")
        else:
            log(f"  ⚠ {secret_name} restore failed — cert-manager may request a new certificate")

    log("")


# ---------------------------------------------------------------------------
# Step 5d: Apply cert-manager ClusterIssuer (DNS-01 via Route 53)
# ---------------------------------------------------------------------------
def apply_cert_manager_issuer(cfg: Config) -> None:
    """Apply the cert-manager ClusterIssuer with DNS-01 Route 53 solver.

    Reads the public hosted zone ID and cross-account DNS role ARN from SSM
    (written by CDK control-plane-stack) and creates the ClusterIssuer
    manifest inline via kubectl apply.

    This step runs during bootstrap instead of being managed by ArgoCD
    because the ClusterIssuer contains environment-specific values that
    can't be templated in Git without a Helm chart or Kustomize overlay.

    DNS-01 was chosen over HTTP-01 because Traefik's hostNetwork:true + EIP
    causes hairpin NAT failure — cert-manager's self-check can't reach the
    EIP from inside the cluster.
    """
    log("=== Step 5d: Applying cert-manager ClusterIssuer (DNS-01) ===")

    if cfg.dry_run:
        log("  [DRY-RUN] Would read SSM params and apply ClusterIssuer with DNS-01\n")
        return

    # Read DNS-01 config from SSM (written by CDK control-plane-stack)
    public_hz_id: Optional[str] = None
    dns_role_arn: Optional[str] = None

    try:
        ssm = get_ssm_client(cfg)

        try:
            resp = ssm.get_parameter(Name=f"{cfg.ssm_prefix}/public-hosted-zone-id")
            public_hz_id = resp["Parameter"]["Value"]
            log(f"  ✓ Public Hosted Zone ID: {public_hz_id}")
        except Exception as e:
            log(f"  ⚠ Public Hosted Zone ID not found in SSM — {e}")

        try:
            resp = ssm.get_parameter(Name=f"{cfg.ssm_prefix}/cross-account-dns-role-arn")
            dns_role_arn = resp["Parameter"]["Value"]
            log(f"  ✓ Cross-Account DNS Role: {dns_role_arn}")
        except Exception as e:
            log(f"  ⚠ Cross-Account DNS Role ARN not found in SSM — {e}")

    except Exception as e:
        log(f"  ⚠ Failed to read SSM parameters — {e}")

    if not public_hz_id or not dns_role_arn:
        log("  ⚠ Missing DNS-01 config — falling back to template file")
        log("    Ensure CDK deployed with HOSTED_ZONE_ID and CROSS_ACCOUNT_ROLE_ARN env vars")
        log("    Then re-run bootstrap or apply ClusterIssuer manually\n")
        return

    # Apply ClusterIssuer with DNS-01 Route 53 solver
    #
    # PRODUCTION NOTE — Rate-limit recovery:
    #   Let's Encrypt enforces 5 certs per exact domain set per 168 hours.
    #   If the TLS Secret is lost (etcd wipe) and the rate limit is hit,
    #   switch to the STAGING server temporarily to unblock cert-manager:
    #
    #     kubectl patch clusterissuer letsencrypt --type=merge -p \
    #       '{"spec":{"acme":{"server":"https://acme-staging-v02.api.letsencrypt.org/directory"}}}'
    #     kubectl delete order,certificaterequest --all -n kube-system
    #
    #   Staging certs are NOT browser-trusted but allow cert-manager-config
    #   to reach Healthy status. Switch back to production after 168h:
    #
    #     kubectl patch clusterissuer letsencrypt --type=merge -p \
    #       '{"spec":{"acme":{"server":"https://acme-v02.api.letsencrypt.org/directory"}}}'
    #     kubectl delete order,certificaterequest --all -n kube-system
    #
    #   The persist-tls-cert.py backup/restore flow prevents this scenario
    #   by preserving the TLS Secret across redeploys via SSM.
    #
    manifest = f"""apiVersion: cert-manager.io/v1
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
            region: {cfg.aws_region}
            hostedZoneID: {public_hz_id}
            role: {dns_role_arn}
"""

    result = subprocess.run(
        ["kubectl", "apply", "-f", "-"],
        input=manifest, text=True, capture_output=True,
        env={**os.environ, "KUBECONFIG": cfg.kubeconfig},
    )

    if result.returncode == 0:
        log("  ✓ ClusterIssuer 'letsencrypt' applied with DNS-01 solver")
    else:
        log(f"  ⚠ Failed to apply ClusterIssuer: {result.stderr.strip()}")
        log("    cert-manager CRDs may not be installed yet — ArgoCD will sync them")
        log("    Re-run bootstrap after cert-manager is healthy")
        log("")
        return

    # Remove ArgoCD tracking annotation so selfHeal doesn't overwrite this resource.
    # The cert-manager-config Application now syncs from platform/cert-manager-config/
    # which only contains the Certificate CR — the ClusterIssuer is bootstrap-managed.
    run(
        ["kubectl", "annotate", "clusterissuer", "letsencrypt",
         "argocd.argoproj.io/tracking-id-", "--overwrite"],
        cfg=cfg, check=False,
    )

    # Clean up stale cert-manager resources ONLY if the TLS Secret is missing.
    # If the Secret exists (restored from SSM or persisted via EBS/etcd),
    # cleaning up CertificateRequests would force cert-manager to re-issue,
    # which exhausts Let's Encrypt rate limits (5 certs per 168h per domain).
    #
    # The cleanup is still valuable on first bootstrap or after DR recovery
    # (no existing Secret), where stale resources from a previous broken
    # ClusterIssuer config could block new issuance.
    secret_exists = subprocess.run(
        ["kubectl", "get", "secret", "ops-tls-cert", "-n", "kube-system"],
        env={**os.environ, "KUBECONFIG": cfg.kubeconfig},
        capture_output=True, text=True,
    )

    if secret_exists.returncode == 0:
        log("  ✓ TLS Secret 'ops-tls-cert' exists — skipping stale resource cleanup")
        log("    (cleaning up would force cert-manager to re-issue)")
        log("")
        return

    log("  → TLS Secret missing — cleaning up stale cert-manager resources...")
    for resource in ("challenge", "order", "certificaterequest"):
        # First remove finalizers from stuck resources
        list_result = run(
            ["kubectl", "get", resource, "-n", "kube-system",
             "-o", "jsonpath={.items[*].metadata.name}"],
            cfg=cfg, check=False, capture=True,
        )
        if list_result.returncode == 0 and list_result.stdout.strip():
            for name in list_result.stdout.strip().split():
                run(
                    ["kubectl", "patch", resource, name, "-n", "kube-system",
                     "--type", "merge", "-p", '{"metadata":{"finalizers":null}}'],
                    cfg=cfg, check=False,
                )
            # Now delete them
            run(
                ["kubectl", "delete", resource, "--all", "-n", "kube-system",
                 "--timeout=30s"],
                cfg=cfg, check=False,
            )
            log(f"    ✓ Cleaned up stale {resource}(s)")
        else:
            log(f"    - No stale {resource}(s) found")

    log("")


# ---------------------------------------------------------------------------
# Step 7: Apply ArgoCD ingress (after ArgoCD is ready and syncing Traefik)
# ---------------------------------------------------------------------------
def apply_ingress(cfg: Config) -> None:
    log("=== Step 7: Applying ArgoCD ingress ===")
    argocd_path = Path(cfg.argocd_dir)

    # Collect all ingress manifests to apply
    ingress_files = [
        ("ingress.yaml", "Main ArgoCD ingress"),
        ("webhook-ingress.yaml", "GitHub webhook ingress"),
    ]

    manifests_to_apply: list[tuple[Path, str]] = []
    for filename, label in ingress_files:
        path = argocd_path / filename
        if path.exists():
            manifests_to_apply.append((path, label))
        else:
            log(f"  ⚠ {filename} not found — skipping {label}")

    if not manifests_to_apply:
        log("  ⚠ No ingress manifests found — skipping\n")
        return

    # Traefik CRDs (IngressRoute, Middleware) are installed by ArgoCD via the
    # root app. ArgoCD is now running (Step 6 passed), but it may still be
    # syncing Traefik. Retry with generous backoff.
    log("  → Waiting for Traefik CRDs before applying ingress...")
    max_retries = 10
    for attempt in range(1, max_retries + 1):
        all_applied = True
        for manifest_path, label in manifests_to_apply:
            result = run(
                ["kubectl", "apply", "-f", str(manifest_path)],
                cfg=cfg, check=False,
            )
            if result.returncode == 0:
                log(f"  ✓ {label} applied")
            else:
                all_applied = False
        if all_applied:
            break
        if attempt < max_retries:
            log(f"  Attempt {attempt}/{max_retries} — Traefik CRDs not ready, waiting 30s...")
            time.sleep(30)
        else:
            log("  ⚠ Ingress not applied — Traefik CRDs not available after 5 min.")
            log("    ArgoCD will install Traefik shortly. Apply manually:")
            for manifest_path, _ in manifests_to_apply:
                log(f"    kubectl apply -f {manifest_path}")

    log("")


# ---------------------------------------------------------------------------
# Step 7c: Configure ArgoCD GitHub webhook secret
# ---------------------------------------------------------------------------
def configure_webhook_secret(cfg: Config) -> None:
    """Generate a random webhook secret and patch it into argocd-secret.

    ArgoCD validates incoming GitHub webhook payloads using HMAC-SHA256
    with the secret stored at 'webhook.github.secret' in argocd-secret.
    The same secret value must be configured in the GitHub repository's
    webhook settings.

    The secret is also stored in SSM so it can be retrieved when
    configuring the GitHub webhook (manually or via GitHub Actions).
    """
    log("=== Step 7c: Configuring ArgoCD GitHub webhook secret ===")

    ssm_path = f"{cfg.ssm_prefix}/argocd-webhook-secret"

    if cfg.dry_run:
        log(f"  [DRY-RUN] Would generate webhook secret and store at: {ssm_path}")
        log("  [DRY-RUN] Would patch argocd-secret with webhook.github.secret\n")
        return

    # 1. Check if a webhook secret already exists in SSM (idempotent)
    existing_secret: Optional[str] = None
    try:
        ssm = get_ssm_client(cfg)
        resp = ssm.get_parameter(Name=ssm_path, WithDecryption=True)
        existing_secret = resp["Parameter"]["Value"]
        log("  ✓ Webhook secret already exists in SSM — reusing")
    except Exception:
        pass  # Secret doesn't exist yet — generate a new one

    # 2. Generate a new secret if one doesn't exist
    if existing_secret:
        webhook_secret = existing_secret
    else:
        import secrets as secrets_mod
        webhook_secret = secrets_mod.token_hex(32)
        log("  ✓ Generated new webhook secret (64 hex chars)")

        # Store in SSM for retrieval when configuring the GitHub webhook
        try:
            ssm = get_ssm_client(cfg)
            try:
                ssm.put_parameter(
                    Name=ssm_path,
                    Description="ArgoCD GitHub webhook secret for HMAC validation",
                    Value=webhook_secret,
                    Type="SecureString",
                )
                log(f"  ✓ Webhook secret stored in SSM: {ssm_path}")
            except ssm.exceptions.ParameterAlreadyExists:
                ssm.put_parameter(
                    Name=ssm_path,
                    Value=webhook_secret,
                    Type="SecureString",
                    Overwrite=True,
                )
                log(f"  ✓ Webhook secret updated in SSM: {ssm_path}")
        except Exception as e:
            log(f"  ⚠ Failed to store webhook secret in SSM: {e}")
            log(f"    Store it manually: aws ssm put-parameter --name {ssm_path} ...")

    # 3. Patch argocd-secret with the webhook secret
    patch = json.dumps({
        "stringData": {
            "webhook.github.secret": webhook_secret,
        }
    })

    result = run(
        ["kubectl", "-n", "argocd", "patch", "secret", "argocd-secret",
         "--type", "merge", "-p", patch],
        cfg=cfg, check=False,
    )

    if result.returncode == 0:
        log("  ✓ argocd-secret patched with webhook.github.secret")
    else:
        log("  ⚠ Failed to patch argocd-secret")
        log("    Manual fix: kubectl -n argocd patch secret argocd-secret ...")

    log("")


# ---------------------------------------------------------------------------
# Step 7b: Create ArgoCD IP Allowlist Middleware from SSM
# ---------------------------------------------------------------------------
def create_argocd_ip_allowlist(cfg: Config) -> None:
    """Create the admin-ip-allowlist Middleware in the argocd namespace.

    Reads admin IPs from SSM (same parameters as the monitoring chart)
    and creates the Traefik IPAllowList middleware dynamically, keeping
    secrets out of version control.
    """
    log("=== Step 7b: Creating ArgoCD IP Allowlist Middleware ===")

    ip_ssm_paths = [
        f"{cfg.ssm_prefix}/monitoring/allow-ipv4",
        f"{cfg.ssm_prefix}/monitoring/allow-ipv6",
    ]

    if cfg.dry_run:
        log("  [DRY-RUN] Would read IPs from SSM and create middleware\n")
        return

    # Collect IPs from SSM
    source_ranges: list[str] = []
    for ip_ssm_path in ip_ssm_paths:
        try:
            ssm = get_ssm_client(cfg)
            resp = ssm.get_parameter(Name=ip_ssm_path)
            ip_value = resp["Parameter"]["Value"]
            source_ranges.append(ip_value)
            log(f"  ✓ {ip_ssm_path}: {ip_value}")
        except Exception as e:
            log(f"  ⚠ IP not found in SSM ({ip_ssm_path}) — {e}")

    if not source_ranges:
        log("  ⚠ No IPs found — skipping middleware creation")
        log("    ArgoCD ingress will reject all traffic until middleware exists\n")
        return

    # Build the Middleware manifest
    source_range_yaml = "\n".join(f'      - "{ip}"' for ip in source_ranges)
    manifest = f"""apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: admin-ip-allowlist
  namespace: argocd
  labels:
    app.kubernetes.io/part-of: argocd
spec:
  ipAllowList:
    sourceRange:
{source_range_yaml}
"""

    result = subprocess.run(
        ["kubectl", "apply", "-f", "-"],
        input=manifest, text=True, capture_output=True,
    )

    if result.returncode == 0:
        log(f"  ✓ ArgoCD IP allowlist middleware created with {len(source_ranges)} IP(s)")
    else:
        log(f"  ⚠ Failed to create middleware: {result.stderr.strip()}")

    log("")


# ---------------------------------------------------------------------------
# Step 6: Wait for ArgoCD server readiness (must pass before Step 7 ingress)
# ---------------------------------------------------------------------------
def _has_worker_nodes(cfg: Config) -> bool:
    """Check if any worker nodes (without control-plane taint) exist."""
    result = run(
        ["kubectl", "get", "nodes",
         "-l", "!node-role.kubernetes.io/control-plane",
         "-o", "name"],
        cfg=cfg, check=False, capture=True,
    )
    nodes = [n for n in result.stdout.strip().split("\n") if n] if result.returncode == 0 else []
    return len(nodes) > 0


def wait_for_argocd(cfg: Config) -> None:
    log("=== Step 6: Waiting for ArgoCD server ===")

    if cfg.dry_run:
        log("  [DRY-RUN] Would wait for argocd-server, repo-server, application-controller\n")
        return

    # On Day-0, only the control plane node exists (with NoSchedule taint).
    # ArgoCD pods can't be scheduled until workers join — skip the wait.
    if not _has_worker_nodes(cfg):
        log("  ℹ No worker nodes available yet — ArgoCD pods will remain Pending")
        log("  ℹ Pods will start automatically once workers join the cluster")
        log("  → Skipping readiness wait (control plane has NoSchedule taint)\n")
        return

    targets = [
        ("deployment", "argocd-server"),
        ("deployment", "argocd-repo-server"),
        ("statefulset", "argocd-application-controller"),
    ]

    for kind, name in targets:
        log(f"  → Waiting for {name}...")
        result = run(
            ["kubectl", "rollout", "status", f"{kind}/{name}",
             "-n", "argocd", f"--timeout={cfg.argo_timeout}s"],
            cfg=cfg, check=False,
        )
        if result.returncode != 0:
            log(f"  ⚠ {name} not ready within {cfg.argo_timeout}s")

    log("")


# ---------------------------------------------------------------------------
# Step 8: Install ArgoCD CLI
# ---------------------------------------------------------------------------
def install_argocd_cli(cfg: Config) -> bool:
    log("=== Step 8: Installing ArgoCD CLI ===")

    if cfg.dry_run:
        log(f"  [DRY-RUN] Would install ArgoCD CLI {cfg.argocd_cli_version}\n")
        return True

    import platform
    arch_map = {"x86_64": "amd64", "aarch64": "arm64", "arm64": "arm64"}
    cli_arch = arch_map.get(platform.machine(), "amd64")

    url = (
        f"https://github.com/argoproj/argo-cd/releases/download/"
        f"{cfg.argocd_cli_version}/argocd-linux-{cli_arch}"
    )
    log(f"  → Downloading ArgoCD CLI {cfg.argocd_cli_version} ({cli_arch})...")

    result = run(
        ["bash", "-c", f'curl -sSL -o /usr/local/bin/argocd "{url}" && chmod +x /usr/local/bin/argocd'],
        cfg=cfg, check=False,
    )

    if result.returncode == 0:
        version_result = run(
            ["argocd", "version", "--client", "--short"],
            cfg=cfg, check=False, capture=True,
        )
        version = version_result.stdout.strip() if version_result.returncode == 0 else cfg.argocd_cli_version
        log(f"  ✓ ArgoCD CLI installed: {version}\n")
        return True
    else:
        log("  ⚠ ArgoCD CLI install failed — skipping CI bot token generation\n")
        return False


# ---------------------------------------------------------------------------
# Step 9: Create CI bot account
# ---------------------------------------------------------------------------
def create_ci_bot(cfg: Config) -> None:
    log("=== Step 9: Creating CI bot account ===")

    if cfg.dry_run:
        log("  [DRY-RUN] Would patch argocd-cm and argocd-rbac-cm\n")
        return

    # Register ci-bot account
    cm_patch = json.dumps({"data": {"accounts.ci-bot": "apiKey"}})
    result = run(
        ["kubectl", "patch", "configmap", "argocd-cm", "-n", "argocd",
         "--type", "merge", "-p", cm_patch],
        cfg=cfg, check=False,
    )
    if result.returncode == 0:
        log("  ✓ ci-bot account registered in argocd-cm")
    else:
        log("  ⚠ Failed to patch argocd-cm")

    # Grant ci-bot read-only RBAC
    rbac_csv = (
        "p, role:ci-readonly, applications, get, */*, allow\n"
        "p, role:ci-readonly, applications, list, */*, allow\n"
        "g, ci-bot, role:ci-readonly"
    )
    rbac_patch = json.dumps({"data": {"policy.csv": rbac_csv}})
    result = run(
        ["kubectl", "patch", "configmap", "argocd-rbac-cm", "-n", "argocd",
         "--type", "merge", "-p", rbac_patch],
        cfg=cfg, check=False,
    )
    if result.returncode == 0:
        log("  ✓ ci-bot RBAC policy applied (read-only)")
    else:
        log("  ⚠ Failed to patch argocd-rbac-cm")

    # Restart argocd-server so it picks up the new ci-bot account from argocd-cm.
    # Without this restart, the server won't recognize the ci-bot token and the
    # verify job's health check will fail with HTTP 401.
    # Note: Step 10 generates the token using --core mode (talks to K8s API
    # directly), so the token IS valid — but the server must also know about
    # the account to accept it when the CI pipeline queries the API.
    log("  → Restarting argocd-server to load ci-bot account...")
    result = run(
        ["kubectl", "rollout", "restart", "deployment/argocd-server",
         "-n", "argocd"],
        cfg=cfg, check=False,
    )
    if result.returncode == 0:
        log("  ✓ argocd-server restart triggered")
        # Wait for the new pods to be ready before generating the token
        result = run(
            ["kubectl", "rollout", "status", "deployment/argocd-server",
             "-n", "argocd", f"--timeout={cfg.argo_timeout}s"],
            cfg=cfg, check=False,
        )
        if result.returncode == 0:
            log("  ✓ argocd-server rollout complete — ci-bot account loaded")
        else:
            log(f"  ⚠ argocd-server rollout not ready within {cfg.argo_timeout}s")
    else:
        log("  ⚠ Failed to restart argocd-server — token may not work for health check")

    log("")


# ---------------------------------------------------------------------------
# Step 10: Generate API token → Secrets Manager
# ---------------------------------------------------------------------------
def generate_ci_token(cfg: Config) -> None:
    log("=== Step 10: Generating CI bot token ===")

    secret_name = f"k8s/{cfg.env}/argocd-ci-token"

    if cfg.dry_run:
        log(f"  [DRY-RUN] Would generate token and store at: {secret_name}\n")
        return

    log("  → Generating API token for ci-bot...")

    # ArgoCD CLI in --core mode uses the kubectl context's current namespace.
    # Set it to argocd so the CLI can find argocd-cm.
    run(
        ["kubectl", "config", "set-context", "--current", "--namespace=argocd"],
        cfg=cfg, check=False,
    )

    result = run(
        ["argocd", "account", "generate-token", "--account", "ci-bot", "--core", "--grpc-web"],
        cfg=cfg, check=False, capture=True,
    )

    ci_token = result.stdout.strip() if result.returncode == 0 else ""

    if not ci_token:
        log("  ⚠ Token generation failed — CI pipeline will skip ArgoCD verification\n")
        return

    log("  ✓ API token generated")
    log(f"  → Pushing token to Secrets Manager: {secret_name}")

    try:
        sm = get_secrets_client(cfg)
        try:
            sm.create_secret(
                Name=secret_name,
                Description="ArgoCD CI bot API token for pipeline verification",
                SecretString=ci_token,
            )
            log("  ✓ Secret created in Secrets Manager")
        except sm.exceptions.ResourceExistsException:
            sm.update_secret(SecretId=secret_name, SecretString=ci_token)
            log("  ✓ Secret updated in Secrets Manager")
    except Exception as e:
        log(f"  ⚠ Failed to store token in Secrets Manager: {e}")

    log("")


# ---------------------------------------------------------------------------
# Step 10b: Set ArgoCD admin password from SSM Parameter Store
# ---------------------------------------------------------------------------
def set_admin_password(cfg: Config) -> None:
    """Read the ArgoCD admin password from SSM and patch argocd-secret.

    Follows the same pattern as Grafana credentials — the admin password
    is stored as an SSM SecureString parameter and applied to the cluster
    during bootstrap.

    Flow:
      1. Read plaintext password from SSM: {ssm_prefix}/argocd-admin-password
      2. Hash the password using bcrypt (ArgoCD stores bcrypt hashes)
      3. Patch the 'argocd-secret' Kubernetes Secret with:
         - admin.password: bcrypt hash
         - admin.passwordMtime: current UTC timestamp (triggers ArgoCD refresh)
      4. Restart argocd-server so it picks up the new password

    If the SSM parameter does not exist, this step is skipped gracefully.
    The auto-generated password in argocd-initial-admin-secret remains
    usable as a fallback.

    Prerequisites:
      - SSM parameter: {ssm_prefix}/argocd-admin-password (SecureString)
      - IAM: ssm:GetParameter with WithDecryption on the parameter
      - Python: bcrypt package (installed via requirements.txt)

    Related:
      - Grafana uses the same SSM -> K8s Secret pattern via deploy.py
      - ArgoCD password reset guide: docs/troubleshooting/argocd_admin_reset.md
    """
    log("=== Step 10b: Setting ArgoCD admin password from SSM ===")

    if cfg.dry_run:
        log(f"  [DRY-RUN] Would read {cfg.ssm_prefix}/argocd-admin-password from SSM")
        log("  [DRY-RUN] Would hash with bcrypt and patch argocd-secret\n")
        return

    # 1. Read the admin password from SSM Parameter Store (SecureString)
    ssm_path = f"{cfg.ssm_prefix}/argocd-admin-password"
    log(f"  → Reading admin password from SSM: {ssm_path}")

    try:
        ssm = get_ssm_client(cfg)
        resp = ssm.get_parameter(Name=ssm_path, WithDecryption=True)
        password = resp["Parameter"]["Value"]
        log("  ✓ Admin password resolved from SSM")
    except Exception as e:
        log(f"  ⚠ ArgoCD admin password not found in SSM — {e}")
        log(f"  ⚠ Store the password at: {ssm_path} (SecureString)")
        log("  ⚠ The auto-generated password (argocd-initial-admin-secret) remains usable\n")
        return

    # 2. Hash the password with bcrypt
    #    ArgoCD stores passwords as bcrypt hashes in argocd-secret.
    #    The hash format must be $2a$ or $2b$ (OpenBSD bcrypt).
    try:
        import bcrypt as bcrypt_lib
        hashed = bcrypt_lib.hashpw(password.encode(), bcrypt_lib.gensalt()).decode()
        log("  ✓ Password hashed with bcrypt")
    except ImportError:
        log("  ⚠ bcrypt package not installed — cannot hash password")
        log("  ⚠ Install with: pip3 install bcrypt\n")
        return
    except Exception as e:
        log(f"  ⚠ Failed to hash password — {e}\n")
        return

    # 3. Patch argocd-secret with the bcrypt hash and a passwordMtime timestamp
    #    The passwordMtime field triggers ArgoCD to reload the password.
    #    Without updating this field, the server may continue using the
    #    cached password until the next full restart.
    mtime = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    patch = json.dumps({
        "stringData": {
            "admin.password": hashed,
            "admin.passwordMtime": mtime,
        }
    })

    result = run(
        ["kubectl", "-n", "argocd", "patch", "secret", "argocd-secret",
         "--type", "merge", "-p", patch],
        cfg=cfg, check=False,
    )

    if result.returncode == 0:
        log("  ✓ argocd-secret patched with SSM-managed password")
    else:
        log("  ⚠ Failed to patch argocd-secret")
        log("    Manual fix: see docs/troubleshooting/argocd_admin_reset.md\n")
        return

    # 4. Restart argocd-server to pick up the new password immediately
    result = run(
        ["kubectl", "rollout", "restart", "deployment/argocd-server",
         "-n", "argocd"],
        cfg=cfg, check=False,
    )

    if result.returncode == 0:
        log("  ✓ argocd-server restarted to load new password")
    else:
        log("  ⚠ Failed to restart argocd-server — password will apply on next restart")

    log("")


# ---------------------------------------------------------------------------
# Step 10c: Back up TLS certificate to SSM (for next redeploy)
# ---------------------------------------------------------------------------
def backup_tls_cert(cfg: Config) -> None:
    """Back up the TLS certificate AND ACME account key to SSM after bootstrap.

    cert-manager may still be issuing the certificate when this runs.
    We wait up to 5 minutes for the TLS Secret to appear, then back it up.
    The ACME account key is backed up immediately (it's created when the
    ClusterIssuer first registers with Let's Encrypt).

    If the cert isn't ready yet (e.g. rate-limited), we log a warning
    and skip the TLS backup — the next successful bootstrap will back it up.
    The ACME key backup is always attempted regardless.
    """
    log("=== Step 10c: Backing up TLS certificate + ACME key to SSM ===")

    cert_manager_dir = Path(cfg.argocd_dir).parent / "cert-manager"
    persist_script = cert_manager_dir / "persist-tls-cert.py"

    if not persist_script.exists():
        log(f"  ⚠ {persist_script} not found — skipping TLS backup\n")
        return

    env = {
        **os.environ,
        "KUBECONFIG": cfg.kubeconfig,
        "SSM_PREFIX": cfg.ssm_prefix,
        "AWS_REGION": cfg.aws_region,
    }

    # Wait for the TLS Secret to appear (cert-manager may still be issuing)
    tls_ready = True
    if not cfg.dry_run:
        log("  → Waiting for ops-tls-cert Secret to be ready...")
        max_wait = 10  # attempts × 30s = 5 min
        tls_ready = False
        for attempt in range(1, max_wait + 1):
            check = subprocess.run(
                ["kubectl", "get", "secret", "ops-tls-cert", "-n", "kube-system",
                 "-o", "jsonpath={.data.tls\\.crt}"],
                env={**os.environ, "KUBECONFIG": cfg.kubeconfig},
                capture_output=True, text=True,
            )
            if check.returncode == 0 and check.stdout.strip():
                log(f"  ✓ TLS Secret ready (attempt {attempt}/{max_wait})")
                tls_ready = True
                break
            if attempt < max_wait:
                log(f"    Attempt {attempt}/{max_wait} — not ready, waiting 30s...")
                time.sleep(30)

        if not tls_ready:
            log("  ⚠ TLS Secret not ready after 5 min — skipping TLS backup")
            log("    This is expected if cert-manager is rate-limited")

    # Back up both secrets. The ACME key is always backed up (it's created
    # immediately). The TLS cert is only backed up if it's ready.
    secrets_to_backup = [
        ("letsencrypt-account-key", "cert-manager"),
    ]
    if tls_ready:
        secrets_to_backup.insert(0, ("ops-tls-cert", "kube-system"))

    for secret_name, namespace in secrets_to_backup:
        log(f"  → Backing up {namespace}/{secret_name}...")
        args = [
            sys.executable, str(persist_script),
            "--backup",
            "--secret", secret_name,
            "--namespace", namespace,
        ]
        if cfg.dry_run:
            args.append("--dry-run")

        result = subprocess.run(args, env=env, check=False)

        if result.returncode == 0:
            log(f"  ✓ {secret_name} backup completed")
        else:
            log(f"  ⚠ {secret_name} backup failed — will retry on next bootstrap")

    log("")


# ---------------------------------------------------------------------------
# Step 11: Summary
# ---------------------------------------------------------------------------
def print_summary(cfg: Config) -> None:
    log("=== ArgoCD Bootstrap Summary ===\n")

    if cfg.dry_run:
        log("  [DRY-RUN] Would show pods and applications\n")
        return

    run(["kubectl", "get", "pods", "-n", "argocd", "-o", "wide"], cfg=cfg, check=False)
    log("")
    run(["kubectl", "get", "applications", "-n", "argocd"], cfg=cfg, check=False)
    log("")

    # Display ArgoCD admin access info
    #
    # The admin password is now managed via SSM Parameter Store
    # (SecureString) at {ssm_prefix}/argocd-admin-password.
    # It is applied during Step 10b.
    #
    # If SSM was not configured, the auto-generated password in
    # argocd-initial-admin-secret is still usable.
    log("=== ArgoCD Admin Access ===")
    log(f"  URL:  https://<eip>/argocd")
    log(f"  User: admin")
    log(f"  Password source: SSM '{cfg.ssm_prefix}/argocd-admin-password'")
    log("")
    log("  If SSM parameter is not set, retrieve the auto-generated password:")
    log("    kubectl -n argocd get secret argocd-initial-admin-secret \\")
    log('      -o jsonpath="{.data.password}" | base64 -d && echo')

    log(f"\n✓ ArgoCD bootstrap complete ({datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')})")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(description="Bootstrap ArgoCD on Kubernetes")
    parser.add_argument("--dry-run", action="store_true", help="Print actions without executing")
    args = parser.parse_args()

    cfg = Config(dry_run=args.dry_run)

    log("=== ArgoCD Bootstrap ===")
    log(f"SSM prefix: {cfg.ssm_prefix}")
    log(f"Region:     {cfg.aws_region}")
    log(f"ArgoCD dir: {cfg.argocd_dir}")
    log(f"Triggered:  {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}")
    log("")

    if cfg.dry_run:
        log("=== DRY RUN — no changes will be made ===")
        log(f"  kubeconfig:       {cfg.kubeconfig}")
        log(f"  argocd_dir:       {cfg.argocd_dir} (exists: {Path(cfg.argocd_dir).exists()})")
        log(f"  cli_version:      {cfg.argocd_cli_version}")
        log(f"  argo_timeout:     {cfg.argo_timeout}s")
        log(f"  environment:      {cfg.env}")
        log("")

    # Step 1: Namespace
    create_namespace(cfg)

    # Step 2: Resolve deploy key
    deploy_key = resolve_deploy_key(cfg)

    # Step 3: Repo secret
    create_repo_secret(cfg, deploy_key)

    # Step 4: Install ArgoCD
    install_argocd(cfg)

    # Step 4b: Default AppProject (ArgoCD v3.x no longer auto-creates it)
    create_default_project(cfg)

    # Step 4c: Configure ArgoCD server for Traefik sub-path routing
    configure_argocd_server(cfg)

    # Step 4d: Custom health checks (stricter Deployment readiness, ConfigMap always-healthy)
    configure_health_checks(cfg)

    # Step 5: App-of-Apps root (triggers Traefik install via ArgoCD)
    apply_root_app(cfg)

    # Step 5b: Inject SNS topic ARN + admin IP allowlist into monitoring Application
    inject_monitoring_helm_params(cfg)

    # Step 5c: Seed ECR credentials (Day-1 — CronJob hasn't fired yet)
    seed_ecr_credentials(cfg)

    # Step 5c-cp: Provision Crossplane AWS credentials (Secrets Manager → K8s)
    provision_crossplane_credentials(cfg)

    # Step 5d-pre: Restore TLS cert from SSM (before cert-manager syncs)
    restore_tls_cert(cfg)

    # Step 5d: Apply cert-manager ClusterIssuer with DNS-01 solver (from SSM)
    apply_cert_manager_issuer(cfg)

    # Step 6: Wait for ArgoCD readiness (must be running before Traefik syncs)
    wait_for_argocd(cfg)

    # Step 7: Ingress (now that ArgoCD is running and syncing Traefik)
    apply_ingress(cfg)

    # Step 7b: Create ArgoCD IP allowlist middleware from SSM
    create_argocd_ip_allowlist(cfg)

    # Step 7c: Configure GitHub webhook secret for instant syncs
    configure_webhook_secret(cfg)

    # Step 8: CLI
    cli_installed = install_argocd_cli(cfg)

    if cli_installed:
        # Step 9: CI bot account
        create_ci_bot(cfg)

        # Step 10: API token
        generate_ci_token(cfg)
    else:
        log("=== Step 9-10: Skipping — ArgoCD CLI not available ===\n")

    # Step 10b: Set admin password from SSM (runs regardless of CLI availability)
    set_admin_password(cfg)

    # Step 10c: Back up TLS cert to SSM (for next redeploy)
    backup_tls_cert(cfg)

    # Step 11: Summary
    print_summary(cfg)


if __name__ == "__main__":
    main()
