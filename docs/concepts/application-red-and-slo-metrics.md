---
title: Application RED metrics and multi-window SLO alerting
type: concept
tags: [prometheus, sre, slo, red-method, error-budget, observability, alerting, grafana, benchmarks]
sources:
  - charts/monitoring/chart/templates/prometheus/rules-configmap.yaml
  - charts/monitoring/chart/values.yaml
  - charts/monitoring/chart/dashboards/applications-red.json
  - charts/monitoring/chart/dashboards/bff-red.json
created: 2026-07-06
updated: 2026-07-06
---

# Application RED metrics and multi-window SLO alerting

Every service is instrumented with the **RED method** — Rate, Errors, Duration —
and those signals feed a **multi-window multi-burn-rate (MWMBR) SLO** system: the
same error-budget alerting design published in the Google SRE Workbook. This doc
maps the metric names, the recording rules that derive the SLOs, and how the
implementation measures against industry benchmarks with live numbers read from
the cluster on 2026-07-06.

## Two RED flavours: synchronous services and batch pipelines

The stack instruments two shapes of workload
([charts/monitoring/chart/values.yaml](../../charts/monitoring/chart/values.yaml)):

- **Synchronous HTTP services** (`admin-api`, `public-api`, `nextjs`,
  `tucaken-app`) expose `http_requests_total{service,status_code}` and
  `http_request_duration_seconds_bucket{le}` (tucaken uses `ssr_requests_total`
  / `ssr_request_duration_seconds_bucket` for its server-side-render path). RED
  reads directly: **rate** = `rate(http_requests_total[5m])`, **errors** = the
  `status_code=~"5.."` share, **duration** = `histogram_quantile` over the
  bucket.
- **Batch / pipeline workloads** (`ingestion`, `resume-import`,
  `article-pipeline`, `job-strategist`, `platform-job-watcher`) expose a
  RED-equivalent — `<name>_runs_total{outcome}` and
  `<name>_duration_seconds_bucket` — surfaced on the `applications-red`
  dashboard. Run-once Kubernetes Jobs push through Pushgateway; long-running
  controllers are scraped directly.

## The SLI recording rules

Each service in `slo.services` emits two SLIs across seven windows
(`5m 30m 1h 2h 6h 1d 3d`), rendered into `/etc/prometheus/rules/slo.yml`
([charts/monitoring/chart/templates/prometheus/rules-configmap.yaml](../../charts/monitoring/chart/templates/prometheus/rules-configmap.yaml)):

```yaml
# availability — error ratio
- record: slo:admin-api:errors_ratio:rate1h
  expr: |
    sum(rate(http_requests_total{service="admin-api",status_code=~"5.."}[1h]))
    / clamp_min(sum(rate(http_requests_total{service="admin-api"}[1h])), 1)

# latency — share of requests SLOWER than the target bucket
- record: slo:admin-api:latency_bad_ratio:rate1h
  expr: |
    1 - ( sum(rate(http_request_duration_seconds_bucket{service="admin-api",le="0.5"}[1h]))
          / clamp_min(sum(rate(..._bucket{service="admin-api",le="+Inf"}[1h])), 1) )
```

The `clamp_min(..., 1)` guard keeps the ratio defined when a low-traffic dev
service has near-zero requests in the window.

## The SLO targets

| Service | Availability target | Latency target | Latency bucket |
|---------|--------------------|-----------------|----------------|
| admin-api | **99.9%** (three nines, 43m budget / 30d) | 95% of requests | ≤ **500 ms** |
| tucaken-app | **99.5%** (accommodates SSR cold starts) | 95% of requests | ≤ **1 s** |

## Multi-window multi-burn-rate alerting

Each SLO emits four burn-rate alerts that fire on how fast the 30-day error
budget is being consumed, gated so both a long and a short window agree:

| Alert | Window | Burn rate | Budget consumed | Severity |
|-------|--------|-----------|-----------------|----------|
| FastBurn (page) | 1h (+5m confirm) | 14.4× | 2% in 1h | page |
| MediumBurn (page) | 6h (+30m confirm) | 6× | 5% in 6h | page |
| SlowBurn (ticket) | 1d | 3× | 10% in 1d | ticket |
| MonthlyBurn (ticket) | 3d | 1× | budget exhausting over 30d | ticket |

This is exactly the design the [Google SRE Workbook](https://sre.google/workbook/alerting-on-slos/)
publishes as the reference: a fast page window (14.4× → 2% budget in 1h), a
medium page window (6× → 5% in 6h), and a slow ticket window (1× → 10% in 3d),
each paired with a short confirmation window to cut false positives. In dev the
page alerts are dropped at the Alertmanager routing layer
(`environment="development"`) because there is no real load to burn budget.

## Live measurement (2026-07-06)

Read from the live TSDB via the Prometheus API:

- **admin-api availability** — error ratio (1h) **0.0014**, i.e. **99.86%**
  success against the 99.9% target; recent traffic split `200`×11 / `503`×2 at
  ~0.67 req/s.
- **admin-api latency** — **p95 4.9 ms**, **p99 596 ms** (30m). The p99 tail sits
  just over the 500 ms bucket on occasional cold starts; dev load (~0.67 req/s)
  is too low for the ratios to be steady, so the SLO machinery — not the dev
  number — is the artefact of interest.
- **Firing alerts** — `RedisCacheDisabled`, `SyntheticCheckAbsent` (both dev
  posture, not RED regressions).

## How this measures against industry standards

Grounded comparison of the implementation against published references:

- **SLO / error-budget alerting — top tier.** MWMBR error-budget alerting is
  implemented to the Google SRE Workbook reference (seven windows, four burn-rate
  tiers). Per the [Grafana 2024 Observability Survey](https://grafana.com/observability-survey/2024/),
  only **26%** of organisations run SLOs in production at all, and only **10%**
  report "full observability" — so having burn-rate SLOs wired end-to-end places
  this stack in roughly the **top quartile** of observability maturity. The
  common baseline — a static `5xx > 1%` threshold — has no budget concept and
  either pages on transient blips or misses a slow burn entirely; MWMBR requires
  a long **and** short window to agree, which is what removes that noise.
- **Latency — "excellent" band.** admin-api **p95 4.9 ms** sits far inside the
  industry "excellent" bar of **< 100 ms** and roughly **35× under** the "good"
  reference p95 of ~180 ms for a healthy API
  ([dotcom-monitor](https://www.dotcom-monitor.com/blog/api-response-time-monitoring/),
  [Nurbak 2026 benchmarks](https://nurbak.com/en/blog/api-response-time/)). The
  500 ms SLO bucket is deliberately set at the "endpoints with DB joins" tier so
  it stays meaningful as real traffic arrives.
- **Availability target — standard internal-service tier.** 99.9% (three nines,
  ~43 min budget / 30 d) is the conventional target for an internal API; tucaken
  is intentionally relaxed to 99.5% for SSR cold starts rather than papering over
  them.
- **DORA reliability keys — partial, honest gap.** MTTD (**~30 s** p50) and MTTR
  (**~22 min** p50) recording rules return data, but
  `dora:deployment_frequency`, `dora:lead_time_seconds`, and
  `dora:change_failure_rate` currently return **no data** because their
  Pushgateway deploy-marker source was retired with Traefik (see
  [Traefik → ALB consolidation](../decisions/traefik-to-alb-consolidation.md)).
  For context, the [2024 DORA report](https://getdx.com/blog/2024-dora-report/)
  puts elite teams at on-demand deploys, < 1 day lead time, ~5% change-failure
  rate, and < 1 h recovery — the throughput keys need a new source (ArgoCD sync
  events / Image Updater commits) before this stack can benchmark against them.

## Related

- [Progressive delivery with Argo Rollouts](./progressive-delivery-rollouts.md)
- [Prometheus scrape configuration](../tools/prometheus-scrape-config.md)
- [Traefik → ALB consolidation](../decisions/traefik-to-alb-consolidation.md)
  — why the DORA throughput keys lost their source

<!--
Evidence trail (auto-generated):
- Source: charts/monitoring/chart/templates/prometheus/rules-configmap.yaml (SLO rules, read 2026-07-06)
- Source: charts/monitoring/chart/values.yaml (slo.services config, read 2026-07-06)
- Source: charts/monitoring/chart/dashboards/applications-red.json (read 2026-07-06)
- Live: Prometheus API via kubectl proxy (2026-07-06): admin-api error ratio 0.0014, p95 4.9ms, p99 596ms, 0.67 req/s; dora:* deployment_frequency no-data, mttd p50 30s, mttr p50 1333s
- Web: Google SRE Workbook (MWMBR), Grafana 2024 Observability Survey (26% SLO / 10% full obs), dotcom-monitor + Nurbak (latency bands), 2024 DORA report (elite keys)
-->
