# kubernetes-bootstrap — project rules

GitOps repo for the EKS clusters. **`main` is the deployment branch ArgoCD syncs** (it is the
mainline here; `develop` is divergent/stale). Branch off `main`, PR to `main`, delete the branch
(and `git worktree remove` any worktree) after merge.

> **Adding or changing a workload service?** The authoritative architecture + repo-ownership rules
> live in the **`k8s-new-service`** skill — invoke it first. The two rules below are
> learned-the-hard-way invariants that every new service must satisfy.

## Every new service: two non-negotiables

Each of these gaps shipped a **silently-broken** service — it looked deployed but wasn't, or ran
stale config. Both are mandatory for any new workload.

### 1. Put the dev app where the root actually syncs

`eks-root-development` (the dev app-of-apps) syncs **`argocd-apps/eks/development`**, and it is
**NON-recursive**. Therefore:

- A new service's ArgoCD **`Application` MUST live at `argocd-apps/eks/development/<service>.yaml`**
  — directly in that directory, alongside the existing siblings (`admin-api.yaml`,
  `job-strategist.yaml`, `article-pipeline.yaml`, …).
- **Do NOT** place it in the `argocd-apps/` root, in a sub-subdirectory, or as a standalone
  `ApplicationSet` elsewhere. The root won't see it and the service **never deploys** — no app, no
  pod, no error. (This is exactly how `platform-job-watcher` was absent from dev: it lived only as
  an `ApplicationSet` in `argocd-apps/`, which the non-recursive root never applied.)
- **Production:** add the explicit app to `argocd-apps/applications-production.yaml` (or the prod
  app-of-apps path) — prod does not read `eks/development`.
- **Verify after merge — do not assume:**
  ```bash
  kubectl get applications -n argocd | grep <service>     # the app must appear
  kubectl get pods -A | grep <service>                    # the pod must be Running
  ```
  An app you can't see in `get applications` is not deployed.

### 2. `checksum/config` — auto-roll on config change

Any service whose pod **reads a ConfigMap or Secret at startup** (most do — config is loaded once)
MUST stamp a content hash on the **pod template** so a config change rolls the Deployment:

```yaml
spec:
  template:
    metadata:
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
        # add a checksum/secret line similarly if the pod mounts a rendered Secret
```

Without it, editing the ConfigMap — even via an ArgoCD sync — does **nothing** to the running pod
until someone manually `kubectl rollout restart`s it. The config looks applied (ArgoCD is green)
but the process is still on the old values. (This is why `platform-job-watcher` kept running stale
config after its entries changed.)

## Branch workflow

- `main` is the deployment branch; work on a feature branch off `main`, PR to `main`.
- Delete the branch (local **and** remote) and `git worktree remove` any worktree after the PR
  merges. Keep only `main` (+ `develop` if still in use). Periodically `git remote prune origin`.
- Before deleting a branch, confirm nothing is lost: `git rev-list --count <branch> --not --remotes`
  must be `0` (push to a same-named remote branch first if not).
