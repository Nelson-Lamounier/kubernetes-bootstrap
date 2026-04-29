---
title: ESO ExternalSecret Not Syncing
type: troubleshooting
tags: [external-secrets, kubernetes, aws, ssm, secrets-manager, debugging, argocd, iam]
sources:
  - argocd-apps/external-secrets.yaml
  - argocd-apps/external-secrets-config.yaml
  - charts/admin-api/external-secrets/admin-api-bedrock.yaml
  - charts/admin-api/external-secrets/admin-api-secrets.yaml
  - charts/platform-rds/external-secrets/rds-credentials.yaml
  - charts/external-secrets-config/cluster-secret-store.yaml
created: 2026-04-28
updated: 2026-04-28
---

# ESO ExternalSecret Not Syncing

Diagnosis and resolution for ExternalSecrets that do not produce a Kubernetes Secret — covering the intentional absent-until-ready pattern, missing SSM parameters, Secrets Manager permission failures, webhook unavailability, and wave-ordering races during initial cluster bootstrap.

## First: check ExternalSecret status

Every diagnosis starts here:

```bash
# All ExternalSecrets across all namespaces
kubectl get externalsecrets -A

# Detailed conditions on a specific ExternalSecret
kubectl describe externalsecret <name> -n <namespace>
```

The `STATUS` column shows `SecretSynced` (healthy) or `SecretSyncedError`. The `describe` output includes a `Conditions` block with the error message and last sync timestamp.

## Scenario 1: intentional absent-until-ready (not a bug)

**Symptom:** `admin-api-bedrock` in the `admin-api` namespace shows `SecretSyncedError`. The `admin-api` pods are running and serving traffic — asset-related routes return HTTP 503.

**Cause:** This is by design. The `admin-api-bedrock` ExternalSecret ([`charts/admin-api/external-secrets/admin-api-bedrock.yaml`](../../charts/admin-api/external-secrets/admin-api-bedrock.yaml)) reads SSM key `/bedrock-dev/assets-bucket-name`, which is published by the `ai-content-stack` in the `ai-applications` repository. Until that stack deploys, the key does not exist in SSM.

From the ExternalSecret comment:

```
# Until the SSM key lands, ESO leaves the Secret absent and admin-api
# treats the missing value via the UNSET_BUCKET_SENTINEL pattern:
# routes that need S3 return HTTP 503 instead of crashing.
```

**Resolution:** No action needed if the AI stack has not yet been deployed. Once `ai-content-stack` deploys and publishes the SSM key, ESO will pick it up within 5 minutes and create the Secret automatically. Stakater Reloader will then roll the `admin-api` Rollout and the asset routes will go live.

If the AI stack has been deployed and the key should exist, proceed to Scenario 2.

## Scenario 2: SSM parameter missing or wrong path

**Symptom:** ExternalSecret condition shows an error similar to `ParameterNotFound` or `parameter does not exist`. The target Kubernetes Secret does not exist.

**Cause:** The SSM parameter path in `remoteRef.key` does not exist in the `eu-west-1` region. Common causes:
- The CDK stack that publishes this parameter has not been deployed yet
- The environment suffix in the path is wrong (e.g. using `/nextjs/production/` instead of `/nextjs/development/`)
- The parameter was renamed or deleted

**Diagnosis:**

```bash
# Describe to see the exact error message
kubectl describe externalsecret <name> -n <namespace>
# Look for the Conditions block — it includes the AWS error response

# Verify the ClusterSecretStore is healthy
kubectl get clustersecretstore aws-ssm -o wide
```

**Resolution — verify the SSM path exists:**

```bash
# Check via AWS CLI (requires ssm:GetParameter on the node or your profile)
aws ssm get-parameter --name "/k8s/development/monitoring/prometheus-basic-auth" --region eu-west-1
```

If the parameter does not exist in AWS, the publishing CDK stack must deploy first. ESO polls on `refreshInterval` — once the parameter exists, the next poll cycle creates the Secret automatically. No ArgoCD re-sync needed.

If the parameter path is wrong, correct the `remoteRef.key` in the ExternalSecret manifest and commit to Git. ArgoCD will apply the updated manifest and ESO will re-evaluate on the next refresh cycle.

## Scenario 3: Secrets Manager permission denied

**Symptom:** ExternalSecret using `secretStoreRef.name: aws-secretsmanager` shows an `AccessDeniedException` or `ResourceNotFoundException` condition error.

**Cause:** ESO inherits the control-plane EC2 instance profile. The IAM policy on that profile grants `secretsmanager:GetSecretValue` scoped to `arn:aws:secretsmanager:eu-west-1:{account}:secret:bedrock-*` ([`charts/external-secrets-config/secretsmanager-store.yaml`](../../charts/external-secrets-config/secretsmanager-store.yaml)). A secret outside this ARN prefix will be denied even if the name seems correct.

Affected ExternalSecrets: all `platform-rds-credentials` variants across `admin-api`, `article-pipeline`, `ingestion`, `job-strategist`, `platform-rds` namespaces — these all read `k8s-development/platform-rds/credentials`.

**Diagnosis:**

```bash
kubectl describe externalsecret platform-rds-credentials -n platform
# Check: is the error AccessDeniedException or ResourceNotFoundException?
```

**Resolution for `AccessDeniedException`:** The instance profile policy is too narrow. Check that the CDK stack provisioned the IAM policy correctly. The secret ARN must fall within the `bedrock-*` or `k8s-development/*` prefix scope (verify the actual scope from the CDK stack outputs or the IAM console).

**Resolution for `ResourceNotFoundException`:** The Secrets Manager secret does not exist. For RDS credentials, verify the CDK `PlatformRdsStack` has been deployed — CDK's `Credentials.fromGeneratedSecret` creates the secret during stack provisioning.

## Scenario 4: ClusterSecretStore not ready (wave ordering race)

**Symptom:** ExternalSecrets created during initial cluster bootstrap fail with `NoSecretStoreFound` or `ClusterSecretStore not found: aws-ssm`. This typically only occurs during the first sync of a new cluster.

**Cause:** The wave ordering between ArgoCD Applications:
- Wave 0: ESO Helm chart (registers CRDs)
- Wave 1: `external-secrets-config` (creates `aws-ssm` and `aws-secretsmanager` ClusterSecretStores)
- Wave 2: `-secrets` Applications (create ExternalSecret resources)

If wave 2 syncs before wave 1 completes, ExternalSecrets are applied before the ClusterSecretStores exist. ArgoCD's wave gating should prevent this, but a failed wave 1 sync (e.g. the `ClusterSecretStore` CRD not yet registered when wave 1 starts) can cause the sequence to desynchronize.

**Diagnosis:**

```bash
# Verify the ClusterSecretStores exist
kubectl get clustersecretstores

# Verify the ESO CRDs are registered
kubectl get crd | grep external-secrets.io

# Check ESO controller is running
kubectl get pods -n external-secrets
```

**Resolution:** If the ClusterSecretStores are missing, trigger a manual ArgoCD sync of `external-secrets-config` (wave 1 Application). Once both `aws-ssm` and `aws-secretsmanager` exist, trigger a sync of the failing `-secrets` Applications. ESO will immediately process the queued ExternalSecrets.

## Scenario 5: ESO webhook unavailable

**Symptom:** `kubectl apply` of an ExternalSecret manifest fails with a webhook timeout or `failed calling webhook: ... connection refused`. This surfaces as ArgoCD sync failure for any `-secrets` Application.

**Cause:** The ESO webhook pod is not running. All three ESO components (controller, webhook, certController) run on the control-plane node ([`argocd-apps/external-secrets.yaml`](../../argocd-apps/external-secrets.yaml)). If the control-plane node is restarting or the ESO pods were evicted, the admission webhook is unavailable.

**Diagnosis:**

```bash
kubectl get pods -n external-secrets
# Look for: external-secrets (controller), external-secrets-webhook, external-secrets-cert-controller

kubectl describe pod -n external-secrets -l app.kubernetes.io/name=external-secrets-webhook
```

**Resolution:** Wait for the control-plane node to recover and the webhook pod to reach `Running`. ArgoCD will retry the failed sync automatically (`retry.limit: 3` in the `-secrets` Applications). If the webhook pod is stuck in `CrashLoopBackOff`, check its logs:

```bash
kubectl logs -n external-secrets -l app.kubernetes.io/name=external-secrets-webhook --tail=50
```

The cert-controller manages the webhook's TLS certificate. If the cert has expired or was deleted, the cert-controller should regenerate it automatically — look for cert-controller logs showing certificate renewal activity.

## Scenario 6: Secret exists but workload has stale values

**Symptom:** The Kubernetes Secret shows updated values (`kubectl get secret <name> -o yaml`), but the running pod's env vars are stale (e.g. old RDS password causing authentication failures).

**Cause:** ESO has refreshed the Secret, but the pod was not restarted. Env vars are frozen at pod start. Stakater Reloader triggers a rolling restart only for pods carrying the `secret.reloader.stakater.com/reload` annotation that lists the Secret.

Workloads with Reloader annotations in this cluster: `admin-api` Rollout (watches `admin-api-secrets`, `admin-api-bedrock`, `admin-api-job-images`, `platform-rds-credentials`), `public-api` Deployment (watches `public-api-core`, `public-api-bedrock`, `public-api-strategist`).

**Diagnosis:**

```bash
# Verify the Secret has the expected content
kubectl get secret platform-rds-credentials -n platform -o jsonpath='{.data.PGPASSWORD}' | base64 -d

# Check if Reloader is running
kubectl get pods -n reloader

# Check if the workload has the Reloader annotation
kubectl get rollout admin-api -n admin-api -o jsonpath='{.spec.template.metadata.annotations}'
```

**Resolution:** For workloads with Reloader annotations, wait for the rolling restart (Reloader reacts within seconds of the Secret change). For workloads without Reloader, a manual rollout restart is required:

```bash
kubectl rollout restart deployment <name> -n <namespace>
# or for Argo Rollouts:
kubectl argo rollouts restart <name> -n <namespace>
```

## Quick reference: ExternalSecret to Secret mapping

Key ExternalSecrets and the Kubernetes Secrets they produce:

| ExternalSecret | Namespace | Store | Produces Secret | RefreshInterval |
|----------------|-----------|-------|-----------------|----------------|
| `admin-api-secrets` | `admin-api` | `aws-ssm` | `admin-api-secrets` | 1h |
| `admin-api-bedrock` | `admin-api` | `aws-ssm` | `admin-api-bedrock` | 5m |
| `platform-rds-credentials` | `platform` | `aws-secretsmanager` | `platform-rds-credentials` | 15m |
| `nextjs-config` | `nextjs-app` | `aws-ssm` | `nextjs-config` | 1h |
| `admin-ip-allowlist` | `monitoring` | `aws-ssm` | `admin-ip-allowlist` | 5m |
| `prometheus-basic-auth-secret` | `monitoring` | `aws-ssm` | `prometheus-basic-auth-secret` | 1h |

## Related

- [External Secrets AWS integration](../concepts/external-secrets-aws-integration.md) — ambient IAM auth, store selection, cross-stack event-driven pattern
- [ESO secret management](../concepts/eso-secret-management.md) — ExternalSecret schema, `-secrets` Application wave ordering, deletion policies
- [Reloader integration](../concepts/reloader-integration.md) — how Reloader handles the gap between Secret refresh and running pod env vars
- [ArgoCD sync failures](argocd-sync-failures.md) — ExternalSecret CRD ordering races during initial bootstrap

<!--
Evidence trail (auto-generated):
- Source: charts/admin-api/external-secrets/admin-api-bedrock.yaml (read 2026-04-28 — UNSET_BUCKET_SENTINEL pattern, intentional absent-until-ready, 5m refresh, /bedrock-dev/assets-bucket-name SSM path)
- Source: charts/admin-api/external-secrets/admin-api-secrets.yaml (read 2026-04-28 — "fails fast at startup if any of these is missing" comment, required/optional split rationale)
- Source: charts/platform-rds/external-secrets/rds-credentials.yaml (read 2026-04-28 — aws-secretsmanager store, 15m refresh, k8s-development/platform-rds/credentials path)
- Source: charts/external-secrets-config/cluster-secret-store.yaml (read 2026-04-28 — aws-ssm, IAM scope ssm:GetParameter k8s/*, eu-west-1)
- Source: charts/external-secrets-config/secretsmanager-store.yaml (read 2026-04-28 — aws-secretsmanager, IAM scope bedrock-*)
- Source: argocd-apps/external-secrets.yaml (read 2026-04-28 — wave 0, control-plane node placement, retry.limit 3)
- Source: argocd-apps/external-secrets-config.yaml (read 2026-04-28 — wave 1)
- Source: grep of argocd-apps/*-secrets.yaml (read 2026-04-28 — wave 2 for all -secrets Applications)
- Source: argocd-apps/admin-api.yaml (read 2026-04-28 — Reloader annotation list on admin-api Rollout)
- Source: charts/public-api/chart/templates/deployment.yaml (read 2026-04-28 — Reloader annotation list on public-api Deployment)
- Generated: 2026-04-28
-->
