"""Steps 5–5d: Root apps, monitoring, ECR, Crossplane, TLS restore, and cert-manager."""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
from pathlib import Path

from helpers.config import Config
from helpers.runner import get_secrets_client, get_ssm_client, log, run


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
        from kubernetes import client
        from kubernetes import config as k8s_config

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
        from kubernetes import client
        from kubernetes import config as k8s_config

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
    public_hz_id: str | None = None
    dns_role_arn: str | None = None

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
