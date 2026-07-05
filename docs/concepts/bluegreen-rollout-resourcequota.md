---
title: Blue/green rollouts and namespace ResourceQuota surge
type: concept
tags: [argo-rollouts, blue-green, resourcequota, kubernetes, progressive-delivery, capacity]
sources:
  - charts/tucaken-app/chart/templates/resource-quota.yaml
  - charts/tucaken-app/chart/templates/rollout.yaml
  - charts/tucaken-app/tucaken-app-values.yaml
created: 2026-07-05
updated: 2026-07-05
---

# Blue/green rollouts and namespace ResourceQuota surge

An Argo Rollouts blue/green strategy runs a full **preview** ReplicaSet
alongside the active one during a rollout, so a namespace `ResourceQuota` must
be sized for both stacks at once. Sizing it for steady state instead deadlocks
the rollout with `FailedCreate: exceeded quota`. This coupling was hit and fixed
in PR [#207](https://github.com/Nelson-Lamounier/kubernetes-bootstrap/pull/207).

## Why a blue/green rollout doubles the request footprint

The `tucaken-app` Rollout uses `strategy.blueGreen` with `replicas: 2`
([charts/tucaken-app/chart/templates/rollout.yaml](../../charts/tucaken-app/chart/templates/rollout.yaml)).
When a new revision is promoted, Argo Rollouts brings up a complete preview
ReplicaSet (2 pods) while the active ReplicaSet (2 pods) keeps serving, then
cuts traffic over and scales the old one down after `scaleDownDelaySeconds`.
For the duration of the rollout the namespace holds **four** pods, so
`requests.memory` and `limits.cpu` in the quota must cover 2 × replicas — not
the steady-state 2.

## The first-rollout-onto-lower-requests worst case

The trap is sharpest when a change *reduces* per-pod requests. During that first
rollout the active ReplicaSet still runs the **old** (higher) requests while the
preview runs the **new** (lower) ones, so the transient peak is
`old-active + new-preview`, higher than either steady state. For tucaken-app
right-sizing to `50m/160Mi` requests, the first-rollout peak was 2 × 256Mi +
2 × 160Mi = **832Mi** of `requests.memory` and 2 × 500m + 2 × 300m = **1600m**
of `limits.cpu` — both above the old 768Mi / 1500m quota, which stalled the
preview ReplicaSet at `FailedCreate`.

## Sizing the quota for the surge

The fix raised the quota to fit the transient with headroom
([charts/tucaken-app/tucaken-app-values.yaml](../../charts/tucaken-app/tucaken-app-values.yaml)):

```yaml
resourceQuota:
  hard:
    requests.cpu: "600m"
    requests.memory: 1024Mi   # fits the 832Mi first-rollout transient
    limits.cpu: "2000m"       # fits the 1600m transient
    limits.memory: 2048Mi
```

Once a rollout completes and the old ReplicaSet scales down, usage falls back to
2 × the new requests (640Mi), well within quota, and subsequent rollouts (new
active + new preview) also fit. A single-replica blue/green service like
`nextjs` needs no bump: its transient (1 old + 1 preview) stays under the
existing quota.

## Related failure signature and the general rule

The same quota-ceiling class of failure appeared for a rolling-update exporter
under a full namespace quota (see
[YACE Recreate under quota](../projects/rds-observability-yace-migration.md)) —
a `RollingUpdate` also needs a surge pod. The general rule: any Deployment or
Rollout that creates additional pods during an update must have its namespace
quota sized for the peak, or use a strategy (`Recreate`) that avoids the surge.

## Related

- [Progressive delivery with Argo Rollouts](./progressive-delivery-rollouts.md)
- [GitOps security-hardening sweep](../projects/2026-07-security-hardening-sweep.md)
  — #207 right-sized the web tier that this quota governs

<!--
Evidence trail (auto-generated):
- Source: charts/tucaken-app/chart/templates/rollout.yaml (blueGreen, replicas 2, read 2026-07-05)
- Source: charts/tucaken-app/tucaken-app-values.yaml (resourceQuota, read 2026-07-05)
- Live: kubectl -n tucaken-app get resourcequota tucaken-app-quota (1Gi/2 hard, 2026-07-05)
- Git: origin/main PR #207 (3004a54)
-->
