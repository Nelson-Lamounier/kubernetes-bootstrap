---
title: ArgoCD Sync Failures
type: troubleshooting
tags: [argocd, gitops, kubernetes, debugging, image-updater, external-secrets, hook-jobs, sync-waves]
sources:
  - argocd-apps/argocd-image-updater.yaml
  - argocd-apps/admin-api.yaml
  - argocd-apps/external-secrets.yaml
  - sm-a/argocd/bootstrap_argocd.ts
  - charts/monitoring/chart/templates/traefik/allowlist-patcher.yaml
  - docs/decisions/postsync-patcher-pattern.md
created: 2026-04-28
updated: 2026-04-28
---

# ArgoCD Sync Failures

Diagnosis and remediation for common ArgoCD sync failure patterns in this cluster — PostSync hook Job blockage, CRD ordering races, Image Updater write-back conflicts, ExternalSecret resolution failures, and the `RespectIgnoreDifferences` footgun.

## PostSync hook Job blocking the next sync

**Symptom:** An Application is stuck in `Progressing` or `Running` state. A sync triggered after the previous one completed shows no progress. ArgoCD reports `Job already exists`.

**Root cause:** A PostSync hook Job from the previous sync run was not deleted before the next sync started.

The `monitoring` Application uses a PostSync Job (`allowlist-patcher`) with the annotation:

```yaml
argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
```

`BeforeHookCreation` means ArgoCD deletes the _previous_ Job run before creating the new one. Without this policy (or if `BeforeHookCreation` is replaced with `HookSucceeded` or omitted), completed Jobs accumulate. When the next sync tries to create the same Job, Kubernetes rejects the create because the name already exists.

**Fix:**
```bash
# Identify the stuck hook Job
kubectl get jobs -n monitoring -l argocd.argoproj.io/hook=PostSync

# Delete it manually to unblock the sync
kubectl delete job allowlist-patcher -n monitoring

# Re-trigger the sync
argocd app sync monitoring
```

**Prevention:** Every PostSync hook Job in this repo uses `BeforeHookCreation`. If adding a new hook Job, always include this policy.

---

## CRD ordering race: wave-N resource applied before its CRD exists

**Symptom:** An Application in wave 2 or higher fails with `no matches for kind "X" in version "Y"` or `unable to recognize ... no kind is registered`.

**Root cause:** The wave-0 Application that installs the CRD-bearing chart has not yet reached `Healthy` before the wave-N Application attempts to apply a custom resource of that type.

**Known instance — ARC CRDs:** The `arc-runners` Application (wave 3) creates `RunnerScaleSet` resources, which require CRDs from `arc-controller` (wave 2). However, even with wave ordering, there is a race between the `arc-controller` ArgoCD Application becoming `Healthy` and the `actions.github.com/v1alpha1` CRDs actually being registered in the Kubernetes API.

**Bootstrap-time fix:** `bootstrap_argocd.ts` applies ARC CRDs imperatively at step 11 (`provision_arc_crds`) before applying `platform-root-app.yaml` at step 12 ([`sm-a/argocd/bootstrap_argocd.ts`](../../sm-a/argocd/bootstrap_argocd.ts), lines 72–76):

```typescript
// Apply ARC CRDs before applyRootApp so by the time ArgoCD reconciles
// arc-controller (wave 2) and arc-runners (wave 3), the CRDs already exist
await logger.step('provision_arc_crds', () => provisionArcCrds(cfg));
await logger.step('apply_root_app',     () => applyRootApp(cfg));
```

**At steady-state:** If `arc-runners` drifts out of sync and needs a manual re-sync, run ArgoCD sync on `arc-controller` first, wait for it to reach `Healthy`, then sync `arc-runners`.

**General pattern:** For any `no kind registered` error after a fresh install, check whether the CRD-installing chart is in a lower sync wave. If it is, wait for it to reach `Healthy` and then re-sync the failing Application. ArgoCD's automated retry will converge; manual intervention speeds this up.

---

## Image Updater write-back conflict: selfHeal reverting tag updates

**Symptom:** ArgoCD Image Updater detects a new ECR image, writes `.argocd-source-<app>.yaml` to Git, but the Application immediately reverts to the previous tag. The Image Updater log shows repeated write-back attempts. The Application oscillates between the old and new tag.

**Root cause:** ArgoCD's `selfHeal: true` normally reconverges the live cluster to Git state. With Image Updater's write-back, Git _is_ the source of truth — Updater commits the new tag to Git, and ArgoCD should then deploy it. The conflict occurs when:

1. Image Updater writes `.argocd-source-<app>.yaml` to the `develop` branch.
2. ArgoCD detects the Git change and begins a sync.
3. The sync uses a stale cached revision of the Application source (not the latest Updater commit).
4. selfHeal reverts the Helm values to the stale revision.

**ECR token expiry** is a separate trigger: `argocd-image-updater.yaml` sets `credsexpire: 4h` for ECR credentials ([`argocd-apps/argocd-image-updater.yaml`](../../argocd-apps/argocd-image-updater.yaml)). The ECR token CronJob (`ecr-token-refresh`) refreshes every 6 hours. If the CronJob fails or the token is not refreshed before the `credsexpire` window, Image Updater cannot poll ECR and stops updating tags. Symptom: no new tags detected despite new ECR pushes.

**Diagnosis:**
```bash
# Check Image Updater logs for write-back errors
kubectl logs -n argocd -l app.kubernetes.io/name=argocd-image-updater --tail=100

# Check ECR token freshness
kubectl get secret ecr-credentials -n argocd -o jsonpath='{.metadata.creationTimestamp}'

# Check the write-back file in Git
git log --oneline -- .argocd-source-admin-api.yaml
```

**Fix for stale cache:**
```bash
# Force ArgoCD to re-fetch the latest Git revision
argocd app get admin-api --refresh
argocd app sync admin-api
```

**Fix for expired ECR token:**
```bash
# Force the ECR token refresh CronJob to run now
kubectl create job -n argocd --from=cronjob/ecr-token-refresh ecr-token-refresh-manual
```

Image Updater is configured for three Applications: `admin-api`, `nextjs`, `start-admin`, and `public-api`. All use `write-back-method: "git:secret:argocd/argocd-image-updater-writeback-key"` — the write-enabled deploy key provisioned during bootstrap.

---

## ExternalSecret not resolving: workload Secret missing at pod start

**Symptom:** A wave-3 workload pod is in `CrashLoopBackOff` or fails to schedule with `secret "X" not found`. The ESO `ExternalSecret` resource shows `SecretSyncedError` or `NotReady`.

**Root cause — wave ordering race:** The `-secrets` Application (wave 2) was not `Healthy` before the workload Application (wave 3) started. ESO may still be reconciling the ExternalSecret when the workload pod starts.

ArgoCD sync waves guarantee that wave-2 Applications reach `Healthy` before wave-3 Applications begin syncing. `Healthy` for an ArgoCD Application means all its managed resources are healthy — including the `ExternalSecret` resources. ESO marks an ExternalSecret as `Ready` only after the Kubernetes Secret has been created. So if wave ordering is respected, the Secret should exist before wave-3 pods start.

**If the race is still observed:** Check whether ESO itself reached `Ready` before the ExternalSecret was applied. ESO runs at wave 0; its webhook must be fully registered before any `ExternalSecret` resource is applied. If ESO's webhook pod was slow to start, ArgoCD may have applied the ExternalSecret manifests before the webhook was ready, causing them to be silently rejected.

```bash
# Check ESO webhook status
kubectl get pods -n external-secrets

# Check ExternalSecret status
kubectl get externalsecret -n <namespace>
kubectl describe externalsecret <name> -n <namespace>

# Check if the target Secret was created
kubectl get secret <secret-name> -n <namespace>
```

**Root cause — IAM permission missing:** ESO uses the control-plane node's EC2 instance profile. If the IAM policy for `ssm:GetParameter` or `secretsmanager:GetSecretValue` on the required ARN is missing, ESO will log `AccessDenied` and the ExternalSecret will show `SecretSyncedError`.

```bash
# View ESO controller logs for IAM errors
kubectl logs -n external-secrets -l app.kubernetes.io/name=external-secrets --tail=50
```

**Root cause — SSM parameter path mismatch:** The `remoteRef.key` in the ExternalSecret does not match the actual SSM parameter path. ESO returns `ParameterNotFound` and the Secret is not created.

```bash
# Verify the SSM parameter exists (requires AWS CLI)
aws ssm get-parameter --name "/k8s/development/grafana-admin-password"
```

---

## Application perpetually OutOfSync: the RespectIgnoreDifferences footgun

**Symptom:** An Application shows `OutOfSync` despite `ignoreDifferences` being configured. Every selfHeal sync re-applies a field that a PostSync Job or runtime controller modified.

**Root cause:** `ignoreDifferences` alone suppresses the _diff display_ but does not prevent the sync from writing the Helm-rendered value to the cluster. The second required piece is `RespectIgnoreDifferences=true` in `syncOptions`.

Without `RespectIgnoreDifferences=true`:
- ArgoCD's diff engine ignores the field (app appears Synced or not OutOfSync)
- BUT during a sync, ArgoCD still applies the Helm-rendered value (empty `sourceRange: []`)
- The PostSync Job's patch is overwritten seconds after it completes
- The Middleware's `ipAllowList.sourceRange` stays empty — silently allowing all traffic

```yaml
# monitoring Application — both halves required
ignoreDifferences:
  - group: traefik.io
    kind: Middleware
    name: admin-ip-allowlist
    jsonPointers:
      - /spec/ipAllowList/sourceRange
syncPolicy:
  syncOptions:
    - RespectIgnoreDifferences=true   # prevents sync from writing the field
```

**Diagnosis:**
```bash
# Check if the Middleware sourceRange is actually populated
kubectl get middleware admin-ip-allowlist -n monitoring -o jsonpath='{.spec.ipAllowList.sourceRange}'

# Check Application sync options
argocd app get monitoring -o json | jq '.spec.syncPolicy.syncOptions'

# Check ignoreDifferences config
argocd app get monitoring -o json | jq '.spec.ignoreDifferences'
```

**If `sourceRange` is empty:** Both `ignoreDifferences` and `RespectIgnoreDifferences=true` must be present. If either is missing, the PostSync patcher is being silently reverted. Add the missing half and trigger a manual sync — the PostSync Job will fire and populate the allowlist.

For the full analysis of this failure mode: [PostSync patcher pattern](../decisions/postsync-patcher-pattern.md).

---

## Application stuck in Progressing: Blue/Green Rollout not promoting

**Symptom:** An Application (`admin-api`, `nextjs`, `start-admin`, `public-api`) is stuck in `Progressing`. The ArgoCD Application health is `Progressing` but the `Rollout` resource shows the new revision available with zero errors.

**Root cause:** Argo Rollouts Blue/Green deployments pause at the `postPromotionAnalysis` or `autoPromotionEnabled: false` step. ArgoCD reports `Progressing` until the Rollout completes promotion.

```bash
# Check Rollout status
kubectl argo rollouts get rollout <app-name> -n <namespace>

# Manually promote if autoPromotion is disabled
kubectl argo rollouts promote <rollout-name> -n <namespace>
```

**Root cause — Rollout controller not running:** If `argo-rollouts` (wave 3) failed to deploy, no Rollouts controller exists and all `Rollout` resources stay `Progressing` indefinitely.

```bash
kubectl get pods -n argo-rollouts
```

---

## Related

- [ArgoCD GitOps architecture](../concepts/argocd-gitops-architecture.md) — sync wave ordering and why the -secrets pattern prevents most ExternalSecret races
- [PostSync patcher pattern](../decisions/postsync-patcher-pattern.md) — full `ignoreDifferences` + `RespectIgnoreDifferences` analysis with failure mode table
- [ESO secret management](../concepts/eso-secret-management.md) — ExternalSecret schema, refresh intervals, IAM requirements
- [ArgoCD installation runbook](../runbooks/argocd-installation.md) — ARC CRD ordering constraint and bootstrap step sequence

<!--
Evidence trail (auto-generated):
- Source: argocd-apps/argocd-image-updater.yaml (read 2026-04-28 — chart 0.11.0, credsexpire: 4h, ECR registry config, grpcWeb connection to argocd-server)
- Source: argocd-apps/admin-api.yaml (read 2026-04-28 — Image Updater annotations lines 69-75, write-back-method git:secret:argocd/argocd-image-updater-writeback-key, allow-tags regexp)
- Source: sm-a/argocd/bootstrap_argocd.ts (read 2026-04-28 — provision_arc_crds step 11 at line 75, apply_root_app at line 76, comments lines 72-74)
- Source: docs/decisions/postsync-patcher-pattern.md (2026-04-28 — ignoreDifferences+RespectIgnoreDifferences analysis, silent failure table, BeforeHookCreation rationale)
- Source: argocd-apps/ (surveyed 2026-04-28 — wave ordering table, -secrets Applications wave 2, workloads wave 3+)
- Generated: 2026-04-28
-->
