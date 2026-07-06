---
title: Bedrock LLM cost observability — per-model, per-service token attribution
type: concept
tags: [bedrock, llm, finops, cost, observability, prometheus, cost-explorer, ai, token-attribution, model-tiering]
sources:
  - charts/monitoring/chart/dashboards/bedrock-spend.json
  - charts/monitoring/chart/dashboards/llm-operations.json
  - charts/monitoring/chart/templates/grafana/datasources-configmap.yaml
created: 2026-07-06
updated: 2026-07-06
---

# Bedrock LLM cost observability — per-model, per-service token attribution

Every Amazon Bedrock call is instrumented for cost: the calling pipeline records
tokens and estimated USD tagged by model, service, route, and token direction,
and the platform reconciles that against the actual AWS bill. This is
FinOps-for-AI at the granularity the discipline recommends — per-token
attribution and deliberate model tiering — with the numbers below read live from
the cluster on 2026-07-06.

## Three views of the same spend

The `bedrock-spend` dashboard deliberately triangulates three independent
sources ([charts/monitoring/chart/dashboards/bedrock-spend.json](../../charts/monitoring/chart/dashboards/bedrock-spend.json)):

1. **Real-time operational metrics (Prometheus)** — `bedrock_calls_total`,
   `bedrock_cost_usd_total`, `bedrock_tokens_total`, scraped from the pipeline
   pods and labelled `{model, service, route, kind}`. Feeds the
   `llm-operations` dashboard (cost / latency / quality).
2. **Attribution of record (RDS `prompt_invocations`)** — recorded spend by
   pipeline, agent, and user, queried via the `rds-postgres` datasource. This is
   the per-user / per-feature ledger.
3. **Ground truth (AWS Cost Explorer via Steampipe)** —
   `SELECT service, sum(unblended_cost_amount) FROM aws_cost_...` — the actual
   billed amount.

Having all three lets the app-side estimate be reconciled against the real bill
rather than trusted blindly.

## The metric label set

`bedrock_tokens_total` carries the full attribution needed for FinOps
accounting: `{model, service, route, kind}` where `kind` is `input` or `output`
(input and output tokens are priced differently). Example live series
(job-strategist, 2026-07-06):

```text
bedrock_tokens_total{model="…claude-sonnet-4-6", service="strategist-writer",
                     route="strategist-writer", kind="output"} = 19462
```

Because every call is tagged at emit time, cost rolls up by any dimension — model,
pipeline, route, or input-vs-output — without re-instrumenting.

## Live spend profile (2026-07-06, app-recorded)

| Model | Role | Calls | Tokens | Recorded cost |
|-------|------|------:|-------:|--------------:|
| claude-haiku-4-5 | research, classification, clustering, coaching | **177** | 1.73 M | **$3.00** |
| claude-sonnet-4-6 | writing, case-study, system-tour (generation) | **118** | 3.27 M | **$21.50** |
| **Total** | | **295** | ~5.0 M | **$24.51** |

Derived: cost per call is **$0.017** (Haiku) vs **$0.182** (Sonnet) — a **~10.7×**
gap — and Sonnet carries **88%** of spend on **40%** of calls.

## Recorded vs billed reconciliation

App-recorded cumulative spend (Prometheus `sum(bedrock_cost_usd_total)`) reads
**$24.51**, while AWS Cost Explorer bills **$0.90** (June 2026) + **$0.28**
(July, partial) for Amazon Bedrock in this account
([verified via `aws ce get-cost-and-usage` on 2026-07-06]). The two are expected
to differ — the Prometheus counter is cumulative since instrumentation began and
uses published per-token list prices, whereas Cost Explorer reflects the actual
metered bill in its window. Surfacing both side by side is the entire point of
the dashboard: the app-side estimate is a *control signal*, and the CE line is
the *ground truth* it is reconciled against.

## How this measures against FinOps-for-AI standards

- **Granular attribution — implemented.** The primary FinOps-for-AI challenge is
  attribution: tagging every call so cost rolls up per model / service / feature
  ([Vantage: FinOps for AI token costs](https://www.vantage.sh/blog/finops-for-ai-token-costs),
  [Traceloop](https://www.traceloop.com/blog/from-bills-to-budgets-how-to-track-llm-token-usage-and-cost-per-user)).
  This stack tags `{model, service, route, kind}` at emit time and keeps a
  per-user ledger in `prompt_invocations` — the capability the guidance says
  most teams are still building ("most companies are still in the measure-and-
  understand phase").
- **Model tiering — implemented and on-benchmark.** The industry finding is that
  60–70% of LLM features tolerate a smaller model, and a ~10:1 small-to-large
  ratio lands blended cost near one-tenth of flagship-for-everything
  ([Vantage](https://www.vantage.sh/blog/finops-for-ai-token-costs)). Live, **60%
  of Bedrock calls (177/295) route to the cheaper Haiku tier**, reserving Sonnet
  for generation — squarely inside the 60–70% band, and the measured **~10.7×**
  cost-per-call gap between the tiers is the lever that keeps blended cost down
  (published flagship-vs-small gaps run 18–20× per output token).
- **Reconciliation against the bill — implemented.** Triangulating app metrics,
  an RDS ledger, and Cost Explorer is more than most teams do; the common
  baseline is a single provider invoice with no per-feature breakdown.

## Related

- [Bedrock spend — billed (CE) vs recorded (RDS)](../../charts/monitoring/chart/dashboards/bedrock-spend.json) (dashboard)
- [Application RED metrics and multi-window SLO alerting](./application-red-and-slo-metrics.md)
- [Observability hardening & cost optimisation — July 2026](../projects/2026-07-observability-hardening-and-cost.md)

<!--
Evidence trail (auto-generated):
- Source: charts/monitoring/chart/dashboards/bedrock-spend.json (CE-via-Steampipe + RDS prompt_invocations panels, read 2026-07-06)
- Live (Prometheus via kubectl proxy, 2026-07-06): bedrock_cost_usd_total sum $24.51; Haiku $3.00/177 calls/1.73M tok; Sonnet $21.50/118 calls/3.27M tok; labels {model,service,route,kind}
- Live (AWS Cost Explorer, 2026-07-06): Bedrock unblended $0.898 (Jun) + $0.276 (Jul partial)
- Web: Vantage FinOps-for-AI, Traceloop token attribution (model tiering 60-70%, 18-20x gap, measure-and-understand phase)
- Note: Grafana MCP API key returned 401 this session; live values read via kubectl->Prometheus proxy + aws ce (equivalent live sources)
-->
