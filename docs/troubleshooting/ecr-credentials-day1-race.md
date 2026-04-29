---
title: ECR Credentials 401 Race on Day-1 Cluster Cold Start
type: troubleshooting
tags: [ecr, argocd, image-updater, kubernetes, bootstrap, day-1]
sources:
  - sm-a/argocd/steps/apps.ts
  - sm-a/argocd/steps/auth.ts
created: 2026-04-29
updated: 2026-04-29
---

# ECR Credentials 401 Race on Day-1 Cluster Cold Start

## Symptom

On a freshly bootstrapped cluster, the ArgoCD Image Updater produces `401 Unauthorized` errors when polling ECR for new image tags. The errors persist for up to 6 hours after bootstrap completes. Separately, newly deployed pods that reference ECR images may stay in `ImagePullBackOff` until the first ECR token refresh runs.

```
time="..." level=warning msg="Failed to list tags for image" alias=nextjs \
  image=<account>.dkr.ecr.eu-west-1.amazonaws.com/nextjs \
  error="401 Unauthorized"
```

## Root cause

### Primary: ecr-credentials Secret missing until CronJob runs

The `ecr-credentials` Kubernetes Secret (consumed by ArgoCD Image Updater) is created by a CronJob that refreshes ECR tokens on a regular interval. On a fresh cluster, the CronJob has not run yet — the Secret does not exist — so Image Updater has no credentials when it makes its first poll (which happens within minutes of ArgoCD becoming healthy).

The cold-start gap can be up to 6 hours if the CronJob interval is configured at that period.

### Secondary: ArgoCD server rejects ci-bot token after argocd-cm patch

When the bootstrap patches `argocd-cm` to add the `ci-bot` account (`accounts.ci-bot: apiKey`), the ArgoCD server does not reload the ConfigMap without a restart. If the verify job runs before the server restarts, it authenticates with the ci-bot token and receives HTTP 401 — the server's in-memory config still does not include the account.

A `sleep 5` between patch and verify was insufficient; the fix requires `kubectl rollout restart` plus an explicit `kubectl rollout status` wait.

Sources:
- `sm-a/argocd/steps/apps.ts` lines 153–194 (Step 5c — `Seeding ECR Credentials (Day-1)`)
- `sm-a/argocd/steps/auth.ts` lines 111–155 (`createCiBot` with rollout restart)
- Commit `3e9fd37` (`fix(bootstrap): seed ECR credentials on Day-1 and fix ArgoCD 401 race condition`)

## How to diagnose

```bash
# 1. Check whether ecr-credentials Secret exists
kubectl get secret ecr-credentials -n argocd 2>/dev/null \
  && echo "SECRET EXISTS" || echo "SECRET MISSING — cold-start race"

# 2. Check Image Updater logs for 401 errors
kubectl logs -n argocd \
  -l app.kubernetes.io/name=argocd-image-updater \
  --tail=50 | grep -i "401\|unauthorized\|failed to list"

# 3. Manually test ECR token validity
aws ecr get-login-password --region eu-west-1 \
  | docker login --username AWS --password-stdin \
    <account>.dkr.ecr.eu-west-1.amazonaws.com \
  && echo "ECR auth OK" || echo "ECR auth FAILED"

# 4. Check if the ci-bot 401 is the issue (secondary symptom)
kubectl get configmap argocd-cm -n argocd \
  -o jsonpath='{.data.accounts\.ci-bot}'
# Expected: "apiKey" — if empty, the patch did not apply

# 5. Check argocd-server rollout state
kubectl rollout status deployment/argocd-server -n argocd --timeout=10s
```

## How to fix

### Primary fix — seed ECR credentials manually

This replicates what `Step 5c` does during bootstrap:

```bash
# Get a fresh ECR token
ECR_TOKEN=$(aws ecr get-login-password --region eu-west-1)
REGISTRY="<account>.dkr.ecr.eu-west-1.amazonaws.com"
AUTH_STR=$(echo -n "AWS:${ECR_TOKEN}" | base64 -w0)
DOCKER_CONFIG=$(printf '{"auths":{"%s":{"auth":"%s"}}}' "$REGISTRY" "$AUTH_STR")

# Create or update the ecr-credentials Secret
kubectl create secret generic ecr-credentials \
  --from-literal=.dockerconfigjson="$DOCKER_CONFIG" \
  --type=kubernetes.io/dockerconfigjson \
  -n argocd \
  --dry-run=client -o yaml | kubectl apply -f -

# Restart Image Updater to pick up the new credentials
kubectl rollout restart deployment/argocd-image-updater -n argocd
kubectl rollout status deployment/argocd-image-updater -n argocd --timeout=120s
```

### Secondary fix — reload ArgoCD server after argocd-cm patch

If ci-bot tokens are rejected with HTTP 401 after the bootstrap patched `argocd-cm`:

```bash
# Trigger a rolling restart and wait for completion
kubectl rollout restart deployment/argocd-server -n argocd
kubectl rollout status deployment/argocd-server -n argocd --timeout=300s

# Verify the server now recognises the ci-bot account
argocd account list --server localhost:8080 --insecure | grep ci-bot
```

This mirrors the fix in `sm-a/argocd/steps/auth.ts` `createCiBot()` — the function now explicitly restarts the server and waits for the rollout before attempting to generate a ci-bot token.

### Force the ECR token refresh CronJob to run immediately

If the CronJob exists but hasn't fired yet:

```bash
kubectl get cronjob -n argocd | grep ecr
kubectl create job --from=cronjob/<ecr-refresh-cronjob-name> ecr-refresh-manual -n argocd
kubectl wait --for=condition=complete job/ecr-refresh-manual -n argocd --timeout=60s
kubectl delete job ecr-refresh-manual -n argocd
```

## How to prevent

`Step 5c` in `sm-a/argocd/steps/apps.ts` seeds the `ecr-credentials` Secret during the Day-1 bootstrap sequence, before ArgoCD Image Updater makes its first poll. This eliminates the cold-start gap entirely.

The fix was added in commit `3e9fd37`. If the bootstrap is re-run from a state where the Secret already exists (subsequent boots), the `kubectl apply` is idempotent — it updates the token to a fresh value.

The `createCiBot` function in `sm-a/argocd/steps/auth.ts` unconditionally calls `kubectl rollout restart deployment/argocd-server` after patching `argocd-cm`, then blocks on `kubectl rollout status` before generating the ci-bot token. A `hasSchedulableWorkers()` guard skips the restart on a control-plane-only cluster (no schedulable workers means all ArgoCD pods are Pending; the rollout would block until SSM kills the bootstrap).

## Related

- [ESO ExternalSecret Not Syncing](eso-external-secret-not-syncing.md) — related Day-1 secret availability issue
- [ArgoCD Sync Failures](argocd-sync-failures.md) — ArgoCD Image Updater write-back, token freshness
- [Kubernetes Bootstrap Orchestrator](../projects/kubernetes-bootstrap-orchestrator.md) — ArgoCD bootstrap 31-step sequence, Step 5c ECR credential seeding

<!--
Evidence trail (auto-generated):
- Source: sm-a/argocd/steps/apps.ts (read 2026-04-29 — lines 153-194, Step 5c seeding ECR credentials, kubectl apply YAML, log messages)
- Source: sm-a/argocd/steps/auth.ts (read 2026-04-29 — createCiBot lines 67-156, kubectl rollout restart, hasSchedulableWorkers guard, argocd-cm patch)
- Commit: 3e9fd37 fix(bootstrap): seed ECR credentials on Day-1 and fix ArgoCD 401 race condition
- Generated: 2026-04-29
-->
