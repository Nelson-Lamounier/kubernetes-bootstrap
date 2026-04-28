#!/usr/bin/env tsx
// @format
// bootstrap_argocd.ts — Bootstrap ArgoCD on Kubernetes (TypeScript rewrite).
//
// Equivalent to bootstrap_argocd.py — runs on the ARC runner pod (Node.js present)
// or any environment where tsx + kubectl + aws CLI are available.
//
// Run: tsx bootstrap_argocd.ts [--dry-run]
// Or:  yarn workspace k8s-argocd-bootstrap bootstrap

import { parseArgs } from './helpers/config.js';
import { BootstrapLogger } from './helpers/logger.js';
import { log } from './helpers/runner.js';

import { createNamespace, resolveDeployKey, createRepoSecret, preserveArgocdSecret, provisionImageUpdaterWriteback } from './steps/namespace.js';
import { restoreArgocdSecret, installArgocd, createDefaultProject, configureArgocdServer, configureHealthChecks } from './steps/install.js';
import {
    applyRootApp,
    injectMonitoringHelmParams,
    seedPrometheusBasicAuth,
    seedEcrCredentials,
    provisionCrossplaneCredentials,
    provisionArcCrds,
    provisionArcGithubSecret,
    restoreTlsCert,
    applyCertManagerIssuer,
    provisionArgocdNotificationsSecret,
} from './steps/apps.js';
import { waitForArgocd, applyIngress, createArgocdIpAllowlist, configureWebhookSecret } from './steps/networking.js';
import {
    installArgocdCli,
    createCiBot,
    generateCiToken,
    setAdminPassword,
    backupTlsCert,
    backupArgocdSecretKey,
    printSummary,
} from './steps/auth.js';

const main = async (): Promise<void> => {
    const cfg = parseArgs();

    log('=== ArgoCD Bootstrap ===');
    log(`SSM prefix: ${cfg.ssmPrefix}`);
    log(`Region:     ${cfg.awsRegion}`);
    log(`ArgoCD dir: ${cfg.argocdDir}`);
    log(`Triggered:  ${new Date().toISOString()}`);
    log('');

    if (cfg.dryRun) {
        log('=== DRY RUN — no changes will be made ===');
        log(`  kubeconfig:   ${cfg.kubeconfig}`);
        log(`  argocd_dir:   ${cfg.argocdDir}`);
        log(`  cli_version:  ${cfg.argocdCliVersion}`);
        log(`  argo_timeout: ${cfg.argoTimeout}s`);
        log(`  environment:  ${cfg.env}`);
        log('');
    }

    const logger = new BootstrapLogger(cfg.ssmPrefix, cfg.awsRegion);

    await logger.step('create_namespace',         () => createNamespace(cfg));
    const deployKey   = await logger.step('resolve_deploy_key',    () => resolveDeployKey(cfg));
    await logger.step('create_repo_secret',        () => createRepoSecret(cfg, deployKey));
    await logger.step('provision_image_updater_writeback', () => provisionImageUpdaterWriteback(cfg));
    const signingKey  = await logger.step('preserve_argocd_secret', () => preserveArgocdSecret(cfg));
    await logger.step('install_argocd',            () => installArgocd(cfg));
    await logger.step('restore_argocd_secret',     () => restoreArgocdSecret(cfg, signingKey));
    await logger.step('create_default_project',    () => createDefaultProject(cfg));
    await logger.step('configure_argocd_server',   () => configureArgocdServer(cfg));
    await logger.step('configure_health_checks',   () => configureHealthChecks(cfg));
    // Apply ARC CRDs before applyRootApp so by the time ArgoCD reconciles
    // arc-controller (sync-wave 2), the actions.github.com/v1alpha1 schemas
    // are present and the controller pod doesn't crash-loop on startup.
    await logger.step('provision_arc_crds',        () => provisionArcCrds(cfg));
    await logger.step('apply_root_app',            () => applyRootApp(cfg));
    await logger.step('inject_monitoring_helm_params', () => injectMonitoringHelmParams(cfg));
    await logger.step('seed_prometheus_basic_auth', () => seedPrometheusBasicAuth(cfg));
    await logger.step('seed_ecr_credentials',      () => seedEcrCredentials(cfg));
    await logger.step('provision_crossplane_credentials', () => provisionCrossplaneCredentials(cfg));
    await logger.step('provision_arc_github_secret', () => provisionArcGithubSecret(cfg));
    await logger.step('restore_tls_cert',          () => restoreTlsCert(cfg));

    // Non-fatal: cert-manager CRD may not be ready — ArgoCD will reconcile
    try {
        await logger.step('apply_cert_manager_issuer', () => applyCertManagerIssuer(cfg));
    } catch (e) {
        log(`  ⚠ apply_cert_manager_issuer failed (non-fatal) — ArgoCD will reconcile: ${e}\n`);
    }

    await logger.step('wait_for_argocd', () => waitForArgocd(cfg));

    // Non-fatal: Traefik CRDs may not be ready — ArgoCD will reconcile
    try {
        await logger.step('apply_ingress', () => applyIngress(cfg));
    } catch (e) {
        log(`  ⚠ apply_ingress failed (non-fatal) — ArgoCD will reconcile: ${e}\n`);
    }

    // Non-fatal: same Traefik timing issue — ArgoCD will reconcile
    try {
        await logger.step('create_argocd_ip_allowlist', () => createArgocdIpAllowlist(cfg));
    } catch (e) {
        log(`  ⚠ create_argocd_ip_allowlist failed (non-fatal) — ArgoCD will reconcile: ${e}\n`);
    }

    await logger.step('configure_webhook_secret', () => configureWebhookSecret(cfg));

    // Non-fatal: GitHub App credentials may not exist on first bootstrap
    try {
        await logger.step('provision_argocd_notifications_secret', () => provisionArgocdNotificationsSecret(cfg));
    } catch (e) {
        log(`  ⚠ provision_argocd_notifications_secret failed (non-fatal) — ${e}\n`);
    }

    const cliInstalled = await logger.step('install_argocd_cli', () => installArgocdCli(cfg));

    if (cliInstalled) {
        try {
            await logger.step('create_ci_bot', () => createCiBot(cfg));
        } catch (e) {
            log(`  ⚠ create_ci_bot failed — non-fatal, will retry: ${e}`);
        }
        try {
            await logger.step('generate_ci_token', () => generateCiToken(cfg));
        } catch (e) {
            log(`  ⚠ generate_ci_token failed — non-fatal, will retry: ${e}`);
        }
    } else {
        logger.skip('create_ci_bot', 'ArgoCD CLI not available');
        logger.skip('generate_ci_token', 'ArgoCD CLI not available');
        log('=== Step 9-10: Skipping — ArgoCD CLI not available ===\n');
    }

    await logger.step('set_admin_password',       () => setAdminPassword(cfg));
    await logger.step('backup_tls_cert',          () => backupTlsCert(cfg));
    await logger.step('backup_argocd_secret_key', () => backupArgocdSecretKey(cfg));
    await logger.step('print_summary',            () => printSummary(cfg));
};

main().catch(err => {
    console.error('Bootstrap failed:', err);
    process.exit(1);
});
