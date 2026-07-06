---
title: Loki and Tempo throughput, streams, and deployment mode
type: concept
tags: [loki, tempo, observability, logs, tracing, cardinality, capacity, grafana, throughput]
sources:
  - charts/monitoring/chart/templates/loki
  - charts/monitoring/chart/templates/tempo
  - charts/monitoring/chart/dashboards/background-jobs.json
created: 2026-07-06
updated: 2026-07-06
---

# Loki and Tempo throughput, streams, and deployment mode

Loki (logs) and Tempo (traces) each run as a **single monolithic binary** on this
cluster, sized for the platform's actual ingest volume. This doc records the live
throughput (2026-07-06), explains why *streams* — not lines-per-second — are the
metric that governs Loki capacity, and why the monolithic deployment mode is the
correct choice at this scale. It complements the architecture in
[Loki + Tempo pipeline](../tools/loki-tempo-pipeline.md).

## Deployment mode: monolithic, by design

Both run as a single Deployment (`replicas: 1`, one container). Grafana ships
Loki and Tempo in two shapes: **monolithic** (all components in one process) and
**microservices** (distributor, ingester, querier, compactor scaled
independently). Grafana recommends monolithic for small-to-moderate volume and
microservices only when a single process can no longer keep up
([Grafana Loki deployment modes](https://grafana.com/docs/loki/latest/get-started/deployment-modes/)).
At this cluster's ingest — see below — monolithic is the right call: it avoids
the operational weight of the microservices topology for volume a single process
handles comfortably.

## Loki throughput (live, 2026-07-06)

| Signal | Value |
|--------|------:|
| Lines received | **161 /s** |
| Bytes received | **~28 KB/s** |
| Active streams (ingester) | **255** |
| Chunks flushed | 0.06 /s |
| Discarded (rate-limited) samples | **0 /s** |
| Ingester RSS | **253 MB** |

## Streams are the Loki cardinality unit

A Loki **stream** is one unique combination of labels, and stream count is what
governs ingester memory and query cost — the direct analogue of active *series*
in Prometheus. The number to watch is therefore **255 streams**, not the 161
lines/s. High-cardinality labels (request IDs, user IDs, IPs) attached to log
lines explode stream count and are the primary Loki anti-pattern; keeping them in
the log *body* rather than as labels is the discipline
([Grafana Loki labels best practice](https://grafana.com/docs/loki/latest/get-started/labels/)).
At 255 streams this stack is well inside healthy territory, and the **0
discarded samples** confirms ingest is comfortably under the configured rate
limits — there is no back-pressure.

## Tempo throughput (live, 2026-07-06)

| Signal | Value |
|--------|------:|
| Spans received | **3.98 /s** |
| Traces created | **1.33 /s** |
| Blocks flushed (cumulative) | 708 |
| RSS | **352 MB** |

Trace volume is very low — a handful of spans per second — which a single Tempo
process handles trivially (Tempo is built to ingest orders of magnitude more).

## What the numbers say — and don't

Throughput here is **dev-scale small**: 161 log lines/s and ~4 spans/s. The
documentable artefact is not the volume but that the pipeline is **right-sized and
clean** — monolithic mode matched to the load, stream cardinality kept low (255),
and zero rate-limit discards. The metrics that would signal trouble at higher
volume — rising stream count, non-zero `loki_discarded_samples_total`, ingester
memory growth — are all healthy, so the design has clear headroom before the
microservices split becomes necessary.

## Related

- [Loki + Tempo pipeline](../tools/loki-tempo-pipeline.md) — the architecture and Promtail collection
- [Prometheus TSDB capacity and cardinality](./prometheus-tsdb-capacity.md) — the series analogue of Loki streams
- [Frontend RUM and Core Web Vitals via Grafana Faro](./frontend-rum-core-web-vitals.md) — a major logs+traces producer

<!--
Evidence trail (auto-generated):
- Live (Prometheus via kubectl proxy, 2026-07-06): Loki 161 lines/s, 28KB/s, 255 streams, 0 discarded, ingester 253MB; Tempo 3.98 spans/s, 1.33 traces/s, 352MB
- Live: kubectl get deploy loki tempo — both replicas=1, single container (monolithic)
- Web: Grafana Loki deployment modes + labels best practice (streams = cardinality unit)
-->
