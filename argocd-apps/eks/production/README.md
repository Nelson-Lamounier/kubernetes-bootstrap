<!-- @format -->

# argocd-apps/eks/production — parked intent, NOT deployed

**Nothing syncs this directory.** The three Application manifests here are
kept as the starting point for a future production environment; no
`root-app-production.yaml` exists and no ArgoCD app watches this path, so
merging changes here deploys nothing. They were moved out of the
`argocd-apps/` root (where the retired kubeadm root app used to sync) so
that placement encodes intent, mirroring `eks/development/`.

## Current reality: one cluster serves production traffic

`k8s-eks-development` is the only cluster, and the workloads it runs
(tucaken-app, admin-api, nextjs, …) serve the real, public traffic. In other
words: **development IS production today.** That is a normal, defensible
solo-developer posture — one cluster, one bill, GitOps-managed.

## When (if) a second environment happens, in order of preference

1. **Promote the existing cluster in name only.** Keep the single cluster,
   accept that it is production, and stop treating "development" as a
   staging tier. Optionally rename app suffixes over time. Cheapest; no
   migration risk. This README + the parked manifests cost nothing
   meanwhile.
2. **Real second cluster.** Create `k8s-eks-production`, add
   `argocd-apps/eks/root-app-production.yaml` (non-recursive, path
   `argocd-apps/eks/production`, same shape as the dev root app), fill this
   directory one app per file (split `applications-production.yaml` — the
   multi-doc bundle predates the one-app-per-file convention), and promote
   by PR. Only do this when there is a concrete reason (paying users, SLA,
   compliance) — a second cluster roughly doubles the fixed cost.

## Guardrails that keep these files from breaking anything

- `destination.server` in these manifests is `https://kubernetes.default.svc`
  — if one were ever applied by hand it would target whatever cluster the
  applying ArgoCD runs in. Do not `kubectl apply` them directly; they are
  templates for the future root app, not standalone deployables.
- The CI validation gate schema-checks the manifests here but does not
  render them, exactly like the rest of the repo's non-synced surface.
