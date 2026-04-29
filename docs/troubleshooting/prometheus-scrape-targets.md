---
title: Prometheus Scrape Targets Troubleshooting
type: troubleshooting
tags: [prometheus, monitoring, scrape-config, kubernetes, traefik, sub-path]
sources:
  - charts/monitoring/chart/templates/prometheus/ingressroute.yaml
  - argocd-apps/monitoring.yaml
created: 2026-04-28
updated: 2026-04-28
---

# Prometheus Targets Troubleshooting Guide

A detailed, step-by-step guide to diagnosing and fixing Prometheus scrape target failures in the monitoring stack. All commands are run from the **control-plane node** via an AWS SSM session.

---

## Table of Contents

- [Background — How Prometheus Scraping Works](#background--how-prometheus-scraping-works)
- [Background — Sub-Path Routing and Its Impact](#background--sub-path-routing-and-its-impact)
- [Step 1 — Check Current Target Status](#step-1--check-current-target-status)
- [Step 2 — Understand the Scrape Configuration](#step-2--understand-the-scrape-configuration)
- [Issue 1: kubernetes-service-endpoints Targets DOWN — Port Used as Hostname](#issue-1-kubernetes-service-endpoints-targets-down--port-used-as-hostname)
- [Issue 2: Prometheus Self-Scrape Returns 404 Not Found](#issue-2-prometheus-self-scrape-returns-404-not-found)
- [Issue 3: Grafana Scrape Fails — Redirect Loop to localhost](#issue-3-grafana-scrape-fails--redirect-loop-to-localhost)
- [Issue 4: Prometheus Service-Endpoint Still 404 After Relabel Fix](#issue-4-prometheus-service-endpoint-still-404-after-relabel-fix)
- [Issue 5: Next.js Application Metrics Not Appearing](#issue-5-nextjs-application-metrics-not-appearing)
- [Issue 6: github-actions-exporter Connection Refused — Pod Not Running](#issue-6-github-actions-exporter-connection-refused--pod-not-running)
- [Related Fix: Grafana Datasource URL Returns 404](#related-fix-grafana-datasource-url-returns-404)
- [Related Fix: Tempo remote_write URL Returns 404](#related-fix-tempo-remote_write-url-returns-404)
- [Key Takeaway — Sub-Path Prefix Reference Table](#key-takeaway--sub-path-prefix-reference-table)
- [Common Verification Commands](#common-verification-commands)
- [Glossary](#glossary)

---

## Background — How Prometheus Scraping Works

Prometheus **pulls** (scrapes) metrics from HTTP endpoints at regular intervals. Each scrape target is defined in `prometheus-configmap.yaml` under the `scrape_configs` section. There are two main types of target discovery:

### Static Targets

A fixed list of `host:port` addresses. Prometheus hits the configured `metrics_path` (default: `/metrics`) on each address:

```yaml
- job_name: grafana
  static_configs:
    - targets: ["grafana.monitoring.svc.cluster.local:3000"]
```

This tells Prometheus: "scrape `http://grafana.monitoring.svc.cluster.local:3000/metrics` every 15 seconds."

### Kubernetes Service Discovery (SD)

Instead of hard-coding addresses, Prometheus uses the Kubernetes API to **dynamically discover** targets. The `kubernetes_sd_configs` block tells Prometheus which role to discover:

```yaml
- job_name: kubernetes-service-endpoints
  kubernetes_sd_configs:
    - role: endpoints
```

When `role: endpoints` is set, Prometheus queries the Kubernetes API for all Endpoints objects. For each endpoint, Prometheus sets internal metadata labels like:

| Metadata Label | What It Contains | Example |
| --- | --- | --- |
| `__meta_kubernetes_service_annotation_prometheus_io_scrape` | The value of the `prometheus.io/scrape` service annotation | `true` |
| `__meta_kubernetes_service_annotation_prometheus_io_port` | The value of the `prometheus.io/port` service annotation | `9090` |
| `__meta_kubernetes_service_annotation_prometheus_io_path` | The value of the `prometheus.io/path` service annotation | `/prometheus/metrics` |
| `__address__` | The pod IP and port from the Endpoints object | `10.244.0.15:9090` |

### Relabeling

Before scraping, Prometheus runs `relabel_configs` rules that transform these metadata labels into the final scrape URL. This is where most configuration bugs occur.

The key labels that determine the scrape URL are:

| Label | Default | Controls |
| --- | --- | --- |
| `__address__` | (from discovery) | The `host:port` to connect to |
| `__scheme__` | `http` | The protocol (`http` or `https`) |
| `__metrics_path__` | `/metrics` | The URL path to scrape |

The final scrape URL is: `{__scheme__}://{__address__}{__metrics_path__}`

---

## Background — Sub-Path Routing and Its Impact

This monitoring stack uses **sub-path routing** via Traefik IngressRoutes. Instead of each service getting its own domain, they share a single IP and are differentiated by URL path:

```text
http://<public-ip>/prometheus  →  Prometheus (port 9090)
http://<public-ip>/grafana     →  Grafana (port 3000)
```

To make this work, each service must be configured to serve from its sub-path:

- **Prometheus** uses `--web.external-url=/prometheus`, which **moves all endpoints** (including `/metrics`) under `/prometheus/`. So the metrics endpoint becomes `/prometheus/metrics` instead of `/metrics`.
- **Grafana** uses `GF_SERVER_SERVE_FROM_SUB_PATH=true` with `GF_SERVER_ROOT_URL=%(protocol)s://%(domain)s/grafana/`, which rewrites all paths under `/grafana/`. The metrics endpoint becomes `/grafana/metrics`.

> [!IMPORTANT]
> This sub-path configuration is the **root cause** of most target failures in this guide. Every URL reference to these services — scrape targets, datasource URLs, remote_write endpoints — must include the sub-path prefix.

---

## Step 1 — Check Current Target Status

Before diagnosing individual issues, get an overview of all targets.

### 1a — Via the Prometheus Web UI

Navigate to `http://<public-ip>/prometheus/targets` in your browser. Each target shows its state (UP/DOWN), last scrape time, and any error messages.

### 1b — Via the API (from the control plane)

```bash
sudo kubectl run curl-targets --rm -it --restart=Never \
  --image=curlimages/curl -- \
  curl -s http://prometheus.monitoring.svc.cluster.local:9090/prometheus/api/v1/targets \
  | python3 -m json.tool
```

| Flag | Meaning |
| --- | --- |
| `kubectl run ... --rm -it` | Create a temporary pod, attach to it, and delete it when done |
| `--restart=Never` | Don't restart the pod if it exits (one-shot execution) |
| `--image=curlimages/curl` | Use a lightweight image that has `curl` installed |
| `curl -s` | Suppress progress bar output |
| `python3 -m json.tool` | Pretty-print the JSON response |

#### What Success Looks Like

Every target should show `"health": "up"`. Any target showing `"health": "down"` needs investigation.

---

## Step 2 — Understand the Scrape Configuration

The scrape configuration lives in `prometheus-configmap.yaml` inside the monitoring Helm chart:

```text
kubernetes-app/app-deploy/monitoring/chart/templates/prometheus-configmap.yaml
```

This ConfigMap is mounted into the Prometheus pod at `/etc/prometheus/prometheus.yml`. Changes to this file require:

1. Commit and push to the `develop` branch
2. Wait for ArgoCD to sync (~1–3 minutes)
3. Restart Prometheus to pick up the new ConfigMap:

```bash
sudo kubectl rollout restart deployment prometheus -n monitoring
```

> [!TIP]
> ConfigMap changes do not automatically restart pods. You must manually
> restart the deployment after ArgoCD syncs the updated ConfigMap.

---

## Issue 1: kubernetes-service-endpoints Targets DOWN — Port Used as Hostname

**Symptom:** All 4 `kubernetes-service-endpoints` targets are DOWN with "no such host" errors:

```text
Error scraping target: Get "http://9094/metrics": dial tcp: lookup 9094: no such host
Error scraping target: Get "http://9153/metrics": dial tcp: lookup 9153: no such host
Error scraping target: Get "http://8080/metrics": dial tcp: lookup 8080: no such host
Error scraping target: Get "http://9090/metrics": dial tcp: lookup 9090: no such host
```

Notice the URLs: `http://9094/metrics`, `http://9153/metrics`. Prometheus is using port numbers **as hostnames** — there is no IP address.

**Root Cause:** The `relabel_configs` for the `kubernetes-service-endpoints` job had a bug. It replaced the `__address__` label with **only** the port number from the `prometheus.io/port` annotation:

```yaml
# BROKEN — replaces __address__ with just the port number
- source_labels: [__meta_kubernetes_service_annotation_prometheus_io_port]
  action: replace
  target_label: __address__
  regex: (.+)
  replacement: ${1}
```

When a service has the annotation `prometheus.io/port: "9090"`, this rule sets `__address__` to just `9090`. Prometheus then tries to connect to `http://9090/metrics`, treating `9090` as a hostname rather than a port number.

**How It Should Work:** The standard Prometheus relabeling pattern uses **two source labels** — the existing `__address__` (which contains the pod IP) and the annotation port — separated by a semicolon:

```yaml
# CORRECT — uses two source_labels joined by ";"
# Input:  __address__ = "10.244.0.15:8080"
#         annotation = "9090"
# Joined: "10.244.0.15:8080;9090"
# Regex:  captures "10.244.0.15" and "9090"
# Output: "10.244.0.15:9090"

- source_labels: [__address__, __meta_kubernetes_service_annotation_prometheus_io_port]
  action: replace
  target_label: __address__
  regex: ([^:]+)(?::\d+)?;(\d+)
  replacement: ${1}:${2}
```

Breaking down the regex `([^:]+)(?::\d+)?;(\d+)`:

| Part | Meaning |
| --- | --- |
| `([^:]+)` | Capture group 1: the IP address (everything before the first colon) |
| `(?::\d+)?` | Non-capturing group: discard the existing port (if present) |
| `;` | The separator Prometheus inserts between multiple `source_labels` |
| `(\d+)` | Capture group 2: the annotation port |

Also added support for `prometheus.io/scheme` and `prometheus.io/path` annotations:

```yaml
# Use the scheme annotation if present (http or https)
- source_labels: [__meta_kubernetes_service_annotation_prometheus_io_scheme]
  action: replace
  target_label: __scheme__
  regex: (https?)

# Use the path annotation if present (e.g., /prometheus/metrics)
- source_labels: [__meta_kubernetes_service_annotation_prometheus_io_path]
  action: replace
  target_label: __metrics_path__
  regex: (.+)
```

**File changed:** `monitoring/chart/templates/prometheus-configmap.yaml`
**Commit:** `9b92c5a`

**Diagnose (via SSM session on control plane):**

```bash
# 1. Check which targets are down
sudo kubectl run curl-targets --rm -it --restart=Never \
  --image=curlimages/curl -- \
  curl -s http://prometheus.monitoring.svc.cluster.local:9090/prometheus/api/v1/targets \
  | python3 -m json.tool | grep -A5 '"health": "down"'

# 2. Check the current Prometheus config for the relabel rules
sudo kubectl get configmap prometheus-config -n monitoring -o yaml \
  | grep -A 20 'kubernetes-service-endpoints'
```

**Verify after ArgoCD syncs:**

```bash
# Restart Prometheus to load the updated ConfigMap
sudo kubectl rollout restart deployment prometheus -n monitoring

# Wait ~30s then check targets
sudo kubectl run curl-targets --rm -it --restart=Never \
  --image=curlimages/curl -- \
  curl -s http://prometheus.monitoring.svc.cluster.local:9090/prometheus/api/v1/targets \
  | python3 -m json.tool | grep -B2 'kubernetes-service-endpoints'
```

#### What Success Looks Like

All `kubernetes-service-endpoints` targets show proper `host:port` addresses like `http://10.244.0.15:9090/metrics` and state `UP`.

> [!NOTE]
> **Resolved.** After fixing the relabel config, all endpoint targets
> correctly resolved to `<pod_ip>:<port>` format.

---

## Issue 2: Prometheus Self-Scrape Returns 404 Not Found

**Symptom:**

```text
Endpoint:  http://localhost:9090/metrics
State:     down
Error:     server returned HTTP status 404 Not Found
```

Prometheus is scraping itself at `/metrics` and getting a 404.

**Root Cause:** Prometheus is configured with `--web.external-url=/prometheus`. This flag moves **all HTTP endpoints** under the `/prometheus` prefix:

| Endpoint | Without external-url | With `--web.external-url=/prometheus` |
| --- | --- | --- |
| Metrics | `/metrics` | `/prometheus/metrics` |
| API | `/api/v1/query` | `/prometheus/api/v1/query` |
| Targets UI | `/targets` | `/prometheus/targets` |

The self-scrape job was using the default `metrics_path: /metrics`, which no longer exists. The correct path is `/prometheus/metrics`.

**Fix — add explicit `metrics_path`:**

```yaml
- job_name: prometheus
  metrics_path: /prometheus/metrics   # ← added
  static_configs:
    - targets: ["localhost:9090"]
```

**File changed:** `monitoring/chart/templates/prometheus-configmap.yaml`
**Commit:** `a2a7fd3`

**Diagnose (via SSM session on control plane):**

```bash
# 1. Test the old path (should return 404)
sudo kubectl run curl-test --rm -it --restart=Never \
  --image=curlimages/curl -- \
  curl -s -o /dev/null -w "%{http_code}" \
  http://prometheus.monitoring.svc.cluster.local:9090/metrics

# 2. Test the correct path (should return 200)
sudo kubectl run curl-test2 --rm -it --restart=Never \
  --image=curlimages/curl -- \
  curl -s -o /dev/null -w "%{http_code}" \
  http://prometheus.monitoring.svc.cluster.local:9090/prometheus/metrics
```

#### What Success Looks Like

The first test returns `404`, the second returns `200`. After applying the fix and restarting Prometheus, the self-scrape target shows `UP`.

> [!NOTE]
> **Resolved.** Added `metrics_path: /prometheus/metrics` to the
> Prometheus self-scrape job.

---

## Issue 3: Grafana Scrape Fails — Redirect Loop to localhost

**Symptom:**

```text
Endpoint:  http://grafana.monitoring.svc.cluster.local:3000/metrics
State:     down
Error:     Get "http://localhost/grafana/metrics": dial tcp [::1]:80: connect: connection refused
```

Notice the error URL changed from the target URL — Prometheus tried `/metrics` on Grafana, and Grafana responded with a **301 redirect** to `http://localhost/grafana/metrics` (port 80), which doesn't exist.

**Root Cause:** Grafana is configured with two environment variables:

```yaml
- name: GF_SERVER_ROOT_URL
  value: "%(protocol)s://%(domain)s/grafana/"
- name: GF_SERVER_SERVE_FROM_SUB_PATH
  value: "true"
```

When `SERVE_FROM_SUB_PATH=true`, Grafana moves all its endpoints under `/grafana/`, including `/metrics` → `/grafana/metrics`. When Prometheus requests `/metrics`, Grafana returns a 301 redirect to `/grafana/metrics` using the `ROOT_URL` domain, which resolves to `localhost:80` inside the pod — a port nothing listens on.

**Fix — add explicit `metrics_path`:**

```yaml
- job_name: grafana
  metrics_path: /grafana/metrics   # ← added
  static_configs:
    - targets: ["grafana.monitoring.svc.cluster.local:3000"]
```

By requesting `/grafana/metrics` directly, Prometheus bypasses the redirect entirely.

**File changed:** `monitoring/chart/templates/prometheus-configmap.yaml`
**Commit:** `a2a7fd3`

**Diagnose (via SSM session on control plane):**

```bash
# 1. Test the old path (should return 301 redirect)
sudo kubectl run curl-test --rm -it --restart=Never \
  --image=curlimages/curl -- \
  curl -s -o /dev/null -w "%{http_code}" \
  http://grafana.monitoring.svc.cluster.local:3000/metrics

# 2. Test the correct path (should return 200)
sudo kubectl run curl-test2 --rm -it --restart=Never \
  --image=curlimages/curl -- \
  curl -s -o /dev/null -w "%{http_code}" \
  http://grafana.monitoring.svc.cluster.local:3000/grafana/metrics
```

#### What Success Looks Like

The first test returns `301`, the second returns `200`. After the fix, the Grafana target shows `UP`.

> [!NOTE]
> **Resolved.** Added `metrics_path: /grafana/metrics` to the
> Grafana scrape job.

---

## Issue 4: Prometheus Service-Endpoint Still 404 After Relabel Fix

**Symptom:** After fixing Issue 1 (the relabel bug), the `kubernetes-service-endpoints` job now correctly resolves the IP:port — but the Prometheus endpoint still returns 404:

```text
Endpoint:  http://192.168.177.52:9090/metrics
State:     down
Error:     server returned HTTP status 404 Not Found
```

The IP and port are correct, but the path `/metrics` is wrong.

**Root Cause:** The Prometheus **Service** has the annotation `prometheus.io/scrape: "true"`, which causes the `kubernetes-service-endpoints` job to auto-discover it. However, the service was missing the `prometheus.io/path` annotation:

```yaml
# prometheus-service.yaml (BEFORE)
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "9090"
  # prometheus.io/path is MISSING — defaults to /metrics
```

Without the path annotation, the `kubernetes-service-endpoints` job defaults to scraping `/metrics`. But as explained in Issue 2, Prometheus's metrics are at `/prometheus/metrics` due to `--web.external-url=/prometheus`.

**Fix — add `prometheus.io/path` annotation:**

```yaml
# prometheus-service.yaml (AFTER)
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "9090"
  prometheus.io/path: "/prometheus/metrics"   # ← added
```

The relabel config (fixed in Issue 1) already supports this annotation via:

```yaml
- source_labels: [__meta_kubernetes_service_annotation_prometheus_io_path]
  action: replace
  target_label: __metrics_path__
  regex: (.+)
```

This rule reads the `prometheus.io/path` annotation and sets `__metrics_path__` to its value, overriding the default `/metrics`.

**File changed:** `monitoring/chart/templates/prometheus-service.yaml`
**Commit:** `4dc6bf0`

**Diagnose (via SSM session on control plane):**

```bash
# 1. Check current service annotations
sudo kubectl get service prometheus -n monitoring -o yaml \
  | grep -A5 'annotations'

# 2. Verify the annotation is being picked up by the relabel config
sudo kubectl run curl-targets --rm -it --restart=Never \
  --image=curlimages/curl -- \
  curl -s http://prometheus.monitoring.svc.cluster.local:9090/prometheus/api/v1/targets \
  | python3 -m json.tool | grep -A10 'kubernetes-service-endpoints'
```

**Verify after ArgoCD syncs:**

```bash
sudo kubectl rollout restart deployment prometheus -n monitoring
```

#### What Success Looks Like

The `kubernetes-service-endpoints` target for Prometheus shows the scrape URL as `http://192.168.x.x:9090/prometheus/metrics` and state `UP`.

> [!NOTE]
> **Resolved.** Added `prometheus.io/path: "/prometheus/metrics"` to
> the Prometheus service annotations.

---

## Issue 5: Next.js Application Metrics Not Appearing

**Symptom:** No `nextjs-app` target appears in the Prometheus targets page at all. The Next.js application metrics are not being collected.

**Root Cause:** Two things were missing:

1. **No scrape job** existed in `prometheus-configmap.yaml` for the Next.js app
2. The Next.js app exposes metrics via the `prom-client` npm package at `/api/metrics` on port 3000, but Prometheus was never configured to scrape this endpoint

This was not a bug — it was a **missing feature**. The Next.js app lives in a separate namespace (`nextjs-app`) from the monitoring stack (`monitoring`).

**Fix — add scrape job and verify network access:**

Added a new scrape job targeting the Next.js service:

```yaml
- job_name: nextjs-app
  metrics_path: /api/metrics
  static_configs:
    - targets: ["nextjs.nextjs-app.svc.cluster.local:3000"]
```

| Config | Value | Why |
| --- | --- | --- |
| `job_name` | `nextjs-app` | Descriptive label for this scrape job |
| `metrics_path` | `/api/metrics` | The Next.js app serves metrics at this route via `prom-client` |
| `targets` | `nextjs.nextjs-app.svc.cluster.local:3000` | The Kubernetes Service DNS name (service `nextjs` in namespace `nextjs-app`, port 3000) |

**Network access:** The Next.js `NetworkPolicy` (`network-policy.yaml`) already permits ingress from the `monitoring` namespace:

```yaml
# nextjs network-policy.yaml (already present, no changes needed)
- from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: monitoring
  ports:
    - port: 3000
      protocol: TCP
```

This rule says: "Allow TCP traffic on port 3000 from any pod in a namespace labelled `kubernetes.io/metadata.name: monitoring`." Since Prometheus runs in the `monitoring` namespace, it is permitted to scrape the Next.js pods.

**File changed:** `monitoring/chart/templates/prometheus-configmap.yaml`
**Commit:** `8cdddde`

**Diagnose (via SSM session on control plane):**

```bash
# 1. Check if the Next.js service is reachable from within the cluster
sudo kubectl run curl-test --rm -it --restart=Never \
  -n monitoring --image=curlimages/curl -- \
  curl -s -o /dev/null -w "%{http_code}" \
  http://nextjs.nextjs-app.svc.cluster.local:3000/api/metrics

# 2. If the above returns 000 (connection refused), check the NetworkPolicy
sudo kubectl get networkpolicy -n nextjs-app -o yaml

# 3. Verify the Next.js pod is running
sudo kubectl get pods -n nextjs-app
```

#### What Success Looks Like

A new `nextjs-app` target appears in Prometheus with state `UP` and shows metrics like `nodejs_heap_size_total_bytes`, `http_request_duration_seconds`, etc.

> [!NOTE]
> **Resolved.** Added the `nextjs-app` scrape job. The NetworkPolicy
> already permitted cross-namespace access.

---

## Issue 6: github-actions-exporter Connection Refused — Pod Not Running

**Symptom:**

```text
Endpoint:  http://github-actions-exporter.monitoring.svc.cluster.local:9101/metrics
State:     down
Error:     dial tcp 10.97.235.176:9101: connect: connection refused
```

Unlike the other issues, this is `connection refused` — not a 404 or redirect. This means nothing is listening on port 9101 at the Service IP.

**Root Cause:** Investigation revealed that **no pods existed** for the github-actions-exporter:

```bash
sudo kubectl get pods -n monitoring -l app=github-actions-exporter
# No resources found in monitoring namespace.
```

The secret existed, and the deployment template was present in the Helm chart, but the exporter was **explicitly disabled** in `values-development.yaml`:

```yaml
# values-development.yaml (BEFORE)
# GitHub Actions Exporter — disabled until GITHUB_TOKEN is in SSM
githubActionsExporter:
  replicas: 0
```

With `replicas: 0`, Kubernetes creates the Deployment and Service (so the Service IP exists and resolves), but no pods are created. The Service has no backing pods, so any connection to the Service IP results in `connection refused`.

**Fix — enable the exporter after provisioning the secret:**

Step 1 — Create the Kubernetes secret containing the GitHub PAT(done manually on the control plane):

```bash
sudo kubectl create secret generic github-actions-exporter-credentials \
  --from-literal=github-token=<YOUR_GITHUB_PAT> \
  -n monitoring
```

> [!IMPORTANT]
> The GitHub PAT requires `actions:read` scope (for fine-grained tokens)
> or `repo` scope (for classic tokens) to read workflow run data.

Step 2 — Enable the exporter by setting `replicas: 1`:

```yaml
# values-development.yaml (AFTER)
# GitHub Actions Exporter
githubActionsExporter:
  replicas: 1
```

**Files changed:**
- `monitoring/chart/values-development.yaml` (set `replicas: 0` → `replicas: 1`)

**Commit:** `1e6746f`

**Diagnose (via SSM session on control plane):**

```bash
# 1. Check if the pod exists
sudo kubectl get pods -n monitoring -l app=github-actions-exporter

# 2. Check if the secret exists
sudo kubectl get secret github-actions-exporter-credentials -n monitoring

# 3. Check pod logs for authentication errors
sudo kubectl logs -n monitoring -l app=github-actions-exporter --tail=20

# 4. If the deployment exists but has 0 replicas, check values
sudo kubectl get deployment github-actions-exporter -n monitoring -o yaml \
  | grep replicas
```

**Verify after ArgoCD syncs:**

```bash
# Wait for the pod to start
sudo kubectl get pods -n monitoring -l app=github-actions-exporter -w

# Test the metrics endpoint
sudo kubectl run curl-test --rm -it --restart=Never \
  --image=curlimages/curl -- \
  curl -s -o /dev/null -w "%{http_code}" \
  http://github-actions-exporter.monitoring.svc.cluster.local:9101/metrics
```

#### What Success Looks Like

The `github-actions-exporter` pod is `Running` and the Prometheus target shows `UP`.

> [!NOTE]
> **Resolved.** Enabled the exporter by setting `replicas: 1` after
> the GitHub token secret was provisioned in the cluster.

---

## Related Fix: Grafana Datasource URL Returns 404

**Symptom:** Grafana dashboard queries fail with "There was an error returned querying the Prometheus API." The Grafana UI shows a 404 error when trying to query Prometheus.

**Root Cause:** The Grafana datasource URL in `grafana-configmap.yaml` did not include the `/prometheus` sub-path:

```yaml
# BEFORE — returns 404 because Prometheus API is under /prometheus
url: http://prometheus.monitoring.svc.cluster.local:9090

# AFTER — correct path
url: http://prometheus.monitoring.svc.cluster.local:9090/prometheus
```

This is the same underlying issue as Issue 2 — Prometheus's `--web.external-url=/prometheus` moves all API endpoints under `/prometheus/`.

**Diagnose (via SSM session on control plane):**

```bash
# 1. Test the old URL (should return 404)
sudo kubectl run curl-test --rm -it --restart=Never \
  --image=curlimages/curl -- \
  curl -s -o /dev/null -w "%{http_code}" \
  http://prometheus.monitoring.svc.cluster.local:9090/api/v1/query?query=up

# 2. Test the correct URL (should return 200)
sudo kubectl run curl-test2 --rm -it --restart=Never \
  --image=curlimages/curl -- \
  curl -s -o /dev/null -w "%{http_code}" \
  "http://prometheus.monitoring.svc.cluster.local:9090/prometheus/api/v1/query?query=up"
```

**File changed:** `monitoring/chart/templates/grafana-configmap.yaml`

> [!TIP]
> After updating the Grafana datasource URL and ArgoCD syncs, restart
> Grafana to load the new ConfigMap:
> `sudo kubectl rollout restart deployment grafana -n monitoring`

---

## Related Fix: Tempo remote_write URL Returns 404

**Symptom:** Tempo's metrics generator silently fails to push generated metrics to Prometheus.

**Root Cause:** The Tempo ConfigMap has a `metrics_generator` section that pushes generated span metrics to Prometheus via remote_write. The URL was missing the `/prometheus` prefix:

```yaml
# BEFORE
metrics_generator:
  storage:
    remote_write:
      - url: http://prometheus.monitoring.svc.cluster.local:9090/api/v1/write

# AFTER
metrics_generator:
  storage:
    remote_write:
      - url: http://prometheus.monitoring.svc.cluster.local:9090/prometheus/api/v1/write
```

**File changed:** `monitoring/chart/templates/tempo-configmap.yaml`

---

## Key Takeaway — Sub-Path Prefix Reference Table

When Prometheus (or any service) is configured with a sub-path prefix, every URL reference to that service must include the prefix. Use this table as a quick reference:

| Configuration | Needs Sub-Path? | Correct Value |
| --- | --- | --- |
| Prometheus self-scrape `metrics_path` | Yes | `/prometheus/metrics` |
| Prometheus service annotation `prometheus.io/path` | Yes | `/prometheus/metrics` |
| Grafana scrape `metrics_path` | Yes | `/grafana/metrics` |
| Grafana datasource URL | Yes | `...:9090/prometheus` |
| Tempo `remote_write` URL | Yes | `...:9090/prometheus/api/v1/write` |
| Internal Kubernetes Service DNS | No | `prometheus.monitoring.svc:9090` (unchanged) |
| Next.js scrape `metrics_path` | Custom | `/api/metrics` (app-specific, not sub-path related) |

> [!IMPORTANT]
> The Kubernetes Service DNS name and port stay the same. Only the **URL
> path** portion needs the prefix. The Service acts as a TCP proxy — it
> doesn't know about HTTP paths.

---

## Common Verification Commands

### Check All Prometheus Targets

```bash
# Via the API
sudo kubectl run curl-targets --rm -it --restart=Never \
  --image=curlimages/curl -- \
  curl -s http://prometheus.monitoring.svc.cluster.local:9090/prometheus/api/v1/targets \
  | python3 -m json.tool
```

### Restart Deployments After ConfigMap Changes

```bash
sudo kubectl rollout restart deployment prometheus -n monitoring
sudo kubectl rollout restart deployment grafana -n monitoring
```

### Test Service Connectivity From Inside the Cluster

```bash
sudo kubectl run curl-test --rm -it --restart=Never \
  --image=curlimages/curl -- \
  curl -s -o /dev/null -w "%{http_code}" <URL>
```

### Check Pod Logs

```bash
sudo kubectl logs -n monitoring -l app=<component> --tail=50
```

### Check Service Annotations

```bash
sudo kubectl get service <service-name> -n monitoring -o yaml | grep -A10 annotations
```

### Force ArgoCD Re-Sync

```bash
sudo kubectl patch application monitoring -n argocd \
  --type merge \
  -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}'
```

### Check Current Prometheus Config

```bash
sudo kubectl get configmap prometheus-config -n monitoring -o yaml
```

---

## Glossary

| Term | Definition |
| --- | --- |
| **__address__** | Internal Prometheus label containing the `host:port` of the scrape target |
| **__metrics_path__** | Internal Prometheus label containing the URL path for scraping (default: `/metrics`) |
| **__scheme__** | Internal Prometheus label containing the protocol for scraping (default: `http`) |
| **metrics_path** | Scrape job config option that sets the default `__metrics_path__` for all targets in the job |
| **prom-client** | Node.js client library for Prometheus — exposes a `/metrics`-compatible endpoint in JavaScript apps |
| **Relabeling** | Prometheus mechanism to transform metadata labels before scraping — controls target URL, labels, and filtering |
| **remote_write** | Prometheus feature that pushes metrics to a remote endpoint (used by Tempo to send generated metrics) |
| **Scrape Config** | A YAML block in `prometheus.yml` that defines how and where Prometheus collects metrics |
| **Service Discovery (SD)** | Automatic target detection by querying an external source (e.g., Kubernetes API) |
| **source_labels** | Relabel config field specifying which labels to read; multiple labels are joined by `;` |
| **Static Targets** | Hard-coded scrape targets defined directly in the config (no automatic discovery) |
| **Sub-Path Routing** | Serving an application from a URL path prefix (e.g., `/grafana`) instead of its own domain |
| **web.external-url** | Prometheus flag that sets the base URL for all HTTP endpoints — moves UI, API, and metrics under a path |
