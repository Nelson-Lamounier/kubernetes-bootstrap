---
title: Observability hardening & cost optimisation — July 2026
type: project
tags: [cost, finops, observability, eks, cloudwatch, argocd, rds, yace, prometheus, reliability]
sources:
  - infra/lib/stacks/kubernetes/eks-cluster-stack.ts (tucaken-infra)
  - infra/lib/stacks/kubernetes/eks-pod-identity-stack.ts (tucaken-infra)
  - charts/monitoring/chart/templates/traefik/allowlist-patcher.yaml
  - charts/monitoring/chart/templates/yace/
  - charts/platform-rds/chart/values-development.yaml
created: 2026-07-05
updated: 2026-07-05
---

# Observability hardening & cost optimisation — July 2026

Record of a production-hardening pass across the EKS/observability platform,
with **quantified, account-verified** cost impact. Every figure below was read
from the live `dev` account (`771826808455`, `eu-west-1`) on 2026-07-05 — none
is estimated unless explicitly labelled a projection.

---

## 1. Headline — net cost impact

| Metric | Before | After | Change |
|---|---:|---:|---:|
| EKS control-plane log ingestion | ~150 MB/hr | ~0.8 MB/hr | **−99.5%** (measured) |
| EKS control-plane log volume | ~108 GB/mo | ~0.6 GB/mo | −107 GB/mo |
| CloudWatch **vended-log** spend | **$52.91/mo** (Jun) | ~$4/mo (proj.) | **≈ −92%** |
| Total CloudWatch spend | **$53.49/mo** (Jun) | ~$7/mo (proj.) | **≈ −87%** |
| New spend added (YACE RDS metrics) | $0 | ~$2.25/mo | +$2.25/mo |
| **Net monitoring saving** | — | — | **≈ $46/mo (~87%)** |

> Month-to-month variance: the vended-log bill was **$34.54** in May and
> **$52.91** in June (audit-log volume tracks cluster activity), so the saving
> is best expressed as the **~92% cut in the vended-log line** rather than a
> fixed dollar amount. On a trailing-two-month average (~$44/mo) the saving is
> **~$40/mo**.

**In one line:** we removed ~99.5% of a self-inflicted CloudWatch Logs bill and
added a ~$2.25/mo Prometheus-based RDS metrics pipeline — cutting total
monitoring spend by roughly **87%** while *improving* observability reliability.

---

## 2. The cost saving — what, how, and the evidence

### 2.1 What we changed
Disabled the **`API`** and **`AUDIT`** EKS control-plane log streams (tucaken-infra
`EksClusterStack.clusterLogging`), keeping only `AUTHENTICATOR`,
`CONTROLLER_MANAGER`, and `SCHEDULER`.

### 2.2 How we found it (methodology)
1. **Cost Explorer** — grouped `AmazonCloudWatch` spend by usage type and saw a
   single line dominate: `EU-VendedLog-Bytes` = **$52.91/mo** (June), i.e. ~99%
   of the CloudWatch bill. Everything else (metrics `GetMetricData`, dashboards,
   storage) was cents.
2. **CloudWatch Logs `IncomingBytes` per log group** — attributed the vended-log
   volume: `/aws/eks/k8s-eks-development/cluster` ingested **~102 GB/30d** (~93%
   of all vended logs); VPC flow logs ~7.7 GB; the RDS postgres log group ~0.
3. **Root cause** — the EKS control-plane log group is driven by the **AUDIT**
   stream (the Kubernetes "who did what" trail) and the **API** apiserver
   request log — both extremely verbose. The other three streams are small.
4. **Trade-off decision** — dropped `API`+`AUDIT` in all environments (product
   decision: no compliance requirement for a K8s audit trail here). The three
   retained streams keep access-debugging (`authenticator`) and control-loop
   health (`controllerManager`, `scheduler`) visible.

### 2.3 The evidence (measured before/after, 5-min buckets)
The change applied at ~09:40 UTC on 2026-07-05. Ingestion into the EKS
control-plane log group, before and after:

```
 09:33   13.44 MB / 5m  (161 MB/hr)   ← before (API+AUDIT on)
 09:38    6.93 MB / 5m  ( 83 MB/hr)   ← change applying
 09:43    0.07 MB / 5m  (0.8 MB/hr)   ← after (API+AUDIT off)
 09:48    0.09 MB / 5m  (1.1 MB/hr)
 09:53    0.06 MB / 5m  (0.7 MB/hr)
 09:58    0.03 MB / 5m  (0.4 MB/hr)
```

A steady **~150 MB/hr → ~0.8 MB/hr** step — a **99.5% reduction**, confirming
API+AUDIT were essentially the entire control-plane log volume.

### 2.4 The dollar maths
- Vended-log ingestion price (eu-west-1, Pricing API): **$0.57/GB** (first 10 TB
  tier; our ~110 GB/mo sits well inside it).
- EKS control-plane volume: ~108 GB/mo → ~0.6 GB/mo (**−107 GB/mo**).
- EKS control-plane was ~93% of the **$52.91/mo** June vended-log bill ≈
  **$49/mo**; removing 99.5% of it saves **≈ $49/mo** (June basis).
- Residual vended-log spend ≈ VPC flow logs (~$4/mo) + the three kept streams
  (~$0.3/mo).

### 2.5 Guardrail against regression
A unit test asserts the cluster enables **only** the three cheap streams
(`toStrictEqual(['authenticator','controllerManager','scheduler'])` and
`not.toContain('audit'/'api')`), plus an `AwsSolutions-EKS2` cdk-nag suppression
documenting the deliberate choice. A future edit that re-enables the expensive
logs fails CI.

---

## 3. The new spend — YACE (justified by reliability, not cost)

To move RDS observability **off the fragile Grafana CloudWatch datasource** onto
Prometheus, we deployed **YACE** (yet-another-cloudwatch-exporter) to scrape
`AWS/RDS` CloudWatch metrics into Prometheus.

- **Added cost:** `GetMetricData` at **$0.01 per 1,000 metrics** (eu-west-1,
  Pricing API) × 26 RDS metrics × 8,640 scrapes/mo (300 s period) ≈ **$2.25/mo**.
  1-minute scraping would be ~$11/mo — deliberately avoided; RDS metrics don't
  need sub-5-minute resolution.
- **Compute:** the YACE pod lands on existing Karpenter capacity → **$0 marginal**.
- **Benefit (why it's worth $2.25/mo):**
  - Rename-proof, tag-based discovery (an instance rename can no longer blank the
    panels — the incident that started this work).
  - Panels render everywhere including the image-renderer (CloudWatch panels
    never did — the render service account can't query CloudWatch).
  - **RDS alerting is now possible** — six Prometheus alerts (CPU-credit
    exhaustion, storage, memory, connections, disk-queue, txn-ID wraparound) that
    a Prometheus rule simply *could not* evaluate against a CloudWatch metric.
  - One datasource for RDS instead of a datasource that silently failed on
    variable interpolation.

---

## 4. Reliability hardening (non-cost benefits)

### 4.1 ArgoCD PostSync hooks no longer wedge deploys
A stale sync operation on the `monitoring-allowlist-patcher` PostSync hook
blocked **every monitoring deploy for ~14 hours** before it was found.

- **Root cause:** the hook Job had no `activeDeadlineSeconds` (so it could sit
  non-terminal forever) and used `ttlSecondsAfterFinished`, which **races
  ArgoCD's `hook-delete-policy`** — the K8s TTL controller deletes the Job out
  from under ArgoCD, orphaning the operation.
- **Fix:** replaced `ttlSecondsAfterFinished` with `activeDeadlineSeconds` on the
  **four** at-risk PostSync hooks (allowlist-patcher, headlamp token-pusher,
  tucaken-app + admin-api waf-annotator). A stuck hook now **fails the sync
  visibly** instead of wedging it silently.
- **Benefit:** removes a whole class of silent deploy-pipeline outage. Quantified
  impact: the wedge cost ~14 h of blocked monitoring deploys in one incident;
  the fix makes recurrence self-clearing.

### 4.2 RDS migration flood fixed (deploy drift)
The `relation "resume_imports" already exists` RDS-log flood (every ~15–40 s) was
a **deployment drift**, not missing code: the checksummed migration ledger was
merged (ai-applications #243/#247) but the deployed bootstrap image
(`c0e075f`, 2026-05-20) predated it because CI's git-writeback to
`values-development.yaml` had stalled while the SSM tag advanced to `2d2774d`.

- **Fix:** re-aligned the values image tag to the ledger build (`2d2774d`).
- **Benefit:** the runner now applies each migration once and adopts the existing
  DB — the resume-import migrations succeed and the error flood stops. Cleaner
  logs (which are billed — see §2) and correct migration state.

---

## 5. Change inventory (PRs)

| Change | Repo / PR | Type |
|---|---|---|
| Drop EKS API+AUDIT control-plane logs | tucaken-infra #205 | cost |
| YACE `iam:ListAccountAliases` (clear scrape AccessDenied) | tucaken-infra #205 | hygiene |
| YACE Pod Identity role | tucaken-infra #204 | enablement |
| YACE exporter chart | k8s-bootstrap #198 | enablement |
| RDS panels → Prometheus + RDS alerts | k8s-bootstrap #199 | reliability |
| ArgoCD hook wedge fix (4 hooks) | k8s-bootstrap #200 | reliability |
| Deploy the migration-ledger image | k8s-bootstrap #204 | reliability/cost |
| YACE migration design doc | k8s-bootstrap #197 | docs |
| Observability review (superseded note) | tucaken-infra #203 | docs |

---

## 6. Verification log (2026-07-05, live account)

| Check | Result |
|---|---|
| EKS cluster `clusterLogging` (describe-cluster) | `api`,`audit` = **enabled:false**; 3 streams enabled:true |
| EKS control-plane ingestion (CloudWatch `IncomingBytes`) | **~150 → ~0.8 MB/hr** after change |
| Vended-log price (Pricing API, eu-west-1) | $0.57/GB (first 10 TB) |
| CloudWatch bill (Cost Explorer, June) | vended-logs $52.91, total $53.49 |
| `GetMetricData` price (Pricing API) | $0.01 / 1,000 metrics |
| YACE series in Prometheus | 26 `aws_rds_*` series, live values |
| RDS alerts | 6 rules, promtool-validated |

---

## 7. Open follow-ups

1. **CI git-writeback drift** — repair the writeback so runner-only changes (not
   just migrations) reliably bump `values-development.yaml`; today it can desync
   from SSM (§4.2 root cause).
2. **`migration-009-technology-graph`** — a pre-existing `ddl-migrations` chart
   hook fails the platform-rds sync; its SQL is idempotent, so the failure is
   likely transient (DB blip / 180 s deadline). Needs a real re-sync to capture
   the pod log.
3. **RDS logs panels** — the two CloudWatch Logs panels work in-browser but the
   image-renderer can't query CloudWatch; move RDS logs to Loki to make them
   renderer-proof (low value — RDS logs are ~0 and mostly checkpoint noise).
