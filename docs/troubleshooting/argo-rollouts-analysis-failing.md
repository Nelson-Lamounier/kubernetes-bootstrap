---
title: Argo Rollouts Analysis Failing
type: troubleshooting
tags: [argo-rollouts, progressive-delivery, blue-green, prometheus, analysis, kubernetes, debugging]
sources:
  - charts/admin-api/chart/templates/analysis-template.yaml
  - charts/nextjs/chart/templates/analysis-template.yaml
  - charts/start-admin/chart/templates/analysis-template.yaml
  - charts/admin-api/chart/values.yaml
  - charts/nextjs/chart/values.yaml
  - argocd-apps/argo-rollouts.yaml
created: 2026-04-28
updated: 2026-04-28
---

# Argo Rollouts Analysis Failing

Diagnosis and resolution for AnalysisRun failures during Blue/Green pre-promotion — covering Prometheus connectivity, PromQL type errors, NaN edge cases, threshold breaches, and how to inspect live AnalysisRun state.

## First: inspect AnalysisRun status

Every diagnosis starts with the AnalysisRun object. Argo Rollouts creates one per rollout attempt, named after the Rollout revision:

```bash
# List all AnalysisRuns for a workload
kubectl get analysisrun -n admin-api

# Detailed status — shows each metric result
kubectl describe analysisrun <name> -n admin-api

# Or use the kubectl plugin (more readable output)
kubectl argo rollouts get rollout admin-api -n admin-api

# Watch live during a rollout
kubectl argo rollouts get rollout admin-api -n admin-api --watch
```

The `describe` output includes a `Status.MetricResults` block per metric:
- `Phase: Successful` — metric passed
- `Phase: Failed` — metric breached threshold (`failureLimit: 1` in these templates)
- `Phase: Error` — Prometheus query failed (network error, parse error)
- `Phase: Running` — analysis still in progress

A Rollout in the **Degraded** state with a paused AnalysisRun means the analysis failed; a Rollout in **Paused** means the analysis succeeded but `autoPromotionEnabled: false` is waiting for manual promotion.

## Scenario 1: Prometheus unreachable (`Error` phase)

**Symptom:** Both metrics immediately enter `Phase: Error`. `kubectl describe analysisrun` shows:
```
Message: could not complete get request: dial tcp: lookup prometheus.monitoring.svc.cluster.local: no such host
```
or:
```
Message: context deadline exceeded (Client.Timeout exceeded while awaiting headers)
```

**Cause:** All three AnalysisTemplates query a fixed address:
```
http://prometheus.monitoring.svc.cluster.local:9090/prometheus
```

The Argo Rollouts controller queries this address directly from the `argo-rollouts` namespace. Failures occur when:
- The `monitoring` namespace does not yet exist (bootstrap ordering issue)
- The `prometheus` Service in the `monitoring` namespace is down
- The `/prometheus` path prefix is incorrect (Prometheus was moved or the prefix changed)

**Diagnosis:**

```bash
# Verify Prometheus Service exists and is reachable
kubectl get svc prometheus -n monitoring
kubectl get pod -n monitoring -l app.kubernetes.io/name=prometheus

# Test connectivity from within the cluster (Argo Rollouts namespace)
kubectl run debug-dns --image=alpine/k8s:1.31.4 -n argo-rollouts --restart=Never --rm -it \
  -- wget -qO- http://prometheus.monitoring.svc.cluster.local:9090/prometheus/-/healthy

# Confirm the path prefix
kubectl get ingressroute -n monitoring | grep prometheus
```

**Resolution:** If Prometheus is down, resolve the underlying pod issue first. If the path prefix changed, update the `address` field in all three AnalysisTemplates and commit. The templates use the path `/prometheus` because the Traefik IngressRoute strips this prefix — but direct in-cluster Service traffic still needs the prefix if Prometheus is configured with `--web.external-url=/prometheus`.

## Scenario 2: PromQL returns `[]float64` — missing `scalar()` (historical bug)

**Symptom:** AnalysisRun enters `Phase: Error` with:
```
Message: Query returned non-numeric value: []float64{...}
```
or similar type mismatch error.

**Cause:** The Prometheus `rate()` and `histogram_quantile()` functions return vector results (multiple time series). Argo Rollouts' metric evaluation expects a single scalar. Without wrapping in `scalar()`, the result is a float64 slice rather than a single value.

This was fixed in all three templates with `scalar()`:

```yaml
# Correct form (current):
query: |
  scalar(
    sum(rate(traefik_service_requests_total{...}[5m])) /
    sum(rate(traefik_service_requests_total{...}[5m]))
  )
```

The nextjs template comment records the fix date (2026-03-18).

**Resolution:** If this error appears in a new or copied AnalysisTemplate, ensure both queries are wrapped in `scalar()`. Verify by running the raw PromQL in the Prometheus UI — a query that returns a `vector` result (multiple rows) rather than a `scalar` will cause this error.

## Scenario 3: `isNaN(result)` and zero-traffic preview

**Symptom:** Analysis fails immediately with both metrics showing `result: NaN` and `Phase: Failed`. The preview ReplicaSet was just deployed and has never received a request.

**Cause:** The preview ReplicaSet receives no production traffic — the active Service still points to the old ReplicaSet. The `rate()` query over a window with zero requests returns no time series, and `scalar()` of an empty result returns `NaN`.

Without the `isNaN(result)` guard, `NaN < 0.05` evaluates to false, triggering a failure. The success condition in all templates is:

```yaml
successCondition: "isNaN(result) || result < 0.05"
```

`isNaN(result)` returns true for NaN, short-circuiting the threshold check. Zero traffic = success.

**When this fails:** If the AnalysisTemplate is copied and the `isNaN` guard is omitted, every pre-promotion analysis will fail for freshly-deployed workloads that have never seen traffic. The fix is adding `isNaN(result) ||` to the success condition.

**Note:** The `isNaN` guard does mean that if Prometheus returns NaN due to an actual query error (misconfigured selector, wrong namespace), it will also be treated as success. The `consecutiveErrorLimit: 5` catches sustained Prometheus errors; a single NaN on the error-rate metric is indistinguishable from zero traffic.

## Scenario 4: Threshold breach — real metric failure

**Symptom:** AnalysisRun enters `Phase: Failed`. `kubectl describe` shows a specific numeric value:
```
MetricResults:
  - name: error-rate
    phase: Failed
    measurements:
      - phase: Failed
        value: "0.12"       # 12% — above threshold 0.05
```

**Cause:** The preview ReplicaSet is genuinely returning 5xx errors or experiencing elevated latency. The preview Service is the `prePromotionAnalysis` target — but these templates query the **active** Service metrics (`service=~"admin-api-admin-api-.*@kubernetes"`), not the preview.

This is intentional: the AnalysisTemplate measures baseline health of the active deployment during the pre-promotion window, not the preview itself (which has no prod traffic). A degraded baseline means the promotion window itself is unhealthy.

Thresholds by workload:

| Workload | Error rate | P95 latency |
|---------|-----------|-------------|
| `admin-api` | < 5% | < 1500ms |
| `nextjs` | < 5% | < 2000ms |
| `start-admin` | < 5% | < 2000ms |

**Resolution:** Do not promote. Investigate the cause of the degraded active Service. Once metrics return to baseline, abort the failed rollout and retry:

```bash
# Abort the current rollout (rolls back to previous active ReplicaSet)
kubectl argo rollouts abort admin-api -n admin-api

# Inspect active ReplicaSet logs
kubectl logs -n admin-api -l app.kubernetes.io/name=admin-api --tail=100

# Retry once the root cause is resolved
kubectl argo rollouts retry rollout admin-api -n admin-api
```

## Scenario 5: `failureLimit` vs `consecutiveErrorLimit`

The templates set:
```yaml
failureLimit: 1
consecutiveErrorLimit: 5
```

These control different failure modes:

| Parameter | Meaning | Effect |
|-----------|---------|--------|
| `failureLimit: 1` | Max 1 measurement can fail (threshold breached) | One bad measurement = AnalysisRun fails |
| `consecutiveErrorLimit: 5` | Max 5 consecutive Prometheus query errors | Tolerates transient Prometheus flaps |

If Prometheus is briefly unavailable (pod restart, scrape timeout), up to 5 consecutive query errors are tolerated before the AnalysisRun fails. This prevents a Prometheus restart from blocking every rollout.

**Symptom of hitting consecutiveErrorLimit:** AnalysisRun phase transitions to `Error` (not `Failed`) after 5 back-to-back measurements where Prometheus returned an HTTP error or timeout. Check Prometheus health:

```bash
kubectl get pod -n monitoring -l app.kubernetes.io/name=prometheus
kubectl logs -n monitoring -l app.kubernetes.io/name=prometheus --tail=50
```

## Scenario 6: `autoPromotionSeconds` accidentally set

**Symptom:** The Rollout promotes automatically within minutes despite `autoPromotionEnabled: false`. Analysis may not have completed.

**Cause:** Argo Rollouts has a quirk: any non-zero `autoPromotionSeconds` value causes automatic promotion after N seconds even when `autoPromotionEnabled: false`. The values.yaml comment warns:

```yaml
autoPromotionSeconds: 0   # 0 = disabled; any non-zero value auto-promotes
                          # after N seconds even when autoPromotionEnabled is false
                          # (Argo Rollouts quirk).
```

**Resolution:** Set `autoPromotionSeconds: 0` (not absent, not `null`) in the chart values. An absent field may be interpreted as a non-zero default depending on the Argo Rollouts version.

## Quick command reference

```bash
# List rollout status
kubectl argo rollouts list rollouts -n admin-api

# Full rollout detail with analysis
kubectl argo rollouts get rollout admin-api -n admin-api

# List AnalysisRuns
kubectl get analysisrun -n admin-api

# Describe a specific AnalysisRun
kubectl describe analysisrun <analysisrun-name> -n admin-api

# Abort a paused/degraded rollout
kubectl argo rollouts abort admin-api -n admin-api

# Manually promote after successful analysis
kubectl argo rollouts promote admin-api -n admin-api

# Retry after aborting
kubectl argo rollouts retry rollout admin-api -n admin-api

# Check Argo Rollouts controller logs
kubectl logs -n argo-rollouts -l app.kubernetes.io/name=argo-rollouts --tail=100
```

## Related

- [Progressive delivery with Argo Rollouts](../concepts/progressive-delivery-rollouts.md) — Blue/Green architecture, AnalysisTemplate structure, `isNaN` guard rationale, threshold tables
- [ArgoCD Image Updater](../concepts/argocd-image-updater.md) — how Image Updater triggers Rollouts by committing new image tags to Git

<!--
Evidence trail (auto-generated):
- Source: charts/admin-api/chart/templates/analysis-template.yaml (read 2026-04-28 — scalar() wrap, isNaN condition, prometheus address, traefik service selector, interval 60s count 3 failureLimit 1 consecutiveErrorLimit 5)
- Source: charts/nextjs/chart/templates/analysis-template.yaml (read 2026-04-28 — FIX 2026-03-18 scalar() comment, same structure, nextjs-nextjs-app-.*@kubernetes)
- Source: charts/start-admin/chart/templates/analysis-template.yaml (read 2026-04-28 — same pattern, start-admin-start-admin-.*@kubernetes)
- Source: charts/admin-api/chart/values.yaml (read 2026-04-28 — errorRateThreshold: 0.05, latencyThresholdMs: 1500, interval: 60s, count: 3, failureLimit: 1, consecutiveErrorLimit: 5, autoPromotionEnabled: false, autoPromotionSeconds: 0 quirk comment)
- Source: charts/nextjs/chart/values.yaml (read 2026-04-28 — latencyThresholdMs: 2000, autoPromotionSeconds: 0 quirk comment)
- Source: argocd-apps/argo-rollouts.yaml (read 2026-04-28 — chart 2.40.6, wave 3, monitoring node pool)
- Generated: 2026-04-28
-->
