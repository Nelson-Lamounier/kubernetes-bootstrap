---
title: Right-sizing pod resources from a live 24h profile
type: concept
tags: [finops, kubernetes, resources, requests-limits, karpenter, prometheus, hpa, cost, capacity]
sources:
  - charts/admin-api/admin-api-values-eks.yaml
  - charts/nextjs/nextjs-values-eks.yaml
  - charts/public-api/public-api-values-eks.yaml
  - charts/tucaken-app/tucaken-app-values-eks.yaml
created: 2026-07-05
updated: 2026-07-05
---

# Right-sizing pod resources from a live 24h profile

Pod **requests** are what the scheduler reserves and what Karpenter provisions
nodes for — so over-stated requests cost real money in idle capacity, while
limits only cap bursts. This is the method used to right-size the web tier in PR
[#207](https://github.com/Nelson-Lamounier/kubernetes-bootstrap/pull/207):
measure the live working set over 24h, set requests just above steady-state, set
limits above the observed peak, and let Karpenter consolidate the freed capacity.

## The anti-pattern it replaced

Before #207, the four EKS value overlays each stamped an identical copy-paste
block — `requests: 100m / 256Mi`, `limits: 500m / 512Mi` — over every web
service, overriding the tuned per-service values in each chart's base file. Six
web pods reserved 600m CPU and 1536Mi of memory while using a fraction of it.
The cluster ran at ~14% CPU and ~42% memory, but the binding constraint was
*requests*, not usage, so the over-reservation pinned a node that nothing needed.

## Step 1 — measure the real working set

Read each service's actual CPU and memory over a full day from Prometheus rather
than guessing. The values that drove #207 (queried 2026-07-05):

| Service | CPU avg / peak | Memory working set |
|---------|----------------|--------------------|
| admin-api | ~30m / 332m burst | 110–144Mi |
| nextjs | 45m / 57m | 127–185Mi |
| public-api | ~4m | ~75Mi |
| tucaken-app | 15m / 38m | 70–157Mi |

`container_memory_working_set_bytes` and `rate(container_cpu_usage_seconds_total[5m])`
aggregated per pod over `[24h]` give the steady state and the peak.

## Step 2 — set requests just above steady-state, with the HPA caveat

Requests should sit a little above the steady-state working set, not at the
observed peak (that is what limits are for). A request is a reservation, not a
cap, so a pod can still burst above it up to its limit. The resulting values
([charts/admin-api/admin-api-values-eks.yaml](../../charts/admin-api/admin-api-values-eks.yaml)):

| Service | requests (was 100m/256Mi) | limits |
|---------|---------------------------|--------|
| admin-api | `50m` / `160Mi` | `500m` / `512Mi` |
| nextjs | `50m` / `192Mi` | `300m` / `384Mi` |
| public-api | `25m` / `96Mi` | `200m` / `128Mi` |
| tucaken-app | `50m` / `160Mi` | `300m` / `384Mi` |

The **CPU-request-as-HPA-anchor caveat**: where a HorizontalPodAutoscaler targets
a percentage of CPU *request*, the request cannot be dropped to the raw average
or the target is met by tiny loads and replicas flap. admin-api and tucaken-app
keep a `50m` CPU request (not lower) so their observed 38–332m bursts stay under
the 70%-of-request scale-out threshold instead of triggering churn.

## Step 3 — set limits above the peak, not at it

Memory limits are ≥ ~2× the observed peak so a legitimate burst is not OOM-killed
(admin-api keeps its `512Mi` limit for the 144Mi working set because its process
can spike; public-api drops to `128Mi` against a 75Mi set). CPU limits keep
headroom for the measured bursts — admin-api retains `500m` for its 332m burst,
which the chart base's `300m` would throttle.

## Step 4 — let Karpenter reclaim the freed capacity

Lowering requests reduces what Karpenter must reserve. The web tier's
reservations fell from **600m CPU / 1536Mi** to **275m / 928Mi** across the six
pods. With the `workloads-default` NodePool on
`consolidationPolicy: WhenEmptyOrUnderutilized` and `consolidateAfter: 1m`,
Karpenter re-evaluated and removed a workload node — verified 2026-07-05, the
cluster settled at 4 nodes (2 workload + 2 system) after previously running 5.
The fourth node's cost was a direct consequence of the copy-paste request block.

## Watch the quota interaction on the first rollout

Because these are blue/green services, the *first* rollout onto the reduced
requests briefly runs the old (higher) and new (lower) pods together, which can
breach a tight namespace `ResourceQuota` — the tucaken quota had to be raised in
the same PR. See
[Blue/green rollouts and namespace ResourceQuota surge](./bluegreen-rollout-resourcequota.md).

## Related

- [Blue/green rollouts and namespace ResourceQuota surge](./bluegreen-rollout-resourcequota.md)
- [Observability hardening & cost optimisation — July 2026](../projects/2026-07-observability-hardening-and-cost.md)
  — the broader FinOps pass this right-sizing sits within

<!--
Evidence trail (auto-generated):
- Source: charts/{admin-api,nextjs,public-api,tucaken-app}/*-values-eks.yaml (read 2026-07-05)
- Live: Prometheus 24h working-set + CPU per service (queried 2026-07-05)
- Live: kubectl get nodes -> 4 nodes after consolidation (2026-07-05)
- Git: origin/main PR #207 (3004a54)
-->
