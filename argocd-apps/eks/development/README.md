# argocd-apps/eks/development

Reconciled by `eks-root-development` (one directory up).

Empty in V1 (Plan 4) — Plan 5 (workload cutover) fills this directory
with `Application` manifests, one per workload that migrates from the
kubeadm cluster.

## Adding a workload

1. Copy the matching top-level manifest (e.g. `argocd-apps/admin-api.yaml`)
   into this directory and rename it `<name>-development.yaml`.
2. Adjust:
   - `metadata.name` -> `<name>-eks-development` so it doesn't collide
     with the kubeadm-cluster app name.
   - `spec.source.path` -> the chart's existing path (chart code is shared).
   - `spec.source.helm.valueFiles` -> use a new `values-eks-development.yaml`
     overlay if EKS-specific changes are needed (Pod Identity SAs,
     NodePool tolerations, ALB Ingress instead of IngressRoute).
3. Commit. The root app picks it up on next sync (default 3 min, or
   trigger via `argocd app sync eks-root-development`).
