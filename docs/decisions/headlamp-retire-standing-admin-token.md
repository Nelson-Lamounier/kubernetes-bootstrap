---
title: Retire Headlamp's standing cluster-admin token; mint short-lived on demand
type: decision
tags: [security, kubernetes, rbac, headlamp, credentials, least-privilege, service-account-token]
sources:
  - charts/headlamp-config/chart/templates/admin.yaml
  - charts/headlamp-config/chart/templates/viewer.yaml
  - argocd-apps/eks/development/headlamp.yaml
created: 2026-07-05
updated: 2026-07-05
---

# Retire Headlamp's standing cluster-admin token; mint short-lived on demand

## Status

Accepted and deployed — PR [#203](https://github.com/Nelson-Lamounier/kubernetes-bootstrap/pull/203)
(`a9224de`), verified 2026-07-05.

## Context

The Headlamp dashboard is exposed on an internet-facing ALB at
`ops.nelsonlamounier.com/headlamp`
([argocd-apps/eks/development/headlamp.yaml](../../argocd-apps/eks/development/headlamp.yaml)).
Its admin identity was a `ServiceAccount` bound to `cluster-admin` with a
`kubernetes.io/service-account-token` **Secret** — a legacy, non-expiring token —
that a PostSync Job copied into SSM on every sync
([charts/headlamp-config/chart/templates/admin.yaml](../../charts/headlamp-config/chart/templates/admin.yaml)).

A single leaked string (from SSM, a shell history, or the Kubernetes Secret via
an over-privileged reader) was therefore permanent, internet-usable
cluster-admin. Non-expiring tokens also defeat rotation and audit.

## Decision

Delete the standing admin token Secret and stop pushing it to SSM. Keep the
`headlamp-admin` ServiceAccount and its `cluster-admin` binding, but issue
credentials on demand as short-lived tokens:

```bash
kubectl create token headlamp-admin -n headlamp --duration=1h
```

The read-only `headlamp-viewer` identity
([charts/headlamp-config/chart/templates/viewer.yaml](../../charts/headlamp-config/chart/templates/viewer.yaml))
is unchanged for day-to-day use.

## Consequences

- No standing cluster-admin credential exists at rest. Verified 2026-07-05: the
  `headlamp-admin-token` Secret is gone and the SSM parameter
  `/k8s/development/headlamp-admin-token` was deleted; `kubectl create token
  headlamp-admin --duration=1h` still issues a working admin session.
- Admin access now requires cluster API access to mint a token, which layers on
  top of the ALB WAF admin-allowlist that already fronts `ops.*`.
- The old Secret was orphaned (legacy tracking label, no ArgoCD tracking
  annotation), so removing it from the chart did not prune it — it was deleted
  manually. See
  [ArgoCD orphaned resources are not pruned](../troubleshooting/argocd-orphaned-resource-not-pruned.md).

## Alternatives considered

- **Put an OIDC proxy in front of Headlamp** — stronger, but a larger change;
  short-lived tokens plus the existing WAF allow-list close the standing-secret
  risk immediately.
- **Downgrade the admin SA to a scoped role** — rejected: operators genuinely
  need cluster-admin for break-glass; the fix is to make that power ephemeral,
  not to remove it.

<!--
Evidence trail (auto-generated):
- Source: charts/headlamp-config/chart/templates/admin.yaml (read 2026-07-05)
- Source: argocd-apps/eks/development/headlamp.yaml (internet-facing ALB, read 2026-07-05)
- Live: kubectl -n headlamp get secret headlamp-admin-token -> NotFound; kubectl create token headlamp-admin --duration=1h -> OK (2026-07-05)
- Git: origin/main PR #203 (a9224de)
-->
