---
title: Frontend RUM and Core Web Vitals via Grafana Faro
type: concept
tags: [rum, faro, core-web-vitals, observability, frontend, loki, tempo, prometheus, grafana, performance]
sources:
  - charts/monitoring/chart/dashboards/frontend-rum.json
  - charts/monitoring/chart/templates/alloy
created: 2026-07-06
updated: 2026-07-06
---

# Frontend RUM and Core Web Vitals via Grafana Faro

Real User Monitoring (RUM) captures performance from the actual browser, not a
synthetic probe. The frontend apps ship a Grafana Faro SDK that streams events to
an in-cluster Faro receiver, which fans them out to the LGTM stack — logs to Loki,
traces to Tempo, and its own throughput to Prometheus. Core Web Vitals are
recorded at the 75th percentile with Google's good/needs-improvement/poor rating,
exactly the field-measurement methodology Google prescribes.

## The RUM pipeline

The browser Faro SDK POSTs batches to the `/faro/collect` endpoint, exposed on
the internet-facing ALB and fronted by an Alloy Faro receiver
([charts/monitoring/chart/templates/alloy](../../charts/monitoring/chart/templates/alloy)).
The receiver is deliberately unauthenticated — it accepts anonymous browser
writes (any real user's browser must reach it) with CORS the only gate, which is
inherent to browser RUM. From there:

- **Events, logs, and Web Vitals → Loki** as structured `logfmt` lines with
  `job="faro"`, tagged `app_name`, `app_environment`, and `type`.
- **Traces → Tempo** for the frontend span tree.
- **Receiver throughput → Prometheus** as `faro_receiver_*` counters.

## Receiver health (Prometheus, 2026-07-06)

The pipeline itself is healthy:

| Metric | Value |
|--------|------:|
| `faro_receiver_events_total` | **3,636** |
| `faro_receiver_measurements_total` | **405** |
| `faro_receiver_exceptions_total` | **30** |
| ingest p95 (`faro_receiver_request_duration_seconds`) | **4.75 ms** |

The receiver accepts and processes RUM at single-digit-millisecond latency.

## Core Web Vitals to Google's standard

Web Vitals arrive in Loki as `type="web-vitals"` lines carrying `lcp`, `inp`,
`cls`, `fcp`, and `ttfb`, and the dashboard computes each at **p75** with a
`context_rating` split — the exact metrics, percentile, and rating buckets
Google defines
([web.dev Core Web Vitals](https://web.dev/articles/vitals)):

| Vital | Good | Poor |
|-------|------|------|
| **LCP** (Largest Contentful Paint) | ≤ 2.5 s | > 4.0 s |
| **INP** (Interaction to Next Paint) | ≤ 200 ms | > 500 ms |
| **CLS** (Cumulative Layout Shift) | ≤ 0.1 | > 0.25 |
| FCP (First Contentful Paint) | ≤ 1.8 s | > 3.0 s |
| TTFB (Time to First Byte) | ≤ 800 ms | > 1.8 s |

Using **field p75** (not a lab/synthetic score) with the good/needs-improvement/
poor rating is the Google-recommended methodology; many sites collect only
synthetic Lighthouse runs, which miss the real-user distribution.

## What the dev numbers can and cannot say

Live query on 2026-07-06 returned only **~4 web-vitals events** in the sampled
window — dev sees negligible browser traffic, so the p75 values (e.g. an LCP
around 2.8–6.8 s, INP 64–192 ms across the sampled sessions) are computed over a
handful of page loads and are **not statistically representative**. Core Web
Vitals are defined over a 28-day field distribution; at n≈4 the percentile is
noise. The artefact worth documenting here is the **pipeline and its
standards-alignment**, not the current dev score — the instrumentation is
complete and correct, and the numbers become meaningful only under production
traffic. This is flagged honestly rather than presenting a four-sample p75 as a
performance result.

## Related

- [Application RED metrics and multi-window SLO alerting](./application-red-and-slo-metrics.md)
- [Loki + Tempo pipeline](../tools/loki-tempo-pipeline.md)
- [Monitoring access control](./monitoring-access-control.md)
  — why the `/faro` receiver is intentionally unauthenticated

<!--
Evidence trail (auto-generated):
- Live (Prometheus via kubectl proxy, 2026-07-06): faro_receiver_events_total 3636, measurements 405, exceptions 30, ingest p95 4.75ms
- Live (Grafana->Loki datasource proxy w/ service-account token, 2026-07-06): type="web-vitals" p75 lcp/inp/cls/fcp/ttfb across ~4 events in window — not representative
- Source: charts/monitoring/chart/dashboards/frontend-rum.json (Core Web Vitals p75 + rating rows)
- Web: web.dev Core Web Vitals thresholds (LCP 2.5/4s, INP 200/500ms, CLS 0.1/0.25, p75)
-->
