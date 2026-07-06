---
title: Alerting posture — SLO burn-rate, infra alerts, and severity routing
type: concept
tags: [sre, alerting, prometheus, alertmanager, slo, error-budget, routing, incident-response, observability]
sources:
  - charts/monitoring/chart/templates/prometheus/rules-configmap.yaml
  - charts/monitoring/chart/templates/prometheus/rules-infra-configmap.yaml
  - charts/monitoring/chart/templates/alertmanager/configmap.yaml
created: 2026-07-06
updated: 2026-07-06
---

# Alerting posture — SLO burn-rate, infra alerts, and severity routing

The cluster runs a two-layer alerting design: **symptom-based SLO burn-rate
alerts** on the user-facing services and **cause-based infrastructure alerts**
on the components beneath them, routed by severity through Alertmanager with
dev-suppression, inhibition, and MTTR tracking. This doc inventories the live
alerting surface (2026-07-06) and how a firing alert reaches a human.

## Scale of the alerting surface

Read live from the Prometheus rules API:

| | Count |
|---|------:|
| Alerting rules | **59** |
| Recording rules | **52** |
| Alert groups | **13** |
| Live states | 54 inactive, **3 pending, 2 firing** |

The 52 recording rules pre-compute the SLO ratios and cost/DORA aggregates so the
alerts and dashboards read cheap, pre-baked series rather than re-deriving them
on every evaluation.

## Layer 1 — symptom alerts (SLO burn-rate)

The two user-facing services each carry a full multi-window multi-burn-rate SLO
alert set (9 alerts each: `slo:admin-api:alerts`, `slo:tucaken-app:alerts`),
derived from the SLI recording rules described in
[Application RED metrics and multi-window SLO alerting](./application-red-and-slo-metrics.md).
These are **symptom** alerts — they fire on the user-visible outcome (error rate,
latency budget burn) regardless of which component caused it, which is the
Google-SRE-recommended primary paging signal.

## Layer 2 — cause alerts (infrastructure)

Beneath the symptoms, the infra groups alert on the components that produce them:

| Group | Alerts | Covers |
|-------|-------:|--------|
| `infra:database` | 10 | PgBouncer pool, postgres-exporter, RDS (CPU credits, memory, storage, disk queue) |
| `observability:redis` | 6 | Redis broker/cache liveness + effectiveness |
| `infra:capacity` | 4 | RDS memory / node disk / pod density / TSDB cardinality early-warnings |
| `infra:network` | 4 | VPC CNI IP exhaustion, ALB 5xx |
| `observability:pipeline_integrity` | 4 | scrape/RUM/synthetic pipeline health |
| `infra:karpenter` | 2 | controller down, zombie nodes |
| `infra:readiness` | 2 | admin-api / tucaken-app not ready |
| `app:abuse` | 2 | 429 rate-limit spikes |

Cause alerts run at `warning` mostly, so a symptom SLO page arrives with a
cause-alert context already firing next to it.

## Routing — how a firing alert reaches a human

Alertmanager routes by label
([alertmanager/configmap.yaml](../../charts/monitoring/chart/templates/alertmanager/configmap.yaml)),
grouped by `alertname, service, slo`:

1. **`environment = development` → `blackhole`.** Dev alerts are dropped for human
   routing — the SLO/infra rules still evaluate and show on dashboards, but no
   page fires from dev noise. (This is why the live cluster has firing alerts
   with nobody paged.)
2. **`severity = critical` → SNS**, `repeat_interval: 30m`.
3. **`severity = warning` → SNS**, `repeat_interval: 4h`.
4. **`mttr-webhook` receiver** additionally receives firing→resolved transitions
   regardless of severity, feeding incident-duration (MTTR) back into Prometheus.
5. **Inhibition rules** suppress downstream alerts when an upstream cause is
   already firing, so one root cause does not fan out into a page storm.

## Live state and what it means

Of 59 alerts, **2 are firing and 3 pending** (2026-07-06) — the pending ones are
the new `infra:capacity` early-warnings (RDS freeable memory < 500 MB, node root
disk > 80%) doing exactly their job, and the firing ones are dev-posture signals
(`RedisCacheDisabled`, `SyntheticCheckAbsent`). All are routed to `blackhole` in
dev, so this is a healthy evaluation surface, not an incident.

## How this measures against SRE practice

- **SLO burn-rate paging** is the Google SRE Workbook primary signal, and per the
  [Grafana 2024 Observability Survey](https://grafana.com/observability-survey/2024/)
  only **~26%** of organisations run SLOs in production at all — so having
  symptom-based burn-rate paging on the user-facing services is already top-tier.
- **Symptom-over-cause layering, severity-based routing, inhibition, and
  dev-suppression** together are a mature Alertmanager posture; the common
  baseline is a flat list of static-threshold alerts all paging the same channel.
- The **52 recording rules** and MTTR feedback loop show the alerting is treated
  as a system with its own SLIs, not a pile of thresholds.

## Related

- [Application RED metrics and multi-window SLO alerting](./application-red-and-slo-metrics.md)
- [GitOps security-hardening sweep](../projects/2026-07-security-hardening-sweep.md)

<!--
Evidence trail (auto-generated):
- Live (Prometheus rules API via kubectl proxy, 2026-07-06): 59 alerting + 52 recording rules, 13 alert groups, states 54 inactive/3 pending/2 firing; groups infra:database 10, slo:*:alerts 9 each, observability:redis 6, infra:capacity 4, infra:network 4, ...
- Source: charts/monitoring/chart/templates/alertmanager/configmap.yaml (dev blackhole, critical/warning->SNS, mttr-webhook, inhibition)
- Web: Grafana 2024 Observability Survey (26% SLO adoption), Google SRE Workbook (symptom paging)
-->
