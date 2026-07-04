---
title: RDS PostgreSQL Observability — current implementation and YACE migration
type: project
tags: [observability, rds, postgres, cloudwatch, prometheus, yace, grafana, migration]
sources:
  - charts/monitoring/chart/dashboards/database.json
  - charts/monitoring/chart/templates/grafana/configmap.yaml
  - charts/platform-rds/chart/templates/postgres-exporter.yaml
  - charts/platform-rds/chart/templates/pgbouncer.yaml
  - scripts/patch-database-dashboard.py
created: 2026-07-04
updated: 2026-07-04
---

# RDS PostgreSQL Observability — current implementation and YACE migration

This document records the **current** RDS PostgreSQL observability implementation
in full — every datasource, every metric, every panel — explains the RDS
migration that forced the recent rework, sets out **why** the current
CloudWatch-datasource approach is unreliable, and defines the migration to a
Prometheus-first design (YACE + `postgres_exporter` + the community PostgreSQL
dashboard 9628).

All facts below were verified against the live `dev` account
(`771826808455`, `eu-west-1`) and the running Grafana on 2026-07-04. No metric
value in this document is estimated — each was read from the live system.

---

## 1. Summary

- The **Database — RDS Postgres / pgvector** dashboard (Grafana uid `database`,
  **57 panels across 12 rows**) draws from **three** datasources: the Grafana
  **CloudWatch** datasource, the **RDS PostgreSQL** SQL datasource (through
  PgBouncer), and **Prometheus** (via `postgres_exporter` and
  `pgbouncer-exporter`).
- The RDS instance was migrated into **isolated (no-NAT) subnets** by
  snapshot-and-restore, which **renamed** it from `k8s-dev-platform-rds` to
  `k8s-dev-platform-rds-iso`. The dashboard had the old identifier **hardcoded
  in ~14 CloudWatch panels**, so every RDS metric panel went **"No data"** — the
  incident that triggered this work.
- The Grafana **CloudWatch datasource is the fragile link**: it does not
  interpolate a dashboard template variable into a metric dimension under
  provisioned JSON, its queries fail under the image-renderer's service account,
  and it re-breaks on any instance rename. These are structural, not
  configuration, faults.
- **Decision:** migrate RDS/CloudWatch metrics onto **Prometheus via YACE**
  (yet-another-cloudwatch-exporter), keep engine metrics on the already-deployed
  `postgres_exporter` with the maintained **dashboard 9628**, and retain
  **Performance Insights** in the AWS console for query-level analysis. This
  removes the CloudWatch datasource from the critical path entirely.

---

## 2. The system under observation

| Property | Value |
|---|---|
| Instance identifier | `k8s-dev-platform-rds-iso` |
| Engine | PostgreSQL **18.3** |
| Instance class | `db.t4g.small` (burstable, 2 vCPU, 2 GiB) |
| Storage | `gp2`, 20 GiB, single-AZ |
| Network | `PRIVATE_ISOLATED` subnets — **no NAT gateway** |
| Region / account | `eu-west-1` / `771826808455` |
| Client path | Applications → **PgBouncer** (`platform` ns, port 5432, transaction pooling) → RDS |
| Verified health (2026-07-04) | cache hit **99.89%**, connections **13 / 181**, `pg_up=1` |

The instance is burstable, so **CPU credit exhaustion** is a real failure mode
(it was the reason for the earlier `t4g.micro` → `t4g.small` bump). Credit
metrics are therefore first-class on the dashboard.

---

## 3. Current datasources

Grafana has eight datasources; **three** feed the database dashboard:

| Datasource | uid | Type | Role for RDS observability |
|---|---|---|---|
| CloudWatch | `cloudwatch` | `cloudwatch` | AWS/RDS metrics + RDS PostgreSQL logs. `authType: default` (Grafana pod IAM), region `eu-west-1`. |
| RDS PostgreSQL | `rds-postgres` | `grafana-postgresql-datasource` | Live SQL against the database through PgBouncer (engine health, pgvector, users). |
| Prometheus | `prometheus` | `prometheus` | `postgres_exporter` + `pgbouncer-exporter` + OTel span-metrics. Default datasource. |

(The other five — `cloudwatch-edge`, `loki`, `pyroscope`, `steampipe`, `tempo` —
are unrelated to this dashboard.)

The datasource **health check passes** for CloudWatch ("Successfully queried the
CloudWatch metrics API") — the datasource itself is correctly configured. The
problems described in §5 are in the query/interpolation/render path, not the
credentials or region.

---

## 4. Full metric inventory

### 4.1 CloudWatch — `AWS/RDS` namespace (26 metrics)

Selected today with `DBInstanceIdentifier="*"`, `matchExact=false` (see §5.3).

| Row | Metrics |
|---|---|
| **RDS instance health** | `CPUUtilization`, `DatabaseConnections`, `FreeableMemory`, `FreeStorageSpace`, `ReadIOPS`, `WriteIOPS`, `ReadLatency`, `WriteLatency` |
| **Compute & burst credits** | `CPUCreditBalance`, `CPUCreditUsage`, `SwapUsage`, `BurstBalance`, `EBSIOBalance%`, `EBSByteBalance%` |
| **Throughput & network** | `NetworkReceiveThroughput`, `NetworkTransmitThroughput`, `ReadThroughput`, `WriteThroughput`, `DiskQueueDepth`, `TransactionLogsGeneration` |
| **DB load (Performance Insights)** | `DBLoad`, `DBLoadCPU`, `DBLoadNonCPU`, `MaximumUsedTransactionIDs` |
| **Connection failures** | `IamDbAuthConnectionFailure`, `IamDbAuthConnectionSuccess` |

Representative verified reading: `CPUCreditBalance` returned **36 datapoints**
over 3h, climbing 56.8 → 105.0 (via Grafana `/api/ds/query`).

### 4.2 CloudWatch Logs — `/aws/rds/instance/k8s-dev-platform-rds-iso/postgresql`

Four Logs Insights panels: **Recent errors / warnings**, **Connection events /
min**, **Error / warning rate**, **Connection failures (too-many / auth /
pg_hba)**. These are the only panels that still carry the concrete instance id —
CloudWatch Logs ARNs take no wildcard.

### 4.3 RDS PostgreSQL — live SQL (16 panels, via PgBouncer)

| Panel | Query summary |
|---|---|
| RDS reachable | `SELECT 1` |
| Connections used / max | `pg_stat_activity` count vs `max_connections` |
| Cache hit ratio | `blks_hit / (blks_hit+blks_read)` over `pg_stat_database` |
| Deadlocks (cumulative) | `sum(deadlocks)` from `pg_stat_database` |
| Blocked backends | `pg_stat_activity WHERE wait_event_type='Lock'` |
| Connections by state / application | grouped `pg_stat_activity` |
| Top tables by dead tuples | `pg_stat_user_tables` (autovacuum pressure) |
| pgvector — total vectors / by repo / table size / index health | `document_embeddings` + `pg_relation_size` |
| Users & activity | `users`, Bedrock spend, repos + KB quality, per-user directory |

### 4.4 Prometheus (13 panels)

| Source | Metrics |
|---|---|
| `postgres_exporter` (`:9187`, direct to RDS) | `pg_up`, `pg_stat_database*`, `pg_stat_activity*`, `pg_stat_user_tables*`, settings, locks |
| `pgbouncer-exporter` (`:9127`, PgBouncer admin console) | `pgbouncer_pools_client_active_connections`, `..._client_waiting_connections`, `..._server_active_connections`, `..._server_idle_connections`, `pgbouncer_pools_client_maxwait_seconds`, `pgbouncer_stats_totals_received_bytes_total`, `..._sent_bytes_total`, `..._queries_pooled_total`, `..._sql_transactions_pooled_total`, `pgbouncer_databases_max_connections` |
| OTel span-metrics | `traces_spanmetrics_calls_total{span_kind}`, `traces_spanmetrics_latency_bucket` (DB call rate + p95 by service) |

`postgres_exporter` runs with `--no-collector.stat_bgwriter` (PostgreSQL 17+
moved the checkpoint columns to `pg_stat_checkpointer`; the exporter's legacy
`stat_bgwriter` query errors on PG18). Verified: `pg_up=1`, pod healthy, 0
restarts.

---

## 5. Why the current CloudWatch approach is unreliable

### 5.1 The trigger: an instance rename broke every RDS panel

The RDS instance was migrated into **isolated (no-NAT) subnets** to avoid NAT
gateway cost, using **snapshot → restore** (`DatabaseInstanceFromSnapshot`) with
explicit SSM-resolved VPC/subnets. Restoring from a snapshot creates a **new
instance with a new identifier** — `k8s-dev-platform-rds` became
`k8s-dev-platform-rds-iso`. A pre-isolation safety snapshot
(`k8s-dev-platform-rds-pre-isolated-20260704`) was retained.

The dashboard had the **old** identifier hardcoded in ~14 CloudWatch panels'
`DBInstanceIdentifier` dimension, so after the migration **every RDS metric
panel read "No data"** while the metrics themselves were healthy in CloudWatch.
This is the failure this project exists to make impossible.

### 5.2 Template variables do not interpolate into CloudWatch dimensions

The obvious fix — a `rds_instance` dashboard variable referenced as
`${rds_instance}` — **does not work** under provisioned-JSON dashboards:

- Tried as a `constant` variable → the literal string `${rds_instance}` leaked
  into the CloudWatch dimension → "No data".
- Tried as a `custom` variable → same result, including when the value was
  passed **explicitly** to the renderer.
- **Proof** (Grafana `/api/ds/query`, identical `CPUCreditBalance` query):
  - `DBInstanceIdentifier = k8s-dev-platform-rds-iso` → **36 datapoints**.
  - `DBInstanceIdentifier = ${rds_instance}` (un-interpolated) → **empty**.

Interpolation of a variable into a CloudWatch **metric dimension** simply does
not happen in this Grafana + provisioning combination.

### 5.3 Current mitigation: dimension wildcard (rename-proof, but a workaround)

The panels now use `DBInstanceIdentifier="*"` with `matchExact=false`.
CloudWatch returns the single instance's series and auto-labels it with the real
id, so a rename can no longer break the panels. **Verified:** `"*"` returned
exactly **1 series, 36 datapoints, label `k8s-dev-platform-rds-iso`**.

This is a genuine improvement (rename-proof, no hardcoded id) but it is still a
workaround on a datasource that has a second, worse problem:

### 5.4 The image-renderer cannot query CloudWatch

Server-side panel rendering (Grafana Image Renderer) returns **"No data" for
every CloudWatch panel**, at any time range and up to a 120 s timeout — while a
Prometheus time-series panel and a Postgres panel on the **same dashboard render
with data**. Direct CloudWatch `/api/ds/query` returns data. The conclusion:
the renderer's service account cannot execute CloudWatch queries. This breaks
any **rendered report, alert image, or snapshot** built on CloudWatch panels,
and makes the panels impossible to validate programmatically.

### 5.5 Structural downsides

- **Three datasources, three reliability profiles.** Prometheus and Postgres
  panels are dependable; the CloudWatch ones are not — but they sit in the same
  dashboard, so "the dashboard is broken" is ambiguous.
- **CloudWatch GetMetricData is billed per call** and adds query latency to
  every dashboard open.
- **Hand-maintained**: the 57-panel dashboard is generated by
  `scripts/patch-database-dashboard.py`; every metric addition is a code change.
- **No native alerting** on the RDS metrics: a Prometheus alert rule cannot
  evaluate a CloudWatch metric, so RDS credit/storage/memory alarms have no home
  in the current stack (they would need CloudWatch Alarms or a bridge).

---

## 6. Target architecture — Prometheus-first

The migration moves AWS/RDS metrics **into Prometheus** so the whole dashboard
runs on **one reliable datasource**, and adopts maintained dashboards instead of
the hand-rolled one.

```
                         ┌──────────────────────────────────────────┐
 AWS CloudWatch  ──────► │ YACE (yet-another-cloudwatch-exporter)    │
 (AWS/RDS metrics)       │  scrapes GetMetricData on a schedule,     │
                         │  re-exposes as aws_rds_* Prometheus series│
                         └───────────────┬──────────────────────────┘
                                         │  scrape
 RDS engine (pg_stat_*) ─► postgres_exporter ─┐
 PgBouncer console ──────► pgbouncer-exporter ─┼──► Prometheus ──► Grafana
 OTel DB spans ──────────► span-metrics ───────┘        │            (one datasource)
                                                        └──► Alertmanager (native alerts)

 Deep query analysis (top SQL, wait events)  ─► RDS Performance Insights (AWS console)
 RDS PostgreSQL logs                          ─► (future) CloudWatch Logs → Loki
```

### 6.1 Components

| Component | Status | Purpose |
|---|---|---|
| **YACE** | **to deploy** — new chart | Scrapes `AWS/RDS` CloudWatch metrics → Prometheus `aws_rds_*` series, discovered by `DBInstanceIdentifier` tag (no hardcoded id). |
| **postgres_exporter** | **already deployed** | Engine metrics (`pg_stat_*`) → Prometheus. Feeds the community dashboard 9628. |
| **pgbouncer-exporter** | already deployed | Pool metrics → Prometheus. |
| **Dashboard 9628** ("PostgreSQL Database") | to import | Maintained community dashboard for `postgres_exporter`; replaces the hand-rolled engine-health panels. |
| **YACE RDS dashboard** | to import/adapt | Standard RDS-on-Prometheus dashboard for the `aws_rds_*` series. |
| **Performance Insights** | native, no change | Query-level drilldown (top SQL, wait events) — better than any hand-built panel. |

### 6.2 Why YACE is the industry-standard answer

YACE polls CloudWatch on an interval and republishes metrics as Prometheus
series, so:

- **One datasource.** RDS infra metrics sit next to engine, pool, and cluster
  metrics — reliable PromQL, one query language, one alerting engine.
- **Native alerting.** Prometheus rules can finally evaluate RDS credit /
  storage / memory / connection metrics; today they cannot.
- **Renders everywhere.** No CloudWatch datasource in the render path, so the
  §5.4 renderer failure disappears; snapshots and alert images work.
- **Tag-based discovery.** YACE discovers instances by tag/dimension, so an
  instance rename is picked up automatically — the §5.1 incident cannot recur.
- **Bounded CloudWatch cost.** One exporter on a fixed schedule instead of
  per-dashboard-open `GetMetricData` calls.

### 6.3 Metric mapping (representative)

YACE names series `aws_<service>_<metric_snake_case>_<statistic>` and attaches
an `aws_rds_info` metadata series carrying `dbinstance_identifier`. The exact
names are set by the YACE `metrics[]` + `statistics` config; representative
mapping:

| Current CloudWatch metric | Prometheus (YACE) series |
|---|---|
| `CPUUtilization` | `aws_rds_cpuutilization_average` |
| `CPUCreditBalance` | `aws_rds_cpucredit_balance_average` |
| `FreeableMemory` | `aws_rds_freeable_memory_average` |
| `FreeStorageSpace` | `aws_rds_free_storage_space_average` |
| `DatabaseConnections` | `aws_rds_database_connections_average` |
| `ReadLatency` / `WriteLatency` | `aws_rds_read_latency_average` / `aws_rds_write_latency_average` |
| `DiskQueueDepth` | `aws_rds_disk_queue_depth_average` |
| `DBLoad` | `aws_rds_dbload_average` |

> Engine-internal signals (cache hit, deadlocks, dead tuples, `MaximumUsedTransactionIDs`
> semantics) are better served by `postgres_exporter` / 9628, which reads them
> from `pg_stat_*` directly rather than via CloudWatch.

---

## 7. Migration plan

1. **Deploy YACE** as a new chart (`charts/yace/` or a subchart of `monitoring`)
   with an IAM role (Pod Identity) scoped to `cloudwatch:GetMetricData`,
   `cloudwatch:ListMetrics`, `tag:GetResources`; discovery job for `AWS/RDS`
   filtered to the platform instance's tag. Prometheus scrape annotations.
2. **Import dashboard 9628** (PostgreSQL / `postgres_exporter`) as a provisioned
   ConfigMap dashboard; adjust datasource uid to `prometheus`.
3. **Add a YACE RDS dashboard** (or a small set of `aws_rds_*` panels) covering
   the §4.1 metric set from Prometheus.
4. **Add Prometheus alert rules** for the RDS metrics that had no home:
   `CPUCreditBalance` low, `FreeStorageSpace` low, `FreeableMemory` low,
   `DatabaseConnections` near `max_connections`, sustained `DiskQueueDepth`.
5. **Retire the fragile panels** from `database.json`: remove the CloudWatch
   metric rows once the Prometheus equivalents are verified; keep the live-SQL
   and Prometheus rows. Update `patch-database-dashboard.py` accordingly.
6. **(Future) Ship RDS logs to Loki** via a CloudWatch Logs subscription so the
   log panels leave the CloudWatch datasource too.
7. **Keep Performance Insights** as the query-level tool in the AWS console.

### Retained vs retired

| Keep | Retire |
|---|---|
| `postgres_exporter` engine panels (→ 9628) | CloudWatch **metric** panels (→ YACE/Prometheus) |
| `pgbouncer-exporter` pool panels | The `rds_instance` variable / wildcard workaround |
| OTel span-metric panels | Per-dashboard-open `GetMetricData` cost |
| Live-SQL pgvector / users panels | (Eventually) CloudWatch Logs panels → Loki |

---

## 8. Consequences and trade-offs

- **Gain:** one reliable datasource, native RDS alerting, renders/snapshots work,
  rename-proof discovery, bounded CloudWatch cost, maintained dashboards.
- **Cost:** one more in-cluster component (YACE) to run and give IAM; a short
  metric-name relabel when adopting 9628 / the RDS dashboard.
- **Latency:** YACE adds a scrape-interval delay (typically 1–5 min) versus a
  live CloudWatch read — acceptable for infra metrics, and matched to
  CloudWatch's own 1-minute granularity.
- **Not replaced:** Performance Insights stays the tool for wait-event / top-SQL
  analysis; YACE does not attempt to reproduce it.

---

## 9. Related migration context (this work stream)

The observability rework rode alongside several platform changes; recorded here
so the "why" is not lost:

- **RDS → isolated subnets** (no NAT): VPC resolved via SSM parameters, explicit
  `rds.SubnetGroup`, snapshot → `DatabaseInstanceFromSnapshot`. Caused the
  instance rename in §5.1.
- **`postgres_exporter` deployed** into the `platform` namespace, connecting
  directly to RDS (not via PgBouncer — transaction pooling breaks the
  session-level `pg_stat_*` queries), with `--no-collector.stat_bgwriter` for
  PG18.
- **Prometheus hardened**: memory raised to 2 GiB and a `configmap-reload`
  sidecar added so rule/config edits hot-reload without a WAL-replay restart.
- **Dashboard fixes**: `constant` → `custom` variable (did not resolve the
  interpolation problem), then the `DBInstanceIdentifier="*"` wildcard (the
  current, rename-proof state).

### Adjacent DB-log findings (out of scope for YACE, tracked separately)

- `postgres_exporter` `checkpoints_timed` / `pg_stat_statements` errors —
  **resolved**; they came from the pre-fix exporter pod and stopped once the
  `--no-collector.stat_bgwriter` pod took over.
- `relation "resume_imports" already exists` — the `platform-rds-bootstrap`
  runner re-applies **every** migration on **every** run (no `schema_migrations`
  tracking) and migration `010` uses a bare `CREATE TABLE`. Fix: migration-state
  tracking and/or `IF NOT EXISTS`.
- `syntax error at or near "$"` — a separate transient client; not yet
  attributed (needs `log_statement` capture).

---

## 10. Verification log (2026-07-04)

| Check | Result |
|---|---|
| CloudWatch datasource health | OK — metrics + logs API reachable |
| `CPUCreditBalance`, resolved id | 36 datapoints, 56.8 → 105.0 |
| `CPUCreditBalance`, `${rds_instance}` literal | empty (interpolation fails) |
| `CPUCreditBalance`, `DBInstanceIdentifier="*"` | 1 series, 36 datapoints, label `k8s-dev-platform-rds-iso` |
| Cache hit ratio (live SQL) | 99.89% |
| Connections used / max (live SQL) | 13 / 181 |
| Image-render, CloudWatch panel | "No data" (renderer cannot query CloudWatch) |
| Image-render, Prometheus panel | renders with data |
| `postgres_exporter` | `pg_up=1`, pod healthy, `--no-collector.stat_bgwriter` |
