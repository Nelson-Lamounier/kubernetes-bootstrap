---
title: Prometheus Scrape Configuration
type: tool
tags: [prometheus, kubernetes, metrics, service-discovery, scrape, relabeling, exemplars]
sources:
  - charts/monitoring/chart/templates/prometheus/configmap.yaml
  - charts/monitoring/chart/templates/prometheus/deployment.yaml
  - charts/monitoring/chart/templates/prometheus/rbac.yaml
  - charts/monitoring/chart/values.yaml
created: 2026-04-28
updated: 2026-04-28
---

# Prometheus Scrape Configuration

The 15 scrape jobs in this cluster's Prometheus deployment — covering Kubernetes service discovery patterns, relabeling rules, the Blue/Green preview scrape target, and the runtime flags that enable exemplar storage, native histograms, and remote-write ingest from Tempo.

## Runtime flags

Prometheus is started with ([`templates/prometheus/deployment.yaml`](../../charts/monitoring/chart/templates/prometheus/deployment.yaml), lines 46–52):

```
--config.file=/etc/prometheus/prometheus.yml
--storage.tsdb.path=/prometheus
--storage.tsdb.retention.time=15d           # 7d in development
--web.enable-lifecycle                       # allows config reload via HTTP POST /-/reload
--web.external-url=/prometheus               # path prefix for Traefik reverse proxy
--web.enable-remote-write-receiver           # accepts writes from Tempo metrics_generator
--enable-feature=exemplar-storage,native-histograms
```

**`--web.external-url=/prometheus`** is required for Traefik path-prefix routing. Without it, Prometheus generates redirect URLs without the `/prometheus` prefix, breaking the UI when accessed via `ops.nelsonlamounier.com/prometheus`.

**`--web.enable-remote-write-receiver`** opens the `/prometheus/api/v1/write` endpoint. Tempo's `metrics_generator` writes span-derived RED metrics to this endpoint — enabling DynamoDB latency alerts and service graph panels without querying Tempo directly.

**`--enable-feature=exemplar-storage`** allows Prometheus to store exemplars alongside metrics. Tempo sends exemplars (trace ID + timestamp) via the remote-write path (`send_exemplars: true`), making it possible to click a data point in a Grafana panel and jump directly to the corresponding trace.

**`--enable-feature=native-histograms`** enables the Prometheus native histogram format (higher resolution, lower cardinality than classic `_bucket/_sum/_count` triples). Applications that emit native histograms get better percentile accuracy.

## RBAC

A `ClusterRole` grants Prometheus read access cluster-wide ([`templates/prometheus/rbac.yaml`](../../charts/monitoring/chart/templates/prometheus/rbac.yaml)):

```yaml
rules:
  - apiGroups: [""]
    resources: [nodes, nodes/proxy, nodes/metrics, services, endpoints, pods]
    verbs: [get, list, watch]
  - apiGroups: [extensions, networking.k8s.io]
    resources: [ingresses]
    verbs: [get, list, watch]
  - nonResourceURLs: [/metrics, /metrics/cadvisor]
    verbs: [get]
```

`nodes/proxy` — required to reach the kubelet's metrics endpoints via the API server proxy (used by the `kubernetes-nodes` and `kubernetes-cadvisor` jobs). `nonResourceURLs: [/metrics/cadvisor]` is a separate rule because cadvisor metrics are served at a path, not a resource type.

## Scrape jobs

All scrape jobs are defined in [`templates/prometheus/configmap.yaml`](../../charts/monitoring/chart/templates/prometheus/configmap.yaml). Global: `scrape_interval: 30s`, `evaluation_interval: 30s`, external labels `cluster: portfolio-development`, `environment: development`.

### prometheus (self)

```yaml
job_name: prometheus
metrics_path: /prometheus/metrics
static_configs:
  - targets: ["localhost:9090"]
```

Path override `/prometheus/metrics` required because Prometheus is started with `--web.external-url=/prometheus`. Without this, Prometheus would try to scrape `/metrics` and get redirected.

### kubernetes-nodes

```yaml
job_name: kubernetes-nodes
scheme: https
tls_config:
  ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
  insecure_skip_verify: true
authorization:
  credentials_file: /var/run/secrets/kubernetes.io/serviceaccount/token
kubernetes_sd_configs:
  - role: node
relabel_configs:
  - action: labelmap
    regex: __meta_kubernetes_node_label_(.+)
```

Scrapes the kubelet metrics endpoint on each node via HTTPS, using the Pod's service account token for authentication. `insecure_skip_verify: true` is needed because the kubelet uses a self-signed certificate. The `labelmap` relabel rule copies all Kubernetes node labels (e.g., `node-pool`, `topology.kubernetes.io/zone`) onto the scraped metrics — enabling node-pool-aware dashboards.

### kubernetes-cadvisor

```yaml
job_name: kubernetes-cadvisor
scheme: https
metrics_path: /metrics/cadvisor
kubernetes_sd_configs:
  - role: node
```

Same discovery and auth as `kubernetes-nodes` but targeting `/metrics/cadvisor`. cAdvisor provides container-level CPU, memory, and network metrics (`container_cpu_usage_seconds_total`, `container_memory_working_set_bytes`) used by the `cluster.json` and `nextjs.json` dashboards.

### kubernetes-service-endpoints (annotation-driven)

```yaml
job_name: kubernetes-service-endpoints
kubernetes_sd_configs:
  - role: endpoints
relabel_configs:
  - source_labels: [__meta_kubernetes_service_annotation_prometheus_io_scrape]
    action: keep
    regex: "true"
  - source_labels: [__meta_kubernetes_service_annotation_prometheus_io_scheme]
    action: replace
    target_label: __scheme__
    regex: (https?)
  - source_labels: [__meta_kubernetes_service_annotation_prometheus_io_path]
    action: replace
    target_label: __metrics_path__
  - source_labels: [__address__, __meta_kubernetes_service_annotation_prometheus_io_port]
    action: replace
    target_label: __address__
    regex: ([^:]+)(?::\d+)?;(\d+)
    replacement: ${1}:${2}
  - source_labels: [__meta_kubernetes_namespace]
    target_label: namespace
  - source_labels: [__meta_kubernetes_service_name]
    target_label: service
  - source_labels: [__meta_kubernetes_pod_name]
    target_label: pod
```

Services opt in to scraping via the annotation `prometheus.io/scrape: "true"`. The relabel pipeline also reads `prometheus.io/scheme`, `prometheus.io/path`, and `prometheus.io/port` — allowing per-service overrides without touching the Prometheus config. GitHub Actions Exporter uses this mechanism (`prometheus.io/scrape: "true"` annotation on its Service).

### node-exporter

```yaml
job_name: node-exporter
kubernetes_sd_configs:
  - role: endpoints
    namespaces:
      names: [monitoring]
relabel_configs:
  - source_labels: [__meta_kubernetes_service_name]
    action: keep
    regex: node-exporter
  - source_labels: [__meta_kubernetes_endpoint_node_name]
    target_label: node
```

Filtered to the `monitoring` namespace and service name `node-exporter`. The `endpoint_node_name` relabel maps the node hostname onto the `node` label — making it possible to correlate node-exporter metrics with kube-state-metrics pods-per-node data.

Note: Node Exporter runs on port 9101 in development to avoid conflict with Traefik's own metrics port 9100 (see `values-development.yaml` comment).

### Static scrape targets

| Job | Target | Notes |
|-----|--------|-------|
| `kube-state-metrics` | `kube-state-metrics.monitoring:8080` | K8s object state |
| `grafana` | `grafana.monitoring:3000/grafana/metrics` | Grafana self-monitoring |
| `loki` | `loki.monitoring:3100` | Loki internals |
| `tempo` | `tempo.monitoring:3200` | Tempo internals |
| `github-actions-exporter` | `github-actions-exporter.monitoring:9101` | CI/CD metrics |
| `alloy` | `alloy.monitoring:12345/metrics` | Alloy self-monitoring |
| `opencost` | `opencost.monitoring:9003/metrics` | Cost allocation |

### traefik (pod discovery)

```yaml
job_name: traefik
kubernetes_sd_configs:
  - role: pod
    namespaces:
      names: [kube-system]
relabel_configs:
  - source_labels: [__meta_kubernetes_pod_label_app_kubernetes_io_name]
    action: keep
    regex: traefik
  - source_labels: [__meta_kubernetes_pod_ip]
    target_label: __address__
    replacement: ${1}:9100
```

Traefik is deployed in `kube-system` and exposes metrics on port 9100. Pod-role discovery is used rather than endpoint-role because Traefik does not expose its metrics via a Kubernetes Service (the metrics port is not in the Service spec). The pod's IP is used directly.

### nextjs-app and nextjs-app-preview

```yaml
- job_name: nextjs-app
  metrics_path: /api/metrics
  static_configs:
    - targets: ["nextjs.nextjs-app.svc.cluster.local:3000"]

# Preview scrape target — active only during Blue/Green rollouts.
# Scrapes the same /api/metrics endpoint via the preview Service,
# giving visibility into the new version's application metrics
# before promotion. Returns no data when no rollout is in progress.
- job_name: nextjs-app-preview
  metrics_path: /api/metrics
  static_configs:
    - targets: ["nextjs-preview.nextjs-app.svc.cluster.local:3000"]
```

The comment in the configmap explains the preview job's lifecycle — it is a permanent scrape target that returns no data outside of rollouts. This avoids config changes for each deployment cycle. The `bluegreen-rollout.json` dashboard uses `up{job="nextjs-app-preview"}` as a signal for whether a rollout is currently in progress.

The `nextjs` application exposes custom metrics at `/api/metrics` (not the default `/metrics`) — likely due to Next.js's route structure where `/metrics` would collide with page routes.

## Global configuration

```yaml
global:
  scrape_interval: 30s
  evaluation_interval: 30s
  external_labels:
    cluster: portfolio-development
    environment: development
```

`external_labels` are attached to every metric and alert. When using remote storage (not currently active) or federation, these labels identify the originating cluster. They also appear in alert annotations — `cluster: portfolio-development` makes alert routing straightforward if multiple clusters share the same alertmanager.

## Deployment strategy: Recreate

Prometheus uses `strategy: type: Recreate` ([`templates/prometheus/deployment.yaml`](../../charts/monitoring/chart/templates/prometheus/deployment.yaml), lines 9–11). The EBS PVC uses `ReadWriteOnce` access mode — only one pod can mount it at a time. A rolling update would start the new pod before terminating the old one, causing the new pod to fail to mount the PVC.

`topologySpreadConstraints: whenUnsatisfiable: ScheduleAnyway` spreads replicas across nodes without hard-blocking. On a 2-node cluster where `maxSkew: 1` is already violated (both replicas on one node after a restart), `DoNotSchedule` would cause the pod to be unschedulable. `ScheduleAnyway` allows the pod to land anywhere when the constraint cannot be satisfied.

## Related

- [Observability stack](../projects/observability-stack.md) — full component context
- [Loki + Tempo pipeline](loki-tempo-pipeline.md) — Tempo metrics_generator remote-write that Prometheus receives
- [Dashboard architecture](../concepts/dashboard-architecture.md) — which dashboards use which scrape jobs

<!--
Evidence trail (auto-generated):
- Source: charts/monitoring/chart/templates/prometheus/configmap.yaml (read 2026-04-28, 144 lines — all 15 scrape jobs, kubernetes_sd configs, nextjs-app-preview comment, all relabel rules)
- Source: charts/monitoring/chart/templates/prometheus/deployment.yaml (read 2026-04-28 — all CLI flags lines 46-52, Recreate strategy, topologySpreadConstraints ScheduleAnyway)
- Source: charts/monitoring/chart/templates/prometheus/rbac.yaml (read 2026-04-28 — ClusterRole resource list, nonResourceURLs)
- Source: charts/monitoring/chart/values-development.yaml (read 2026-04-28 — port 9101 node-exporter comment, dev-specific values)
- Generated: 2026-04-28
-->
