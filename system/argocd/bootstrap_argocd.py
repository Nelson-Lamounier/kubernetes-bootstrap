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
  3b. Preserve ArgoCD JWT signing key
  4.  Install ArgoCD (kubectl apply)
  3b-restore. Restore ArgoCD JWT signing key
  4b. Create default AppProject (required in ArgoCD v3.x)
  4c. Configure ArgoCD server (rootpath + insecure for Traefik)
  4d. Configure custom resource health checks
  5.  Apply App-of-Apps root application
  5b. Inject monitoring Helm parameters
  5c. Seed ECR credentials (Day-1 — CronJob hasn't fired yet)
  5c-cp. Provision Crossplane AWS credentials
  5d-pre. Restore TLS certificate from SSM
  5d. Apply cert-manager ClusterIssuer (DNS-01)
  6.  Wait for ArgoCD server readiness
  7.  Apply ArgoCD ingress (needs Traefik CRDs from ArgoCD sync)
  7b. Create ArgoCD IP allowlist middleware
  7c. Configure GitHub webhook secret
  8.  Install ArgoCD CLI
  9.  Create CI bot account
  10. Generate API token → Secrets Manager
  10b. Set admin password from SSM
  10c. Back up TLS certificate to SSM
  10d. Back up ArgoCD JWT signing key to SSM
  11. Summary

Module layout::

    bootstrap_argocd.py          ← this file (slim orchestrator)
    helpers/
      ├── __init__.py
      ├── config.py              ← Config dataclass, parse_args()
      ├── logger.py              ← BootstrapLogger (JSON events)
      └── runner.py              ← log(), run(), get_ssm_client(), get_secrets_client()
    steps/
      ├── __init__.py
      ├── namespace.py           ← Steps 1–3b
      ├── install.py             ← Steps 4–4d
      ├── apps.py                ← Steps 5–5d
      ├── networking.py          ← Steps 6–7c
      └── auth.py                ← Steps 8–11
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from helpers.config import parse_args
from helpers.logger import BootstrapLogger
from helpers.runner import log
from steps.apps import (
    apply_cert_manager_issuer,
    apply_root_app,
    inject_monitoring_helm_params,
    provision_crossplane_credentials,
    restore_tls_cert,
    seed_ecr_credentials,
    seed_prometheus_basic_auth,
)
from steps.auth import (
    backup_argocd_secret_key,
    backup_tls_cert,
    create_ci_bot,
    generate_ci_token,
    install_argocd_cli,
    print_summary,
    set_admin_password,
)
from steps.install import (
    configure_argocd_server,
    configure_health_checks,
    create_default_project,
    install_argocd,
    restore_argocd_secret,
)
from steps.namespace import (
    create_namespace,
    create_repo_secret,
    preserve_argocd_secret,
    resolve_deploy_key,
)
from steps.networking import (
    apply_ingress,
    configure_webhook_secret,
    create_argocd_ip_allowlist,
    wait_for_argocd,
)


def main() -> None:
    """Orchestrate all ArgoCD bootstrap steps with structured JSON logging."""
    cfg = parse_args()

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

    logger = BootstrapLogger(
        ssm_prefix=cfg.ssm_prefix,
        aws_region=cfg.aws_region,
    )

    with logger.step("create_namespace"):
        create_namespace(cfg)

    with logger.step("resolve_deploy_key"):
        deploy_key = resolve_deploy_key(cfg)

    with logger.step("create_repo_secret"):
        create_repo_secret(cfg, deploy_key)

    with logger.step("preserve_argocd_secret"):
        signing_key = preserve_argocd_secret(cfg)

    with logger.step("install_argocd"):
        install_argocd(cfg)

    with logger.step("restore_argocd_secret"):
        restore_argocd_secret(cfg, signing_key)

    with logger.step("create_default_project"):
        create_default_project(cfg)

    with logger.step("configure_argocd_server"):
        configure_argocd_server(cfg)

    with logger.step("configure_health_checks"):
        configure_health_checks(cfg)

    with logger.step("apply_root_app"):
        apply_root_app(cfg)

    with logger.step("inject_monitoring_helm_params"):
        inject_monitoring_helm_params(cfg)

    with logger.step("seed_prometheus_basic_auth"):
        seed_prometheus_basic_auth(cfg)

    with logger.step("seed_ecr_credentials"):
        seed_ecr_credentials(cfg)

    with logger.step("provision_crossplane_credentials"):
        provision_crossplane_credentials(cfg)

    with logger.step("restore_tls_cert"):
        restore_tls_cert(cfg)

    with logger.step("apply_cert_manager_issuer"):
        apply_cert_manager_issuer(cfg)

    with logger.step("wait_for_argocd"):
        wait_for_argocd(cfg)

    with logger.step("apply_ingress"):
        apply_ingress(cfg)

    with logger.step("create_argocd_ip_allowlist"):
        create_argocd_ip_allowlist(cfg)

    with logger.step("configure_webhook_secret"):
        configure_webhook_secret(cfg)

    with logger.step("install_argocd_cli"):
        cli_installed = install_argocd_cli(cfg)

    if cli_installed:
        with logger.step("create_ci_bot"):
            create_ci_bot(cfg)

        with logger.step("generate_ci_token"):
            generate_ci_token(cfg)
    else:
        logger.skip("create_ci_bot", "ArgoCD CLI not available")
        logger.skip("generate_ci_token", "ArgoCD CLI not available")
        log("=== Step 9-10: Skipping — ArgoCD CLI not available ===\n")

    with logger.step("set_admin_password"):
        set_admin_password(cfg)

    with logger.step("backup_tls_cert"):
        backup_tls_cert(cfg)

    with logger.step("backup_argocd_secret_key"):
        backup_argocd_secret_key(cfg)

    with logger.step("print_summary"):
        print_summary(cfg)


if __name__ == "__main__":
    main()
