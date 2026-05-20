# Runbook — ArgoCD serves stale manifests after an image bump

## Symptom

An app's desired image tag was updated (either by `argocd-image-updater`
committing a new tag, or by a manual edit to the values file), but ArgoCD
keeps reporting the **old** image in the rendered manifest:

```bash
kubectl get application <app> -n argocd \
  -o jsonpath='{.status.summary.images}'
# → still shows the old tag
```

`argocd app diff` shows no drift. `argocd.argoproj.io/refresh=hard` and
restarting `argocd-repo-server` **do not** clear it.

## Why it happens

Two caches sit between Git and the reconciled cluster:

```text
Git repo ──► argocd-repo-server ──► argocd-application-controller ──► live cluster
              (manifest cache)        (resource state cache)
```

`argocd.argoproj.io/refresh=hard` and a repo-server restart only flush
the **first** cache. The application-controller has its own resource
cache, keyed by `controller.repo.cache.expiration` (default **24h**).
Until that TTL elapses or the controller restarts, it serves the
previously-rendered manifest from memory.

The chart now sets `reposerver.repo.cache.expiration: 30m` (matches
`argocd-image-updater`'s default poll interval). This key maps to the
`ARGOCD_REPO_CACHE_EXPIRATION` env var on the `argocd-repo-server` Pod
— the Redis-backed rendered-manifest cache. A stuck render
self-clears within 30 minutes without operator action. The runbook
below covers the case where you need to bust it **now**.

> ℹ️ The natural-sounding key `controller.repo.cache.expiration` is
> **not** wired into any Pod's env in argo-cd 7.7.5 — setting it has
> no effect. Always grep the live deployment for `ARGOCD_REPO_CACHE`
> to confirm the cache key really took.

## Bust-cache procedure (~30 seconds, ~5 s reconcile pause)

Run the helper:

```bash
./scripts/argocd-bust-cache.sh <app-name>
```

Or do it manually:

```bash
# 1. Restart the application-controller (clears its resource cache).
kubectl rollout restart statefulset argocd-application-controller -n argocd
kubectl rollout status   statefulset argocd-application-controller -n argocd --timeout=120s

# 2. Hard-refresh the affected Application so the repo-server re-renders
#    from Git on the next reconcile loop.
kubectl patch application <app-name> -n argocd --type merge \
  -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}'

# 3. Watch the sync converge.
kubectl get application <app-name> -n argocd -w \
  -o jsonpath='{.status.sync.status}/{.status.health.status}{"\n"}'
```

Restarting `argocd-repo-server` is **not** required if you only want to
clear the controller's stale view — it's the second cache that's the
issue. Restart repo-server only if `argocd app diff` itself returns
stale rendered output.

## Diagnose before busting

Check which cache is stuck before bouncing pods:

```bash
# What image does the rendered manifest say?
kubectl get application <app-name> -n argocd \
  -o jsonpath='{.status.summary.images}'

# What image does Git say (rendered locally, no caches)?
helm template <release> charts/<path>/chart \
  -f charts/<path>/chart/values.yaml \
  -f charts/<path>/chart/values-development.yaml \
  | grep -A1 'image:'

# If they disagree → controller cache is stuck. Run the bust-cache helper.
# If they agree but the live cluster has a different image → it's a sync
#   problem, not a cache problem (check `argocd app sync` errors instead).
```

## When the symptom recurs more than once

The 30m TTL is the primary defence; recurrence means image-updater is
polling faster than the cache TTL, or a different cache layer is at
play. Cross-check:

- `kubectl logs -n argocd deploy/argocd-image-updater --tail=200` for
  the actual write-back commit time.
- `controller.repo.cache.expiration` env on the
  `argocd-application-controller` Pod
  (`kubectl exec -n argocd argocd-application-controller-0 -- env`).
- ArgoCD's Redis Pod (`argocd-redis`) — if it OOMed or lost data, the
  controller may serve from an inconsistent in-memory snapshot.
