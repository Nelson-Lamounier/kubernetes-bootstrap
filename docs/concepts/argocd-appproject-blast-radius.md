---
title: Scoped ArgoCD AppProjects for blast-radius containment
type: concept
tags: [argocd, gitops, security, multi-tenancy, least-privilege, supply-chain, kubernetes, rbac]
sources:
  - argocd-apps/eks/development/appprojects.yaml
  - argocd-apps/eks/development/admin-api.yaml
created: 2026-07-05
updated: 2026-07-05
---

# Scoped ArgoCD AppProjects for blast-radius containment

An ArgoCD `AppProject` is the unit of blast-radius control in a GitOps
app-of-apps: it constrains which source repositories, destination namespaces,
and cluster-scoped resource kinds the Applications assigned to it may deploy.
This cluster replaced the permissive auto-created `default` project with four
scoped projects plus a locked-down `default`
([argocd-apps/eks/development/appprojects.yaml](../../argocd-apps/eks/development/appprojects.yaml),
PR [#209](https://github.com/Nelson-Lamounier/kubernetes-bootstrap/pull/209)).

## Why the wildcard default project is dangerous

The `default` AppProject that ArgoCD creates on install allows
`sourceRepos: ["*"]`, any destination namespace, and any cluster-scoped kind.
Combined with the app-of-apps convention where every child Application declares
`project: default` and runs with `automated: { prune: true, selfHeal: true }`,
this means anyone able to patch a single Application object — for example
through an over-privileged CI runner — can deploy arbitrary resources into any
namespace, and ArgoCD's self-heal will keep re-applying them. The project is the
only layer that can reject such a change before it is synced.

## The four scoped projects

Each project pins three axes to exactly what its Applications use today
([appprojects.yaml](../../argocd-apps/eks/development/appprojects.yaml)):

| Project | Applications | Namespaces | Notable cluster-scoped kinds |
|---------|-------------|------------|------------------------------|
| `infra` | ARC, ArgoCD periphery, cert-manager, ESO, metrics-server, rollouts, headlamp, reloader | 11 (arc-runners, argocd, cert-manager, external-secrets, …) | CRD, ClusterRole/Binding, webhooks, APIService, ClusterSecretStore |
| `monitoring` | monitoring, opencost | monitoring | ClusterRole/Binding, StorageClass |
| `platform` | platform-rds, redis-broker, redis-cache, job-watcher | platform, redis-broker, redis-cache | Namespace, ClusterRole/Binding |
| `workloads` | 10 web/pipeline services + their secrets apps | 10 service namespaces | Namespace |

The `default` project is kept in Git and reduced to the root app-of-apps only:
it may create `Application`/`AppProject` objects in the `argocd` namespace from
this repository and nothing else (empty `clusterResourceWhitelist`). Verified
live on 2026-07-05: **1** of 46 Applications sits on `default` (the root); the
other 45 are distributed across the four scoped projects.

## Deriving the allowlists from a live audit, not guesswork

Every `clusterResourceWhitelist` entry was taken from an audit of what the live
Applications actually manage, not from a speculative list. The cluster-scoped
resources per Application were enumerated with `kubectl get applications -n
argocd -o json` and their `status.resources[]` entries filtered to those with no
namespace. Only the observed kinds (CRDs and RBAC for controllers,
`StorageClass` for monitoring, `Namespace` for the chart-templated namespaces)
were whitelisted. This keeps the projects tight without breaking any currently
synced Application, and it means a future Application that introduces a new
cluster-scoped kind fails its sync with an explicit project-violation error
rather than silently gaining the privilege.

## Sync ordering and the SSH repoURL detail

`appprojects.yaml` carries `argocd.argoproj.io/sync-wave: "-20"` so the projects
exist before any Application references them. The `sourceRepos` list includes
this repository in **both** its HTTPS and `git@github.com:` SSH forms, because
the eight ArgoCD Image Updater write-back Applications commit through the SSH
URL — omitting it would reject their write-back sync.

## Failure mode and rollback

A project scoped too tightly fails the affected Application's **sync** with
`ComparisonError: … not permitted in project <name>`; the running pods are
untouched. Remediation is to widen the one offending allowlist line, or revert
the file. During rollout of #209 the child Applications briefly showed a stale
`InvalidSpecError` referencing `default` while the root app was mid-sync — it
cleared once each child's `project` field propagated and the app re-validated.

## Related

- [GitOps security-hardening sweep](../projects/2026-07-security-hardening-sweep.md)
- [ARC runner RBAC namespace scoping](../decisions/arc-runner-rbac-namespace-scoping.md)
  — the CI-runner privilege this containment defends against
- [ArgoCD GitOps architecture](./argocd-gitops-architecture.md)

<!--
Evidence trail (auto-generated):
- Source: argocd-apps/eks/development/appprojects.yaml (read 2026-07-05)
- Source: argocd-apps/eks/development/admin-api.yaml (project field, read 2026-07-05)
- Live: kubectl get appproject -n argocd (2026-07-05: default infra monitoring platform workloads)
- Live: kubectl get applications -n argocd -o json (project distribution, 2026-07-05)
- Git: origin/main PR #209 (3db54e7)
-->
