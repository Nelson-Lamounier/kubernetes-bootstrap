---
title: RUM Pipeline
type: concept
tags: [rum, grafana-faro, alloy, loki, tempo, opentelemetry, web-vitals, javascript, observability]
sources:
  - charts/monitoring/chart/templates/alloy/configmap.yaml
  - charts/monitoring/chart/templates/alloy/ingressroute.yaml
  - charts/monitoring/chart/values.yaml
  - charts/monitoring/chart/dashboards/rum.json
created: 2026-04-28
updated: 2026-04-28
---

# RUM Pipeline

How Real User Monitoring (RUM) flows from the browser to Grafana — the Grafana Faro SDK emits Web Vitals, JavaScript errors, and client-side spans; Alloy receives them via a public `/faro` endpoint, applies the `job=faro` label, and forwards logs to Loki and traces to Tempo. The `rum.json` dashboard queries Loki with LogQL to render Core Web Vitals and JS error counts.

## Pipeline overview

```mermaid
flowchart LR
    SDK[Browser\nGrafana Faro SDK] -->|POST /faro\nHTTPS + CORS| EDGE[Traefik\nops.nelsonlamounier.com]
    EDGE -->|faro-stripprefix\nfaro-cors| ALLOY[Grafana Alloy :12347\nfaro.receiver]
    ALLOY -->|events.logs\nkind=measurement/exception| LP[loki.process.faro\njob=faro label]
    LP -->|loki.write| LOKI[Loki\nlog store]
    ALLOY -->|events.traces\nclient spans| OTLP[otelcol.exporter.otlp\nTempo :4317]
    LOKI -->|{job=faro} | logfmt| GRAF[rum.json\ndashboard]
    OTLP --> TEMPO[Tempo\ntrace store]
```

## Faro SDK — browser instrumentation

The Grafana Faro SDK instruments the Next.js application to emit three event types:

| Event type | What it captures | LogQL `kind` |
|------------|-----------------|-------------|
| Web Vital measurements | LCP, INP, CLS, TTFB, FCP values per page | `kind="measurement" type="web-vitals"` |
| JavaScript exceptions | Uncaught errors, unhandled rejections, stack traces | `kind="exception"` |
| Client spans | User-initiated traces (page loads, API calls, interactions) | Forwarded to Tempo via OTLP |

The SDK batches these events and POSTs JSON payloads to the configured collector URL — `https://ops.nelsonlamounier.com/faro` in this deployment.

## Alloy — Faro collector

Alloy ([`charts/monitoring/chart/templates/alloy/configmap.yaml`](../../charts/monitoring/chart/templates/alloy/configmap.yaml)) runs the Faro receiver pipeline:

```alloy
// Receive Faro SDK payloads on port 12347
faro.receiver "default" {
  server {
    listen_address = "0.0.0.0"
    listen_port    = 12347
    cors_allowed_origins = [
      "https://nelsonlamounier.com",
      "https://www.nelsonlamounier.com",
      "http://localhost:3000"
    ]
  }
  output {
    logs   = [loki.process.faro.receiver]
    traces = [otelcol.exporter.otlp.tempo.input]
  }
}

// Inject job=faro label before forwarding to Loki
loki.process "faro" {
  forward_to = [loki.write.default.receiver]
  stage.static_labels {
    values = { job = "faro" }
  }
}

// Forward logs to Loki
loki.write "default" {
  endpoint {
    url = "http://loki.monitoring.svc.cluster.local:3100/loki/api/v1/push"
  }
}

// Forward client-side spans to Tempo via OTLP gRPC
otelcol.exporter.otlp "tempo" {
  client {
    endpoint = "tempo.monitoring.svc.cluster.local:4317"
    tls { insecure = true }
  }
}
```

The `loki.process "faro"` stage injects a static label `job=faro` onto every log entry before writing to Loki. This is what the `rum.json` dashboard filters on — `{job="faro"}` isolates browser telemetry from the thousands of other pod log streams in Loki. Without this label, there would be no way to distinguish browser events from server-side logs in Loki.

## CORS — two layers

The Faro endpoint has two CORS handling layers:

**Layer 1 — Traefik `faro-cors` middleware** ([`templates/alloy/ingressroute.yaml`](../../charts/monitoring/chart/templates/alloy/ingressroute.yaml)):

```yaml
spec:
  headers:
    accessControlAllowOriginList:
      - "https://nelsonlamounier.com"
      - "https://www.nelsonlamounier.com"
      - "http://localhost:3000"
    accessControlAllowMethods: ["GET", "POST", "OPTIONS"]
    accessControlAllowHeaders: ["Content-Type", "X-Faro-Session-Id"]
    accessControlMaxAge: 3600
```

Browsers send an `OPTIONS` preflight request before POSTing the Faro payload. Traefik handles this preflight — it responds with the CORS headers without forwarding to Alloy. The browser then sends the actual POST.

**Layer 2 — Alloy `cors_allowed_origins`** in the `faro.receiver` block handles CORS on Alloy's direct HTTP listener. This layer is active if Alloy is accessed directly (not via Traefik) — relevant for local development where the Next.js app hits Alloy directly.

Both layers must list the same origins. A mismatch between them would cause requests from some origins to pass Traefik but be rejected by Alloy.

## The /faro IngressRoute

```yaml
routes:
  - match: PathPrefix(`/faro`)
    priority: 110        # higher than Prometheus/Grafana routes (100)
    services:
      - name: alloy
        port: 12347      # faroPort, not httpPort (12345)
    middlewares:
      - name: faro-stripprefix
      - name: faro-cors
```

No `admin-ip-allowlist`, `basic-auth`, or `rate-limit` — the endpoint is intentionally public. Priority 110 ensures the `/faro` rule matches before any lower-priority wildcard rules.

`faro-stripprefix` removes `/faro` from the path before Alloy receives the request. The Faro receiver listens at `/collect` (or equivalent) on port 12347 — the path from the browser is `/faro/collect`, which after stripping becomes `/collect` as Alloy expects.

## rum.json — LogQL patterns

The `rum.json` dashboard ([`charts/monitoring/chart/dashboards/rum.json`](../../charts/monitoring/chart/dashboards/rum.json)) queries Loki exclusively (except for Alloy health panels which use Prometheus).

**Core Web Vitals — metric extraction from log values:**

```logql
avg_over_time(
  {job="faro"}
  | logfmt
  | kind="measurement"
  | type="web-vitals"
  | pageUrl=~"$page"
  | unwrap value [$__interval]
)
```

The Faro SDK emits Web Vitals as structured log entries (logfmt-encoded). The LogQL pipeline:
1. Selects `{job="faro"}` stream (all browser telemetry)
2. `logfmt` parser extracts key-value fields from the log line
3. `kind="measurement"` + `type="web-vitals"` filter to Web Vitals events only
4. `pageUrl=~"$page"` filters by the Grafana variable (dashboard page selector)
5. `unwrap value` treats the `value` field as a numeric metric
6. `avg_over_time` aggregates over the interval

Individual vitals filter by their specific measurement type — the same pattern with `| pName="LCP"`, `| pName="INP"`, etc.

**JavaScript errors:**

```logql
# Error count in the last hour
count_over_time({job="faro"} | logfmt | kind="exception" | pageUrl=~"$page" [1h])

# Error distribution by type
sum by (exception_type) (count_over_time({job="faro"} | logfmt | kind="exception" [1h]))

# Raw recent errors (log panel)
{job="faro"} | logfmt | kind="exception" | pageUrl=~"$page"
```

**Alloy health (Prometheus):**

```promql
# Alloy up/down
up{job="alloy"}

# Faro event throughput
rate(faro_receiver_events_total{job="alloy"}[5m])
rate(faro_receiver_measurements_total{job="alloy"}[5m])
```

`faro_receiver_events_total` counts all Faro events received (errors, logs, measurements). `faro_receiver_measurements_total` counts only numeric measurements (Web Vitals). If `faro_receiver_measurements_total` drops to zero, Web Vitals panels in `rum.json` will show no data — this metric is the health indicator for the measurement pipeline specifically.

## Alloy self-monitoring

```alloy
prometheus.exporter.self "default" {}
```

Alloy exposes its own internal Prometheus metrics at `:12345/metrics` (the `httpPort`, distinct from `faroPort: 12347`). Prometheus scrapes this via the `alloy` static scrape job. This is what provides the `up{job="alloy"}` and `faro_receiver_*` metrics for the health panels in `rum.json`.

## Related

- [Observability stack](../projects/observability-stack.md) — Alloy component entry, CORS values configuration
- [Monitoring access control](monitoring-access-control.md) — why `/faro` bypasses all access-control middlewares, `faro-cors` Middleware detail
- [Loki + Tempo pipeline](../tools/loki-tempo-pipeline.md) — Loki log storage, schema, reject_old_samples configuration
- [Dashboard architecture](dashboard-architecture.md) — `rum.json` panel inventory with full LogQL queries

<!--
Evidence trail (auto-generated):
- Source: charts/monitoring/chart/templates/alloy/configmap.yaml (read 2026-04-28 — faro.receiver port 12347, cors_allowed_origins, loki.process job=faro static label, loki.write endpoint, otelcol.exporter.otlp tempo :4317, prometheus.exporter.self)
- Source: charts/monitoring/chart/templates/alloy/ingressroute.yaml (read 2026-04-28 — faro-stripprefix, faro-cors CORS headers, priority 110, port 12347, no auth middlewares)
- Source: charts/monitoring/chart/values.yaml (read 2026-04-28 — alloy.service.faroPort 12347, alloy.service.httpPort 12345, alloy.ingress.corsAllowedOrigins list)
- Source: charts/monitoring/chart/dashboards/rum.json (read 2026-04-28 — all panel LogQL queries extracted, faro_receiver_events_total and measurements_total metrics, exception_type aggregation)
- Generated: 2026-04-28
-->
