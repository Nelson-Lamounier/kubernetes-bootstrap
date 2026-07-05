---
title: Scope the ARC CI-runner RBAC from cluster-wide to per-namespace Roles
type: decision
tags: [security, rbac, argocd, github-actions, arc, least-privilege, kubernetes, supply-chain]
sources:
  - gitops/arc/runner-rbac.yaml
  - argocd-apps/eks/development/arc-config.yaml
created: 2026-07-05
updated: 2026-07-05
---

# Scope the ARC CI-runner RBAC from cluster-wide to per-namespace Roles

## Status

Accepted and deployed — PR [#202](https://github.com/Nelson-Lamounier/kubernetes-bootstrap/pull/202)
(`e1c3d16`), verified on the live cluster 2026-07-05.

## Context

Self-hosted GitHub Actions runners (Actions Runner Controller, ARC) execute
workflow code — including code from pull requests and third-party dependencies —
inside the cluster. The runner ServiceAccount `arc-runners:arc-runner` was bound
by a **ClusterRoleBinding** to a ClusterRole that granted
`secrets: [get, create, update, patch, replace]` with no `resourceNames` and no
namespace scope, plus `argoproj.io/applications: [patch, update]` and
`traefik.io/ingressroutes` cluster-wide
([gitops/arc/runner-rbac.yaml](../../gitops/arc/runner-rbac.yaml)).

That grant let any code running in CI read any Secret in any namespace — ArgoCD
repo deploy keys, the image-updater write-back key, RDS and Grafana credentials —
and `patch` any ArgoCD Application. Combined with the then-wildcard `default`
AppProject, patching an Application to point at an attacker repository escalated
to full cluster control through the GitOps engine.

## Decision

Replace the cluster-wide ClusterRole with **per-namespace `Role`s** in exactly
the namespaces the runner's deploy jobs operate in (`admin-api`, `public-api`,
`argocd`), each with `resourceNames` on the specific Secrets/ConfigMaps/
Applications it needs, and drop the `replace` verb. Keep only a minimal
namespaces-only ClusterRole where genuinely required. The runner keeps exactly
the access its jobs use and nothing more.

## Consequences

- A compromised CI workflow can no longer read secrets outside `admin-api` (and
  the other named namespaces), closing the first link of the escalation chain
  described in the [security-hardening sweep](../projects/2026-07-security-hardening-sweep.md).
- Verified least-privilege with the impersonation check on 2026-07-05:
  `kubectl auth can-i get secrets --as=system:serviceaccount:arc-runners:arc-runner`
  returns `no` for `-n monitoring` and `-n platform`, and `yes` for `-n admin-api`.
- The old cluster-wide ClusterRole + ClusterRoleBinding were kubeadm-era objects
  carrying only the legacy ArgoCD tracking label, so ArgoCD did not prune them on
  sync — they had to be deleted manually to make the change effective. See
  [ArgoCD orphaned resources are not pruned under annotation tracking](../troubleshooting/argocd-orphaned-resource-not-pruned.md).
- New runner permissions require an explicit, reviewed edit to
  `runner-rbac.yaml` naming the namespace and resource — the friction is the
  point.

## Alternatives considered

- **Keep cluster-wide but drop the dangerous verbs** — rejected: the runner
  genuinely needs write on a small set of named Secrets/Applications, so the
  scope, not just the verb set, had to shrink.
- **A dedicated per-repo runner identity** — heavier; the per-namespace Role
  already bounds the blast radius to the deploy targets.

<!--
Evidence trail (auto-generated):
- Source: gitops/arc/runner-rbac.yaml (read 2026-07-05)
- Live: kubectl auth can-i get secrets --as=system:serviceaccount:arc-runners:arc-runner (2026-07-05)
- Git: origin/main PR #202 (e1c3d16)
-->
