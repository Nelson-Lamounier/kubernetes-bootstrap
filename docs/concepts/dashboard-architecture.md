---
title: Dashboard Architecture
type: concept
tags: [grafana, observability, dashboards, prometheus, loki, tempo, cloudwatch, steampipe]
sources:
  - charts/monitoring/chart/dashboards/
  - charts/monitoring/chart/templates/grafana/dashboard-provider.yaml
  - charts/monitoring/chart/templates/grafana/configmap.yaml
created: 2026-04-28
updated: 2026-04-28
---

# Dashboard Architecture

The 15 Grafana dashboards in this stack span 5 datasources and 4 signal types (metrics, logs, traces, SQL). This doc maps each dashboard to its purpose, datasources, key panels, and PromQL/LogQL patterns — with particular attention to which dashboards use span metrics from Tempo's `metrics_generator` versus querying Tempo's trace store directly.

## How dashboards are loaded

Dashboards are version-controlled as JSON files in [`charts/monitoring/chart/dashboards/`](../../charts/monitoring/chart/dashboards/). A ConfigMap mounts them at `/var/lib/grafana/dashboards` ([`templates/grafana/dashboard-provider.yaml`](../../charts/monitoring/chart/templates/grafana/dashboard-provider.yaml)). The provider polls for file changes every 60 seconds (`updateIntervalSeconds: 60`) with `allowUiUpdates: true` — UI edits are permitted but will be overwritten on the next ArgoCD sync.

The six available datasource UIDs, used across panels:

| UID | Type | What it queries |
|-----|------|----------------|
| `prometheus` | Prometheus | Metrics TSDB — cluster, apps, span metrics |
| `loki` | Loki | Pod logs, systemd journal, Faro browser events |
| `tempo` | Tempo | Distributed trace store, TraceQL |
| `cloudwatch` | CloudWatch | AWS logs and metrics, eu-west-1 |
| `cloudwatch-edge` | CloudWatch | AWS Lambda@Edge logs, us-east-1 |
| `steampipe` | PostgreSQL | SQL queries against AWS resource APIs |

## Dashboard catalog

### cluster.json — Cluster & Nodes

**Datasource:** Prometheus only  
**Purpose:** Cluster-wide health and resource utilization for operators.

Key panels and queries:

| Panel | PromQL pattern |
|-------|---------------|
| Total Nodes | `count(kube_node_status_condition{condition="Ready",status="true"} == 1)` |
| Cluster CPU % | `(1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))) * 100` |
| Cluster Memory % | `(1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)) * 100` |
| CPU per Node | Groups by `label_workload` via `kube_node_labels` join |
| Disk I/O | `rate(node_disk_read_bytes_total[5m])` / `rate(node_disk_written_bytes_total[5m])` |
| Network I/O | Filters out virtual interfaces: `{device!~"lo\|veth.*\|cali.*\|f.*"}` |
| Pods per Node | `kube_pod_info` grouped by `node`, joined to `label_workload` |
| CPU Requests vs Limits vs Capacity | `kube_pod_container_resource_requests{resource="cpu"}` |

---

### frontend.json — Frontend Performance

**Datasource:** Prometheus (Traefik metrics)  
**Purpose:** HTTP traffic, error rates, and latency for the Next.js frontend via Traefik's service metrics.

Key panels:

| Panel | PromQL pattern |
|-------|---------------|
| Request Rate | `sum(rate(traefik_service_requests_total{service=~"nextjs-app.*"}[5m]))` |
| Error Rate (5xx) | `service=~"nextjs-app.*", code=~"5.."` filter |
| Latency p50/p95/p99 | `histogram_quantile(0.50/0.95/0.99, sum(rate(traefik_service_request_duration_seconds_bucket{service=~"nextjs-app.*"}[5m])))` |
| Frontend Availability | `1 - (5xx rate / total rate)` |
| Status Code Distribution | `sum by (code) (increase(traefik_service_requests_total[1h]))` |

---

### bluegreen-rollout.json — Blue/Green Rollout Comparison

**Datasource:** Prometheus  
**Purpose:** Side-by-side comparison of active vs preview services during Blue/Green rollouts. The key feature: Prometheus scrapes both `nextjs-app` and `nextjs-app-preview` Traefik services, enabling direct comparison.

| Panel pair | Active query | Preview query |
|-----------|-------------|--------------|
| Next.js Request Rate | `service=~"nextjs-app-nextjs-.*@kubernetes"` | `service=~"nextjs-app-nextjs-preview-.*@kubernetes"` |
| Next.js 5xx Error Rate | Same service pattern with `code=~"5.."` | Same with preview pattern |
| Next.js P95 Latency | `histogram_quantile(0.95, ...)` | Same with preview service |
| Scrape Target Health | `up{job="nextjs-app"}` | `up{job="nextjs-app-preview"}` |
| Pod CPU (cAdvisor) | `container="nextjs"` | Label discriminates by pod name |

This dashboard is only useful during an active rollout. The preview panels return no data when no rollout is in progress (the preview Service exists but has no backends).

---

### nextjs.json — Next.js Application

**Datasource:** Prometheus (kube-state-metrics + cAdvisor)  
**Purpose:** Deployment health for the Next.js pod — replica count, resource consumption, restart events.

| Panel | Query |
|-------|-------|
| Replicas Available | `kube_deployment_status_replicas_available{namespace="nextjs-app",deployment="nextjs"}` |
| App Status (up/down) | `up{job="nextjs-app"}` |
| Container Restarts (24h) | `sum(increase(kube_pod_container_status_restarts_total{namespace="nextjs-app"}[24h]))` |
| Memory vs Limits | `container_memory_working_set_bytes` vs `kube_pod_container_resource_limits` |

---

### monitoring-health.json — Monitoring Stack Health

**Datasource:** Prometheus  
**Purpose:** Self-monitoring of the observability stack itself — scrape coverage, TSDB internals, component memory.

| Panel | Query |
|-------|-------|
| Target Availability | `count(up == 1)` vs `count(up == 0)` |
| Active Series | `prometheus_tsdb_head_series` |
| TSDB Storage % | `prometheus_tsdb_head_chunks_storage_size_bytes / (10 * 1024^3) * 100` |
| Ingestion Rate | `rate(prometheus_tsdb_head_samples_appended_total[5m])` |
| Component Memory | `process_resident_memory_bytes{job="prometheus"\|"loki"\|"tempo"}` |

---

### finops.json — FinOps — Cost Visibility

**Datasource:** Prometheus (cAdvisor + kube-state-metrics)  
**Purpose:** Infrastructure cost estimation using hard-coded per-node hourly rates derived from EC2 pricing.

The cost model is embedded directly in PromQL:

```promql
# Estimated Monthly Cost — node-type-aware pricing
(
  count(kube_node_labels{label_workload=~"control-plane|monitoring"}) * 0.0456
  +
  count(kube_node_labels{label_workload=~"general|argocd"}) * 0.0368
) * 730
```

This approach (hardcoded EC2 hourly rates × node count × 730h) is intentional — it avoids AWS Cost Explorer API latency and works without cloud credentials in the query path. It is an approximation, not an exact billing figure.

OpenCost metrics (`kube_node_labels`) provide per-namespace cost breakdown panels.

---

### cicd.json — CI/CD Pipeline

**Datasource:** Prometheus (GitHub Actions Exporter)  
**Purpose:** GitHub Actions workflow performance and runner status.

| Panel | Query |
|-------|-------|
| Runner Status (online/offline) | `count(github_runner_status == 1) or vector(0)` |
| CI Minutes (7d) | `sum(increase(github_workflow_usage_seconds_total[7d])) / 60` |
| Workflow Distribution (7d) | `sum by (workflow) (increase(github_workflow_usage_seconds_total[7d]))` |
| Exporter Health | `up{job="github-actions-exporter"}` |

---

### tracing.json — DynamoDB & Tracing

**Datasource:** Prometheus (span metrics) + Tempo (TraceQL) + CloudWatch  
**Purpose:** DynamoDB RED metrics and service-to-service topology. This is the primary example of span-metrics-as-Prometheus-data in this stack.

**Span metrics panels (Prometheus queries):**

| Panel | Query pattern |
|-------|--------------|
| DynamoDB Ops/sec | `rate(traces_spanmetrics_calls_total{span_name=~"ArticleService.*"}[5m])` |
| DynamoDB Latency p50/p95/p99 | `histogram_quantile(0.95, sum by (le) (rate(traces_spanmetrics_latency_bucket{span_name=~"ArticleService.*"}[5m])))` |
| DynamoDB Error Rate | `traces_spanmetrics_calls_total{status_code="STATUS_CODE_ERROR"}` rate ratio |
| DynamoDB Latency Heatmap | `increase(traces_spanmetrics_latency_bucket[5m])` |

**Service graph panels (Prometheus queries):**

| Panel | Query |
|-------|-------|
| Service-to-Service Rate | `sum by (client, server) (rate(traces_service_graph_request_total[5m]))` |
| Service-to-Service Failures | `sum by (client, server) (rate(traces_service_graph_request_failed_total[5m]))` |

**TraceQL panel (Tempo datasource directly):**

```
{ resource.service.name =~ "$service" && name = "ArticleService.getAllArticles" }
```

This is the only panel in the stack that queries Tempo's trace store directly — used for ad-hoc trace exploration. All alerting uses the Prometheus span-metric path, not TraceQL.

---

### cloud-inventory.json — Cloud Inventory & Compliance

**Datasource:** Steampipe (PostgreSQL SQL)  
**Purpose:** AWS resource audit — EBS volumes, security groups, S3, Route53, CloudFront, WAF, CloudWatch log groups.

All panels use raw SQL against Steampipe's PostgreSQL wire protocol. Example queries:

```sql
-- Unencrypted EBS volumes
SELECT count(*) AS "Unencrypted" FROM aws_ebs_volume WHERE NOT encrypted;

-- Security groups with ingress open to internet
SELECT count(DISTINCT group_id) FROM aws_vpc_security_group_rule
WHERE type='ingress' AND cidr_ipv4='0.0.0.0/0';

-- Cross-service join: EC2 → EBS volumes → snapshots
SELECT i.tags->>'Name', i.instance_id, v.volume_id, s.snapshot_id
FROM aws_ec2_instance i
JOIN aws_ebs_volume v ON ...
JOIN aws_ebs_snapshot s ON ...

-- S3 buckets without public access block
SELECT count(*) FROM aws_s3_bucket WHERE block_public_acls IS NOT TRUE;
```

Coverage: EBS volumes (total/unencrypted/orphaned), security groups (open ports, rules), EC2 instances, S3 buckets (encryption/public-block), Route53 zones and records, CloudFront distributions, WAF web ACLs, CloudWatch log groups (empty/no-retention).

---

### cloudwatch.json — AWS Logs

**Datasource:** CloudWatch (eu-west-1)  
**Purpose:** Log tailing for AWS services running outside the Kubernetes cluster.

Panels cover: EIP Failover Lambda, Subscribe/Verify Subscription Lambda, SSM bootstrap and deploy execution logs, EC2 cloud-init logs per node pool (control-plane, app-worker, monitoring-worker, argocd-worker), VPC Flow Logs (rejected traffic), self-healing agent Lambda, EBS detach lifecycle Lambda, Step Functions bootstrap orchestrator.

These signals cannot come from Prometheus/Loki because the Lambda functions and SSM automations run outside the cluster. The CloudWatch datasource uses the EC2 instance profile's ambient IAM credentials (same ambient auth pattern as ESO and Steampipe).

---

### cloudwatch-edge.json — AWS Logs — Edge (us-east-1)

**Datasource:** CloudWatch Edge (us-east-1)  
**Purpose:** Lambda@Edge function logs, which CloudFront writes exclusively to us-east-1 regardless of the CloudFront distribution's origin region.

Panels: Next.js Edge Lambda, ACM DNS validation Lambda, DNS alias provider, certificate provider, K8s cert provider Lambda, monitoring DNS alias Lambda, edge Lambda error timeline.

This is the reason for the second `cloudwatch-edge` datasource configured to `us-east-1`. Lambda@Edge logs cannot be accessed from the `eu-west-1` CloudWatch datasource — they exist only in the us-east-1 region's log groups.

---

### auto-bootstrap.json — Auto-Bootstrap Trace

**Datasource:** CloudWatch (eu-west-1)  
**Purpose:** Full observability into the SM-A Step Functions bootstrap pipeline — from EventBridge trigger through Router Lambda through SSM RunCommand execution.

Panels cover: Step Functions execution count/duration, Router Lambda invocations/errors, Router resolved roles trace, EventBridge rule trigger rate, SSM bootstrap execution output and errors, bootstrap executions by role (control-plane vs worker), CA re-join on CP replacement, ASG pool bootstrap logs (general + monitoring pools), per-step ArgoCD bootstrap timeline, boot step durations, and failed step summary.

All panels use CloudWatch — this dashboard monitors the bootstrap infrastructure that runs before the cluster (and Prometheus) is available. There is no Prometheus equivalent for these signals.

---

### bedrock.json — Bedrock Content Pipeline

**Datasource:** CloudWatch (eu-west-1)  
**Purpose:** AI content pipeline health — articles published, token consumption, cost estimates, Lambda performance.

Panels: articles published/failed (EMF metrics), total tokens, estimated cost (USD), avg processing time, QA confidence score, tokens per article (stacked: breakdown/write/QA stages), cost per day, Bedrock model invocation latency and throttles, DynamoDB RCU/WCU, publisher Lambda logs.

This pipeline runs entirely in Lambda/Bedrock outside the cluster. CloudWatch is the only available datasource for its signals.

---

### rum.json — Real User Monitoring (RUM)

**Datasource:** Loki (Faro browser events) + Prometheus (Alloy health)  
**Purpose:** Core Web Vitals and JavaScript errors from real user sessions, collected via Grafana Faro SDK.

All Web Vitals panels use LogQL:

```logql
avg_over_time(
  {job="faro"} | logfmt | kind="measurement" | type="web-vitals"
  | pageUrl=~"$page"
  | unwrap value [$__interval]
)
```

The `job="faro"` stream selector is how RUM logs are isolated from server-side pod logs in Loki. The Alloy pipeline injects this label before forwarding to Loki.

| Metric | LogQL key | Threshold (Google "Good") |
|--------|----------|--------------------------|
| LCP | `type="LCP"` | < 2.5s |
| INP | `type="INP"` | < 200ms |
| CLS | `type="CLS"` | < 0.1 |
| TTFB | `type="TTFB"` | < 800ms |
| FCP | `type="FCP"` | < 1.8s |

JavaScript error queries:

```logql
# Error count (1h)
count_over_time({job="faro"} | logfmt | kind="exception" | pageUrl=~"$page" [1h])

# Errors by type
sum by (exception_type) (count_over_time({job="faro"} | logfmt | kind="exception" [1h]))
```

Alloy health panels (Prometheus): `up{job="alloy"}`, `process_resident_memory_bytes{job="alloy"}`, `rate(faro_receiver_events_total[5m])`, `rate(faro_receiver_measurements_total[5m])`.

---

### self-healing.json — Self-Healing Pipeline

**Datasource:** CloudWatch (eu-west-1)  
**Purpose:** Observability into the AI self-healing Lambda agent — real-time execution logs, tool invocations, token usage.

Panels: agent Lambda live log, diagnose-alarm tool log, EBS detach tool log, token usage over time, total invocations, total tool calls, agent duration. All CloudWatch — the agent runs as a Lambda function triggered by CloudWatch Alarms, outside the cluster.

---

## Datasource distribution across dashboards

| Datasource | Dashboards using it |
|-----------|---------------------|
| `prometheus` | cluster, frontend, bluegreen-rollout, nextjs, monitoring-health, finops, cicd, tracing (span metrics + service graphs) |
| `loki` | rum (Web Vitals + JS errors) |
| `tempo` | tracing (TraceQL panel only) |
| `cloudwatch` | auto-bootstrap, bedrock, cloudwatch, self-healing, tracing (DynamoDB CloudWatch panels) |
| `cloudwatch-edge` | cloudwatch-edge |
| `steampipe` | cloud-inventory |

Only one dashboard (`tracing.json`) queries Tempo's trace store directly (TraceQL). All other trace-derived signals flow through the Prometheus span metrics path (`traces_spanmetrics_*`, `traces_service_graph_*`) — queryable with standard PromQL and compatible with Grafana's standard alert engine.

## Related

- [Observability stack](../projects/observability-stack.md) — full component inventory, alert rules, storage sizing
- [Loki + Tempo pipeline](../tools/loki-tempo-pipeline.md) — span metrics generation, Loki schema, Promtail labeling
- [RUM pipeline](rum-pipeline.md) — Faro SDK → Alloy → Loki path that feeds `rum.json`
- [Grafana datasources](../tools/grafana-datasources.md) — datasource configuration, Loki→Tempo derived fields

<!--
Evidence trail (auto-generated):
- Source: charts/monitoring/chart/dashboards/ (all 15 JSON files read 2026-04-28 — panel titles, datasource UIDs, and first 2 queries per panel extracted via python3)
- Source: charts/monitoring/chart/templates/grafana/dashboard-provider.yaml (read 2026-04-28 — updateIntervalSeconds 60, allowUiUpdates true, path /var/lib/grafana/dashboards)
- Source: charts/monitoring/chart/templates/grafana/configmap.yaml (read 2026-04-28 — datasource UIDs and types)
- Generated: 2026-04-28
-->
