---
title: RDS instance metrics via YACE — the CloudWatch metric catalogue
type: concept
tags: [rds, cloudwatch, yace, prometheus, observability, database, postgresql, finops, benchmarks]
sources:
  - charts/monitoring/chart/dashboards/database.json
  - charts/monitoring/chart/templates/yace
  - charts/monitoring/chart/templates/grafana/datasources-configmap.yaml
created: 2026-07-06
updated: 2026-07-06
---

# RDS instance metrics via YACE — the CloudWatch metric catalogue

Amazon RDS is a managed service, so there is no node-exporter or
postgres-exporter on the database host — instance-level health is available
**only through CloudWatch**. YACE (Yet Another CloudWatch Exporter) scrapes the
`AWS/RDS` namespace and republishes it into Prometheus as `aws_rds_*` series, so
RDS sits on the same dashboards and alerting as the rest of the platform. This
doc catalogues those metrics with live values read on 2026-07-06 and benchmarks
them against AWS's recommended alarm thresholds.

## Why the metrics come via CloudWatch, not a host exporter

Everything else in the cluster exposes a `/metrics` endpoint that Prometheus
scrapes directly. RDS cannot — AWS owns the host. CloudWatch is the only source
of `CPUUtilization`, `FreeableMemory`, `DatabaseConnections`, IOPS, and latency
for the instance. YACE bridges that gap: it queries CloudWatch on a schedule and
exports the results as Prometheus metrics labelled with
`dimension_DBInstanceIdentifier`, so the `database` dashboard and any alert rule
read RDS exactly like a first-class Prometheus target. The migration from
querying CloudWatch directly in Grafana to the YACE→Prometheus path is recorded
in [RDS observability & YACE migration](../projects/rds-observability-yace-migration.md).

## The metric catalogue (live, 2026-07-06)

Instance `k8s-dev-platform-rds-iso`, read from Prometheus via the YACE export:

| Metric | Live value | Meaning |
|--------|-----------:|---------|
| `aws_rds_cpuutilization_average` | **5.69 %** | CPU load |
| `aws_rds_database_connections_average` | **3.4** | open connections (pooled — see below) |
| `aws_rds_freeable_memory_average` | **369 MB** | RAM available before swap |
| `aws_rds_free_storage_space_average` | **17.7 GB** | free disk |
| `aws_rds_read_iops_average` / `write_iops` | **0.32 / 7.09** | disk operations/s |
| `aws_rds_read_latency_average` / `write_latency` | **0.25 ms / 1.33 ms** | per-op disk latency |
| `aws_rds_burst_balance_average` | **99 %** | gp2 burst-credit balance |
| `aws_rds_dbload_average` | **0** | active sessions (Performance Insights) |

## Connections are low because of PgBouncer

Only **3.4** connections reach RDS despite many client pods, because all traffic
goes through the PgBouncer pooler — the connection multiplexer keeps a small
server-side pool regardless of client count
([PgBouncer connection pooling](./pgbouncer-connection-pooling.md)). This is the
metric behaving as designed, not idle capacity.

## How this measures against AWS's recommended thresholds

Benchmarked against the AWS CloudWatch
[recommended RDS alarms](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Best_Practice_Recommended_Alarms_AWS_Services.html):

- **CPU 5.69%** — the AWS action threshold is 80% (aim < 70%). The instance runs
  at roughly **1/12th** of the healthy ceiling; CPU is not a constraint.
- **Read/write latency 0.25 ms / 1.33 ms** — well inside the < 10 ms healthy bar
  (~**7×** headroom on writes); storage is fast.
- **Burst balance 99%** — the recommended floor is 20%; near-full credit means no
  IO throttling risk.
- **Freeable memory 369 MB — below the 500 MB recommended-alarm line.** AWS
  suggests alerting under 500 MB (critical under 100 MB) because low memory pushes
  the OS into swap, which collapses DB performance. At 369 MB this dev instance is
  in the **warn band** — above the critical floor but under the best-practice
  target. A real watch-item, honestly flagged.
- **Free storage 17.7 GB — in the "first alarm" band.** AWS's pattern is a first
  alarm around 25 GB and a critical around 10 GB. At 17.7 GB the instance is
  between the two — comfortable for now, but on the growth radar.

Net: performance headroom is excellent (CPU, latency, burst), while **memory and
storage are the two dimensions to watch** — exactly the kind of signal the
metric catalogue exists to surface.

## Related

- [RDS observability & YACE migration](../projects/rds-observability-yace-migration.md)
- [PgBouncer connection pooling](./pgbouncer-connection-pooling.md)
- [Application RED metrics and multi-window SLO alerting](./application-red-and-slo-metrics.md)

<!--
Evidence trail (auto-generated):
- Live (Prometheus/YACE via kubectl proxy, 2026-07-06): aws_rds_* catalogue for k8s-dev-platform-rds-iso — CPU 5.69%, conns 3.4, freeable mem 369MB, free storage 17.7GB, read/write latency 0.25/1.33ms, burst 99%
- Live (Grafana datasource proxy with service-account token, 2026-07-06): CloudWatch + rds-postgres datasources reachable
- Web: AWS CloudWatch recommended alarms for RDS (CPU 80%, freeable memory 500MB/100MB, free storage 25GB/10GB, burst 20%)
- Source: charts/monitoring/chart/dashboards/database.json
-->
