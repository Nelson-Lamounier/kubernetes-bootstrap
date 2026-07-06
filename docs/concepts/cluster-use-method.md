---
title: Cluster capacity and the USE method
type: concept
tags: [kubernetes, use-method, capacity, node-exporter, karpenter, eni-pod-cap, saturation, observability, benchmarks]
sources:
  - charts/monitoring/chart/dashboards/cluster.json
  - charts/monitoring/chart/dashboards/node-os.json
created: 2026-07-06
updated: 2026-07-06
---

# Cluster capacity and the USE method

The `cluster` and `node-os` dashboards read node health through the **USE
method** — for every resource, track **U**tilisation, **S**aturation, and
**E**rrors ([Brendan Gregg's USE method](https://www.brendangregg.com/usemethod.html)).
This doc maps the live cluster (2026-07-06) onto USE and surfaces the two
resources that are actually under pressure — which are neither CPU nor memory.

## Utilisation — CPU and memory are not the constraint

Per-node utilisation read from node-exporter:

| Resource | Live | Read |
|----------|------|------|
| CPU per node | **6–12%** | far below saturation |
| Memory per node | **36–52%** | comfortable |
| Root disk per node | **73–79%** (workload nodes) | **approaching the alert band** |

CPU and memory have large headroom. **Disk is the utilisation outlier**: the
workload nodes sit at 73–79% root-filesystem use, near the conventional 75–80%
alert threshold. On EKS this is usually image layers and ephemeral pod storage
accumulating; it is the first node resource that will bite, and a `node_filesystem`
alert at 80% is the natural follow-up.

## Saturation — the real ceiling is the ENI pod cap

Cluster-level commitment (requests vs allocatable) is moderate: **CPU requests
53%**, **memory requests 44%** committed. But raw resource commitment hides the
binding constraint. Pods per node:

| Node | Pods | Instance pod cap | Saturation |
|------|-----:|-----------------:|-----------:|
| ip-10-0-1-37 | **32** | 35 (t3.large ENI cap) | **~91%** |
| ip-10-0-0-18 | 28 | 35 | 80% |
| others | 8–18 | 17–35 | low |

One workload node is at **32 of 35 pods — 91% of its ENI pod cap** — while its
CPU sits at ~12%. Karpenter ranks by CPU/memory and is blind to the pod cap, so
this is exactly the pod-density saturation documented for the
[Karpenter system pool](https://github.com/Nelson-Lamounier/tucaken-infra/blob/main/docs/troubleshooting/karpenter-system-pool-pod-density-starvation.md)
(in the `tucaken-infra` CDK repo). Saturation here is measured in **pod slots**,
not vCPU.

## Errors — clean

- Container restarts (24h): **0**
- OOMKilled (24h): **0**
- Pods not Running: **1** (a completed/terminating Job pod)

No error-class saturation. The cluster is healthy; the pressure is capacity, not
faults.

## How this measures against the USE method

The USE method's value is that it forces you to look at **saturation**, not just
utilisation — and here that is exactly what separates signal from noise. A
CPU-only view would call this cluster 90% idle and over-provisioned; the USE view
shows the true limits are **disk (73–79%)** and **pod density (91% of the ENI
cap on one node)**. Utilisation of the headline resource (CPU 6–12%) is the least
informative number on the dashboard. This is the method working as intended:
two real watch-items surfaced that a utilisation-only dashboard would hide.

## Related

- [Prometheus TSDB capacity and cardinality](./prometheus-tsdb-capacity.md)
- [Right-sizing pod resources from a live 24h profile](./resource-right-sizing-from-live-profiles.md)
  — how the workload requests that drive Karpenter were tuned

<!--
Evidence trail (auto-generated):
- Live (Prometheus/node-exporter + KSM via kubectl proxy, 2026-07-06): CPU 6-12%/node, mem 36-52%, root disk 73-79%; pods/node 8/18/18/28/32; CPU requests 53% mem 44% committed; 0 restarts, 0 OOM, 1 pod not Running
- Web: Brendan Gregg USE method
- Cross-repo: tucaken-infra karpenter-system-pool-pod-density-starvation.md (ENI pod cap)
-->
