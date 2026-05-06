# Runbook — Install ArgoCD on the EKS Cluster

**When to run:** Once per environment, after `Deploy EKS to <env>`
workflow reports success and `kubectl get nodes` shows 3 system nodes
Ready.

**How:** Trigger the **Bootstrap ArgoCD on EKS** GitHub Actions workflow
(`cdk-monitoring/.github/workflows/bootstrap-argocd.yml`). Re-running on
a healthy cluster is a no-op — every step is idempotent.

**Why a workflow:** ArgoCD is the entry point for everything else. The
workflow keeps the install reproducible, observable in the Actions UI,
and safe to re-run after CDK or Helm version bumps. The runbook is now
"click the button"; the manual `helm`/`kubectl` flow below is kept only
for break-glass.

**Why not via `EksAddonsStack`?** Mixing ArgoCD with the CDK-managed
Helm charts in the addons stack creates a chicken-and-egg: ArgoCD would
need to exist before it can reconcile its own configuration. Cleaner to
install via a one-shot workflow and hand off to git.

## Trigger the workflow

1. Open Actions → **Bootstrap ArgoCD on EKS** in the `cdk-monitoring`
   repo.
2. **Run workflow** with:
   - `environment`: `development` (or `staging` / `production`)
   - `kubernetes-bootstrap-ref`: `main` (default)
   - `argocd-chart-version`: `7.7.5` (default)

The workflow:

1. Assumes the GH OIDC role with EKS Access Entry cluster-admin.
2. `aws eks update-kubeconfig` against `k8s-eks-<env>`.
3. Installs Helm 3, kubectl, and the `argocd` CLI on the runner.
4. `helm upgrade --install argocd argo/argo-cd` using
   `charts/argocd-eks/values.yaml` from this repo.
5. Waits for every argocd Deployment to become Available.
6. `kubectl apply -f argocd-apps/eks/root-app-<env>.yaml`.
7. Prints pods + Applications for diagnostic visibility.

## Verify after the workflow finishes

```bash
aws eks update-kubeconfig --name k8s-eks-development --region eu-west-1 --alias eks-dev
kubectl --context eks-dev -n argocd get application eks-root-development
# Expected: SYNC STATUS=Synced, HEALTH STATUS=Healthy
```

The root app reconciles `argocd-apps/eks/development/`, which is empty
in V1, so `Synced` + `Healthy` is the target state. Plan 5 fills the
directory and watches individual workload Apps appear.

## Why HTTPS for the root app's repoURL

The repo is public, so ArgoCD's read-side reconciliation needs no
credentials. This removes the deploy-key bootstrap dependency from the
install workflow. ArgoCD Image Updater (write side) is wired with its
own SSH deploy key inside its workload chart, not here.

## Troubleshooting

- **Workflow fails at `update-kubeconfig`:** the EKS Access Entry for
  the GH OIDC role is missing. Apply the `EksAccess-<env>` stack first
  (part of `Deploy EKS to <env>`).
- **`helm upgrade` times out waiting for pods:** check that the system
  MNG nodes are Ready and that the `dedicated=system:NoSchedule` taint
  is in place — `charts/argocd-eks/values.yaml` tolerates exactly that
  taint, so a different taint blocks scheduling.
- **Root app `OutOfSync`, "directory is empty":** the manifest is
  missing `syncPolicy.automated.allowEmpty: true`. The committed
  manifest already has it; re-apply from main.
- **Root app `ComparisonError`, "repository not accessible":** ensure
  `repoURL` is HTTPS (`https://github.com/...`). SSH would require a
  deploy-key secret.

## Break-glass: install ArgoCD manually

If the workflow is blocked (e.g. GH Actions outage), reproduce its
behaviour locally:

```bash
aws eks update-kubeconfig --name k8s-eks-development --region eu-west-1 --alias eks-dev

helm repo add argo https://argoproj.github.io/argo-helm && helm repo update
helm upgrade --install argocd argo/argo-cd \
  --namespace argocd --create-namespace --version 7.7.5 \
  --values charts/argocd-eks/values.yaml \
  --kube-context eks-dev --wait --timeout 10m

kubectl --context eks-dev -n argocd wait \
  --for=condition=available deployment --all --timeout=5m

kubectl --context eks-dev apply \
  -f argocd-apps/eks/root-app-development.yaml
```

## Spec

`cdk-monitoring/docs/superpowers/specs/2026-05-05-eks-migration-design.md` §§ 3.3, 7.3.
