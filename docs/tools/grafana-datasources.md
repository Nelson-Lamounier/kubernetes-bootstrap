---
title: Grafana Datasources
type: tool
tags: [grafana, prometheus, loki, tempo, cloudwatch, steampipe, observability, tracing]
sources:
  - charts/monitoring/chart/templates/grafana/configmap.yaml
  - charts/monitoring/chart/templates/grafana/dashboard-provider.yaml
  - charts/monitoring/chart/values.yaml
created: 2026-04-28
updated: 2026-04-28
---

# Grafana Datasources

The six datasources configured in Grafana's provisioning ConfigMap — how Prometheus, Loki, Tempo, dual CloudWatch, and Steampipe are connected, what correlation features are configured between them, and why two CloudWatch datasources in different regions are needed.

## Overview

All datasources are provisioned via a ConfigMap at [`charts/monitoring/chart/templates/grafana/configmap.yaml`](../../charts/monitoring/chart/templates/grafana/configmap.yaml) mounted into Grafana as `/etc/grafana/provisioning/datasources/datasources.yaml`. `editable: false` on all datasources except where noted — UI changes are discarded on the next ArgoCD sync.

| UID | Name | Type | Default |
|-----|------|------|---------|
| `prometheus` | Prometheus | prometheus | ✓ |
| `loki` | Loki | loki | — |
| `tempo` | Tempo | tempo | — |
| `cloudwatch` | CloudWatch | cloudwatch | — |
| `cloudwatch-edge` | CloudWatch Edge (us-east-1) | cloudwatch | — |
| `steampipe` | Steampipe | postgres | — |

## Prometheus

```yaml
- name: Prometheus
  type: prometheus
  uid: prometheus
  url: http://prometheus.monitoring.svc.cluster.local:9090/prometheus
  isDefault: true
  editable: false
```

URL includes the `/prometheus` path prefix — Prometheus is started with `--web.external-url=/prometheus`, so all API paths are under this prefix. Grafana must use `http://prometheus.monitoring:9090/prometheus/api/v1/query` rather than `/api/v1/query` directly.

Set as the default datasource — new panels start with Prometheus selected.

## Loki

```yaml
- name: Loki
  type: loki
  uid: loki
  url: http://loki.monitoring.svc.cluster.local:3100
  jsonData:
    derivedFields:
      - datasourceUid: tempo
        matcherRegex: '"traceID":"(\w+)"'
        name: TraceID
        url: "${__value.raw}"
```

### Loki → Tempo derived field

The `derivedFields` configuration creates clickable trace links inline in log lines. When Grafana renders a Loki log entry containing `"traceID":"<hex>"`, it shows a "TraceID" link button. Clicking it opens the Tempo datasource in Explore, pre-filtered to that trace ID.

**Requirements for correlation to work:**
- The application must emit structured logs (JSON) containing the key `"traceID"` (exact spelling — camelCase, not `trace_id` or `traceId`)
- The application must be instrumented with OpenTelemetry and inject the trace ID into log records (OpenTelemetry's log correlation feature)
- The trace must exist in Tempo (within the 72h retention window)

The regex `"traceID":"(\w+)"` captures hex digits and word characters. A trace ID of `4bf92f3577b34da6a3ce929d0e0e4736` would match; a UUID-formatted ID with hyphens would not.

## Tempo

```yaml
- name: Tempo
  type: tempo
  uid: tempo
  url: http://tempo.monitoring.svc.cluster.local:3200
  jsonData:
    tracesToLogs:
      datasourceUid: loki
      tags: [job, instance]
      mappedTags: [{key: service.name, value: service}]
      mapTagNamesEnabled: true
      filterByTraceID: true
    serviceMap:
      datasourceUid: prometheus
    nodeGraph:
      enabled: true
```

### tracesToLogs — trace to log correlation

When viewing a trace in Grafana Tempo, `tracesToLogs` adds a "Logs" button on each span. Clicking it opens Loki Explore filtered to logs from the span's service and time window.

Configuration details:
- `tags: [job, instance]` — Grafana adds these label filters when jumping to Loki, using values from the trace's resource attributes
- `mappedTags: [{key: service.name, value: service}]` — maps the OpenTelemetry `service.name` attribute to the Loki `service` label (since Promtail labels pods as `app=`, not `service=`)
- `filterByTraceID: true` — additionally filters Loki query by the trace ID (uses the derivedField regex from the Loki datasource to find correlated logs)

### serviceMap — service dependency graph from Prometheus

```yaml
serviceMap:
  datasourceUid: prometheus
```

The Tempo service map panel sources its data from Prometheus, not from Tempo's trace store. Tempo's `metrics_generator` writes `traces_service_graph_request_total` and related metrics to Prometheus. Grafana's Tempo datasource reads these metrics from Prometheus to render the service topology graph. This means the service map is queryable even if the original traces have aged out of Tempo's 72h retention window.

### nodeGraph

```yaml
nodeGraph:
  enabled: true
```

Enables the interactive node graph visualization in the trace view — shows spans as nodes and their parent/child relationships as directed edges. Useful for understanding deeply nested trace trees.

## CloudWatch (eu-west-1)

```yaml
- name: CloudWatch
  type: cloudwatch
  uid: cloudwatch
  jsonData:
    defaultRegion: eu-west-1
    authType: default
```

`authType: default` uses the AWS default credential chain — on an EC2 instance, this resolves to the instance profile. The monitoring node's IAM role must have `logs:GetLogEvents`, `logs:FilterLogEvents`, `logs:DescribeLogStreams`, `cloudwatch:GetMetricData` etc. for eu-west-1 resources.

Used by: `cloudwatch.json` (Lambda logs, SSM automation, EC2 cloud-init, VPC flow logs), `auto-bootstrap.json` (Step Functions, Router Lambda), `bedrock.json` (content pipeline), `self-healing.json` (agent Lambda).

## CloudWatch Edge (us-east-1)

```yaml
- name: CloudWatch Edge (us-east-1)
  type: cloudwatch
  uid: cloudwatch-edge
  jsonData:
    defaultRegion: us-east-1
    authType: default
```

A second CloudWatch datasource targeting `us-east-1` specifically. Lambda@Edge functions are invoked by CloudFront at edge locations. CloudFront routes to the nearest AWS Region, but **Lambda@Edge always writes its execution logs to us-east-1** regardless of where the edge location is. This is an AWS constraint — not a configuration choice.

The functions covered:
- Next.js Edge middleware (for ISR cache revalidation, middleware rewrites)
- ACM DNS validation Lambda (certificate issuance automation)
- DNS alias provider Lambda (Route53 alias record management)
- K8s certificate provider Lambda (cert-manager ACME challenge)
- Monitoring DNS alias Lambda

Without the `us-east-1` datasource, all these log groups are invisible from the `eu-west-1` CloudWatch datasource. The `cloudwatch-edge.json` dashboard exists solely because of this AWS regional constraint.

## Steampipe

```yaml
- name: Steampipe
  type: postgres
  uid: steampipe
  url: steampipe.monitoring.svc.cluster.local:9193
  database: steampipe
  user: steampipe
  jsonData:
    sslmode: disable
    postgresVersion: 1400
  secureJsonData:
    password: "steampipe"
```

Steampipe exposes a PostgreSQL wire-protocol endpoint — Grafana connects to it as a standard Postgres datasource. SQL panels can query any AWS resource via Steampipe's table schema (e.g., `aws_ebs_volume`, `aws_vpc_security_group_rule`, `aws_s3_bucket`).

`sslmode: disable` — the connection is in-cluster (pod-to-pod), so TLS is not required. `postgresVersion: 1400` tells Grafana to use PostgreSQL 14 wire protocol compatibility.

The password `steampipe` is Steampipe's default internal database password — it controls access to the in-cluster PostgreSQL process, not to AWS credentials. AWS access uses the node instance profile.

## Dashboard provider

```yaml
# templates/grafana/dashboard-provider.yaml
providers:
  - name: default
    type: file
    updateIntervalSeconds: 60
    allowUiUpdates: true
    options:
      path: /var/lib/grafana/dashboards
      foldersFromFilesStructure: false
```

`updateIntervalSeconds: 60` — Grafana checks for new or changed dashboard JSON files every 60 seconds. `allowUiUpdates: true` — dashboards edited in the UI are not immediately rejected, but changes are overwritten when ArgoCD syncs the ConfigMap (which triggers a pod restart or config reload). `foldersFromFilesStructure: false` — all 15 dashboards appear in the root folder regardless of subdirectory structure.

## Related

- [Observability stack](../projects/observability-stack.md) — full component inventory
- [Dashboard architecture](dashboard-architecture.md) — per-dashboard datasource usage
- [Loki + Tempo pipeline](loki-tempo-pipeline.md) — how the derivedField correlation and serviceMap data are generated

<!--
Evidence trail (auto-generated):
- Source: charts/monitoring/chart/templates/grafana/configmap.yaml (read 2026-04-28, 76 lines — all 6 datasource definitions, derivedField matcherRegex, tracesToLogs config, serviceMap datasourceUid, nodeGraph, CloudWatch authType and regions, Steampipe url/db/user/password)
- Source: charts/monitoring/chart/templates/grafana/dashboard-provider.yaml (read 2026-04-28 — updateIntervalSeconds 60, allowUiUpdates, path, foldersFromFilesStructure)
- Generated: 2026-04-28
-->
