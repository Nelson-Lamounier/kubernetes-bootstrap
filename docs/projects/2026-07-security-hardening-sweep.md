---
title: GitOps security-hardening sweep — July 2026
type: project
tags: [security, kubernetes, argocd, gitops, rbac, network-policy, pod-security-admission, supply-chain, least-privilege, eks]
sources:
  - argocd-apps/eks/development/appprojects.yaml
  - gitops/arc/runner-rbac.yaml
  - charts/headlamp-config/chart/templates/admin.yaml
  - charts/admin-api/chart/templates/networkpolicy.yaml
  - charts/public-api/chart/templates/networkpolicy.yaml
created: 2026-07-05
updated: 2026-07-05
---

# GitOps security-hardening sweep — July 2026

A coordinated pass across the EKS GitOps platform that closed a concrete
CI-to-cluster-admin escalation chain and moved the cluster from a permissive
default posture to least-privilege defaults. Delivered as seven reviewed pull
requests ([#202](https://github.com/Nelson-Lamounier/kubernetes-bootstrap/pull/202),
[#203](https://github.com/Nelson-Lamounier/kubernetes-bootstrap/pull/203),
[#209](https://github.com/Nelson-Lamounier/kubernetes-bootstrap/pull/209),
[#211](https://github.com/Nelson-Lamounier/kubernetes-bootstrap/pull/211),
[#213](https://github.com/Nelson-Lamounier/kubernetes-bootstrap/pull/213),
[#220](https://github.com/Nelson-Lamounier/kubernetes-bootstrap/pull/220),
[#222](https://github.com/Nelson-Lamounier/kubernetes-bootstrap/pull/222)),
each verified against the live cluster after merge.

## The attack chain that motivated the work

Three permissive defaults chained into full cluster takeover from a single
compromised CI workflow (a malicious pull request or a poisoned dependency
running on the self-hosted runners):

1. The ARC runner ServiceAccount held a cluster-wide ClusterRole granting
   `secrets: get/create/update/patch/replace` and `applications: patch` across
   every namespace ([gitops/arc/runner-rbac.yaml](../../gitops/arc/runner-rbac.yaml)).
2. A never-expiring `cluster-admin` ServiceAccount token backed an
   internet-facing Headlamp dashboard and was copied to SSM on every sync
   ([charts/headlamp-config/chart/templates/admin.yaml](../../charts/headlamp-config/chart/templates/admin.yaml)).
3. Every ArgoCD Application used the auto-created wildcard `default` AppProject,
   so a repointed Application would deploy anything, anywhere, and automated
   `prune`+`selfHeal` would enforce it
   ([argocd-apps/eks/development/appprojects.yaml](../../argocd-apps/eks/development/appprojects.yaml)).

Any one of the three, reached from CI code execution, escalated to the other
two. The sweep broke every link.

## What changed, by pull request

| PR | Change | Primary evidence |
|----|--------|------------------|
| #202 | ARC runner RBAC cluster-wide → per-namespace Roles with `resourceNames` | [runner-rbac.yaml](../../gitops/arc/runner-rbac.yaml) |
| #203 | Headlamp standing `cluster-admin` token removed; mint short-lived on demand | [admin.yaml](../../charts/headlamp-config/chart/templates/admin.yaml) |
| #209 | Four scoped AppProjects replace the wildcard `default` | [appprojects.yaml](../../argocd-apps/eks/development/appprojects.yaml) |
| #211 | Baseline Pod Security Admission on 18 namespaces + re-enabled web-tier NetworkPolicies | [networkpolicy.yaml](../../charts/admin-api/chart/templates/networkpolicy.yaml) |
| #213 | `securityContext` on 6 previously-root pods; CI runner images pinned by digest | [auth-proxy.yaml](../../charts/monitoring/chart/templates/prometheus/auth-proxy.yaml) |
| #220, #222 | Traefik admin middlewares, patcher, and push endpoints retired | [Traefik → ALB consolidation](../decisions/traefik-to-alb-consolidation.md) |

## Verified end state

All figures read from the live `dev` cluster (`k8s-eks-development`,
`eu-west-1`) on 2026-07-05:

- The runner ServiceAccount can read secrets **only in `admin-api`**, not
  cluster-wide (`kubectl auth can-i get secrets --as=system:serviceaccount:arc-runners:arc-runner`
  returns `no` for `monitoring`/`platform`, `yes` for `admin-api`).
- **1** of 46 Applications remains on the `default` project — the root
  app-of-apps; the other 45 sit on `infra`/`monitoring`/`platform`/`workloads`.
- **18** namespaces carry `pod-security.kubernetes.io/enforce`; **7**
  NetworkPolicies are active.
- **0** Traefik CRDs remain (`kubectl get crd | grep -ci traefik`).
- The standing `headlamp-admin-token` Secret is gone; `kubectl create token
  headlamp-admin --duration=1h` still issues an admin session on demand.

## Companion documents

- [Scoped ArgoCD AppProjects](../concepts/argocd-appproject-blast-radius.md)
  — the blast-radius-containment concept and how each project's allowlist was derived
- [Web-tier network isolation](../concepts/web-tier-network-isolation.md)
  — PSA baseline + VPC-CNI NetworkPolicy model, including the ALB `ipBlock` requirement
- [ARC runner RBAC namespace scoping](../decisions/arc-runner-rbac-namespace-scoping.md)
- [Headlamp: retire the standing admin token](../decisions/headlamp-retire-standing-admin-token.md)
- [Image supply-chain pinning](../patterns/image-supply-chain-pinning.md)
- [ArgoCD orphaned resources are not pruned under annotation tracking](../troubleshooting/argocd-orphaned-resource-not-pruned.md)
  — the recurring cleanup gotcha hit throughout this sweep

<!--
Evidence trail (auto-generated):
- Source: argocd-apps/eks/development/appprojects.yaml (read 2026-07-05)
- Source: gitops/arc/runner-rbac.yaml (read 2026-07-05)
- Source: charts/headlamp-config/chart/templates/admin.yaml (read 2026-07-05)
- Live: kubectl auth can-i --as=system:serviceaccount:arc-runners:arc-runner (2026-07-05)
- Live: kubectl get ns / get appproject / get crd | grep traefik (2026-07-05)
- Git: origin/main PRs #202 #203 #209 #211 #213 #220 #222
-->
