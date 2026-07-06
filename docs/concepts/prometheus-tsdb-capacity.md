---
title: Prometheus TSDB capacity and cardinality
type: concept
tags: [prometheus, tsdb, cardinality, capacity-planning, observability, memory, scale, benchmarks]
sources:
  - charts/monitoring/chart/dashboards/monitoring-health.json
  - charts/monitoring/chart/values.yaml
  - charts/monitoring/chart/templates/prometheus/deployment.yaml
created: 2026-07-06
updated: 2026-07-06
---

# Prometheus TSDB capacity and cardinality

A single Prometheus instance stores every metric in a local time-series database
(TSDB), and its memory and disk scale with **active series** — so capacity
planning is really cardinality management. This doc records the live TSDB profile
(2026-07-06), benchmarks it against the accepted per-series rules of thumb, and
flags the one scrape job that dominates cardinality.

## Live TSDB profile (2026-07-06)

Read from the Prometheus API on the live cluster:

| Signal | Value |
|--------|------:|
| Active series (head) | **204,510** |
| Head chunks | **535,263** |
| Samples appended | **~5,643 /s** |
| TSDB size (blocks + WAL) | **~7.2 GB** |
| Process RSS | **~1,128 MB** |
| Scrape targets up / total | **51 / 51** |

## Efficiency against the per-series rule of thumb

The accepted planning figure is **~7.5 KiB of RAM per active series** (the range
in the literature is 3–9 KiB), and `process_resident_memory_bytes` can run up to
2× the head estimate under query load
([cardinality.cloud](https://cardinality.cloud/blog/prometheus_memory_usage/),
[Robust Perception](https://www.robustperception.io/why-does-prometheus-use-so-much-ram/)).
This instance runs at **1,128 MB / 204,510 series ≈ 5.5 KiB per series** — inside
the healthy band and below the 7.5 KiB planning figure, so memory is being used
efficiently.

At scale, the broad upper-limit rule is *physical RAM ÷ 10,000* active series
(≈ 6M series on a 64 GiB host). At 204k series this is a **small-to-medium
single-server workload** — a single Prometheus comfortably handles 100k–10M+
series, so there is no sharding pressure. The constraint is the pod's own memory
limit (2 GiB), which at ~5.5 KiB/series implies a practical ceiling near ~370k
series before it approaches the limit — roughly **1.8× the current load**.

## Cardinality is concentrated in one job

Series count by scrape job reveals an uneven distribution:

| Scrape job | Active series | Share |
|-----------|--------------:|------:|
| **ontology-importer-followup** | **54,800** | **~27%** |
| karpenter | 26,018 | 13% |
| kubernetes-cadvisor | 20,574 | 10% |
| kubernetes-service-endpoints | 12,775 | 6% |
| kubernetes-nodes | 11,450 | 6% |
| kube-state-metrics | 9,372 | 5% |

A single cronjob — `ontology-importer-followup` — accounts for **more series than
karpenter and cadvisor combined**. That is the classic signature of a
high-cardinality label (per-run instance IDs or per-entity labels multiplying the
series count). Against a 2 GiB memory budget it is the first place to look if the
TSDB approaches its limit: dropping or aggregating those labels via
`metric_relabel_configs` would reclaim the largest single block of cardinality.
This is a real watch-item, honestly flagged — not a current outage.

## Related

- [Prometheus scrape configuration](../tools/prometheus-scrape-config.md)
- [Cluster capacity and the USE method](./cluster-use-method.md)
- [Application RED metrics and multi-window SLO alerting](./application-red-and-slo-metrics.md)

<!--
Evidence trail (auto-generated):
- Live (Prometheus API via kubectl proxy, 2026-07-06): head_series 204510, chunks 535263, ~5643 samples/s, TSDB ~7.2GB, RSS 1128MB, 51/51 targets
- Live: topk series by job — ontology-importer-followup 54800, karpenter 26018, cadvisor 20574, ksm 9372
- Web: cardinality.cloud + Robust Perception (7.5 KiB/series, RSS 2x), broad upper limit RAM/10000
-->
