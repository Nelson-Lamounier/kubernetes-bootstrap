# Project Generation Observability Design

**Date:** 2026-06-19

**Status:** Approved for implementation planning

**Dashboard:** `LLM Operations - Cost, Latency & Quality` (`uid: llm-operations`)

## Summary

Add a dedicated collapsible **Project generation — cost, execution, quality & traces** row to the existing LLM Operations dashboard. The row will cover clustering, case-study generation, grounding, persistence, and system-tour generation from request to result.

The design treats each telemetry store according to its strengths:

- PostgreSQL is the time-bounded system of record for workflow runs and model charges.
- Prometheus provides low-cardinality service health and instrumentation checks.
- Loki provides structured event detail and failure context.
- Tempo provides the causal waterfall across each workflow and its model calls.

The implementation spans `ai-applications` for missing correlation/instrumentation and `kubernetes-bootstrap` for the provisioned Grafana dashboard. Application instrumentation must deploy before the correlation panels are considered complete.

## Goals

1. Show charges, execution health, quality signals, and data effects for the full project-generation workflow.
2. Correlate a workflow run, every model invocation, its trace, and its logs with a stable `trace_id`.
3. Make the two-tier model policy observable: Haiku for clustering and Sonnet 4.6 for case-study and system-tour generation.
4. Preserve production-safe metric cardinality and dashboard query cost.
5. Provide useful empty states and direct pivots instead of ambiguous `No data` panels.

## Non-goals

- Changing project-generation product behavior, prompting, or confirmation gates.
- Replacing the existing whole-platform LLM panels.
- Adding user, project, repository, or trace identifiers as Prometheus labels.
- Treating AWS Cost Explorer as the source for per-run attribution; it remains an invoice-level reconciliation source.
- Reconstructing old traces for runs that occurred before correlation instrumentation ships.

## Verified Current State

The design is based on the live Grafana instance, live telemetry, and the current application source rather than dashboard assumptions.

### Dashboard and data sources

- The live dashboard is version 2 with Prometheus, Loki, Tempo, RDS PostgreSQL, Steampipe, and CloudWatch data sources.
- Existing panel 202, **Recorded spend by pipeline + agent (24h)**, already reads model charges from `prompt_invocations`.
- The existing **Trace and log pivots** row has broad worker/admin trace panels and workflow logs, but it does not provide a per-project-generation invocation index.
- The dashboard already exposes a `trace_id` variable, which will be reused for exact Tempo and Loki pivots.

### Application telemetry

- Project jobs expose `project_case_study_*` and `project_clustering_*` counters and histograms.
- Redis telemetry distinguishes `aigen:case_study` and `aigen:clustering` with `hit`, `miss`, and `error` outcomes.
- Bedrock metrics identify the `project-clustering`, `project-case-study`, and `project-system-tour` services/routes and their models.
- `pipeline_runs` records run type, status, reference, timestamps, errors, and JSON metadata.
- `prompt_invocations` records pipeline, agent, model, tokens, cost, latency, project attribution, and a nullable `trace_id`.

### Correlation gaps

- Project clustering and case-study Kubernetes jobs bootstrap OpenTelemetry but do not start an active root workflow span.
- `recordInvocationToRds` does not propagate the invocation log's trace ID to `recordBedrockCost`.
- `recordBedrockCost` does not insert `trace_id` even though the database column already exists.
- Project completion logs observed in Loki contain project and result metadata but no `trace_id`.
- The grounding verifier can record cost when given a cost context, but the project case-study orchestration does not currently pass it. Grounding spend is therefore absent from RDS attribution.

### Prometheus Pushgateway caveat

Project jobs push metrics with additive writes and a unique `instance=pipelineRunId`. The groups persist after the job exits. These series are per-run snapshots, not conventional continuously increasing counters. Consequently, `increase(...[24h])` can report zero even while completed run series and spend exist.

The new row must not use Pushgateway `increase()` queries as the source for time-window run counts, success rates, duration, or spend. Those panels will use RDS timestamps. Prometheus remains useful for current instrumentation presence, low-cardinality service health, and alert-oriented signals after aggregation.

## Source-of-Truth Model

| Question | Primary source | Reason |
|---|---|---|
| How many workflows ran in the selected range? | RDS `pipeline_runs` | Durable timestamps and terminal state |
| What did each model call cost? | RDS `prompt_invocations` | Per-invocation model, agent, tokens, cost, and attribution |
| Which stage is active or failed? | RDS `pipeline_runs` | Stable run lifecycle and error state |
| Was the workflow cached or refined? | RDS `pipeline_runs.metadata` | Run-level decision, including zero-call cache hits |
| What rows were inserted, pruned, or protected? | RDS `pipeline_runs.metadata` | Durable output effects |
| Was generated content grounded or flagged? | RDS run metadata plus structured Loki events | Aggregation in RDS, detailed claims in logs |
| What happened in execution order? | Tempo | Parent/child span causality and stage timing |
| What was logged for this exact trace? | Loki | Structured events filtered by `trace_id` |
| Is instrumentation currently emitting? | Prometheus | Low-latency operational health |

## Application Instrumentation Design

### Root workflow spans

Create one root span for each clustering and case-study job using the observability bootstrap's parent context. Execute the complete workflow inside the active span context so log enrichment and model invocation hooks can read it.

Root span names:

- `project.clustering.run`
- `project.case_study.run`

Root attributes should include low-risk trace attributes such as `pipeline.run_id`, `project.id` when applicable, workflow type, refine mode, cache result, model tier, and terminal outcome. These identifiers belong in traces, not Prometheus labels.

### Stage spans

Add child spans around meaningful causal stages rather than every helper call:

- Clustering: load signals, cache lookup, generate proposals, persist proposals.
- Case study: load context, compute input hash/cache lookup, resolve refine scope, generate, ground, persist, generate system tour.
- Model calls remain children of the active stage span through the existing Bedrock instrumentation.

Each span must record failure status and sanitized exception information. Root spans must always end in `finally` paths.

### Trace propagation to RDS

Extend the shared cost recording context with `traceId?: string` and insert it into `prompt_invocations.trace_id`. `recordInvocationToRds` should prefer the invocation log's active OpenTelemetry trace ID and permit an explicitly supplied workflow trace ID as a fallback.

Write the root trace ID to `pipeline_runs.metadata.traceId` at the start or first update of each project workflow. This gives Grafana a stable join from run to invocations and Tempo without introducing a schema migration.

### Structured completion and failure logs

Emit structured lifecycle logs inside the active span context. At minimum, completion and failure events must carry:

- `trace_id`, `pipeline_run_id`, workflow type, project/reference ID, and outcome;
- cache outcome, generation mode (`refine` or `full`), and selected model;
- total duration, tokens, attributed cost, and persistence counts when available;
- grounding checked/grounded/flagged counts and grounding cost;
- a sanitized error class/message for failures.

Do not log prompts, generated case-study prose, raw repository content, or user PII.

### Grounding cost and quality attribution

Pass the project workflow's pool, user, project, and trace context to `BedrockGroundingVerifier`. Record grounding calls under pipeline `grounding-verify`, linked to the project and root trace.

Persist aggregate grounding counts and cost in `pipeline_runs.metadata`. Claim-level details can remain structured Loki events to avoid inflating the workflow row or duplicating generated content.

### Persistence effects

Expand the persistence result and final run metadata to distinguish:

- inserted/upserted decisions, highlights, challenges, and stack items;
- stale rows pruned per section;
- rows or sections skipped because of sticky user overrides or confirmed content;
- system-tour generation success/failure.

The application remains authoritative for idempotency and sticky overrides; the dashboard only observes those decisions.

## Dashboard Design

### Row behavior

Add panel IDs in a reserved new range beginning at 700. The row is collapsible and defaults to collapsed to limit initial RDS, Loki, and Tempo query load. Expanding it reveals a progression from executive health to diagnosis.

All new range-based panels use the dashboard time picker (`$__timeFilter`, `$__range`, or the data-source equivalent), not a hard-coded 24-hour window. Existing dashboard variables remain compatible; project panels additionally filter by the existing pipeline variable only where that variable's semantics are valid.

### Panel inventory

| ID | Panel | Visualization | Source | Purpose |
|---:|---|---|---|---|
| 700 | Project generation — cost, execution, quality & traces | Collapsible row | — | Scope and query-load boundary |
| 701 | Spend | Stat | RDS | Total attributed project-generation spend in range |
| 702 | Runs | Stat | RDS | Clustering and case-study runs in range |
| 703 | Success rate | Stat | RDS | Terminal successful/cache-hit runs divided by terminal runs |
| 704 | p95 duration | Stat | RDS | p95 terminal run duration from timestamps |
| 705 | Cost by stage and model | Time series | RDS | Spend trend split by pipeline/agent/model tier |
| 706 | Charge ledger by project and agent | Table | RDS | Project, run/trace, stage, agent, model, tokens, latency, cost |
| 707 | Model-tier compliance | Table or bar gauge | RDS | Detect Haiku/Sonnet routing violations |
| 708 | Workflow run status | Table | RDS | Run, project/reference, mode, cache, stage/status, duration, cost, trace link |
| 709 | Cache and generation mode | Bar chart | RDS | Cache hit/miss/error and refine/full distributions |
| 710 | Context and persistence effects | Table | RDS | Context loaded, inserted/upserted, pruned, and sticky-skipped counts |
| 711 | Grounding quality and cost | Bar chart plus compact table | RDS | Grounded/flagged counts and grounding charges |
| 712 | Project API traffic, latency, and errors | Time series | Prometheus | Confirm/regenerate/read route operational health |
| 713 | Workflow trace index | Table | RDS | One row per workflow trace and agent invocation with exact pivots |
| 714 | Selected workflow trace | Traces | Tempo | Waterfall for `$trace_id` or selected trace |
| 715 | Selected workflow logs | Logs | Loki | Structured logs filtered by `$trace_id` |

If Grafana layout constraints make a combined panel ambiguous, panel 711 may be split into adjacent quality and grounding-cost panels without changing the data contract.

### Query behavior

- RDS queries must be range-bounded and apply sensible row limits to detail tables.
- Cost must be converted from stored cents to USD exactly once.
- Workflow duration is `updated_at - created_at` only for terminal rows; active rows display elapsed time separately and do not pollute p95.
- Cache hits with no model call remain visible as successful runs with zero generation spend.
- Success-rate denominators exclude queued/running rows.
- Tier compliance maps clustering to Haiku and case-study/system-tour generation to Sonnet 4.6. Unknown or mismatched models render as violations, not as silently ignored rows.
- Trace-index rows join `pipeline_runs.metadata->>'traceId'` to `prompt_invocations.trace_id`; workflows with no invocation, including cache hits, still link through the root trace.
- Data links set the dashboard `trace_id` variable and preserve the selected time range. Tempo and Loki panels read that exact value.
- The Loki query requires a non-empty valid trace ID and otherwise shows guidance rather than a broad expensive query.
- The Tempo panel should perform exact trace lookup when supported; a scoped TraceQL fallback may be used for datasource compatibility.

## Visual and Interaction Standards

- Use stats for single executive values, time series for trends, tables for high-dimensional attribution, bars for categorical breakdowns, Tempo traces for causality, and Loki logs for event inspection.
- Avoid pie charts, decorative gauges, and duplicated KPIs.
- Use Grafana theme-aware colors. Green means healthy/compliant, amber means degraded or flagged, and red means failed or policy-violating; never rely on color alone when text/status can carry the same meaning.
- Apply correct units: USD, milliseconds/seconds, percentages, token counts, and short date-time formats.
- Use explicit thresholds based on operational meaning. Success and compliance use red below 95%, amber from 95% to below 99%, and green at 99% or above initially; thresholds can be tuned after a representative baseline exists.
- Sort diagnostic tables by newest or highest-cost first, freeze key identity columns where supported, cap row counts, and use concise field names.
- Hide noisy internal columns while retaining them for links and transformations.
- Add panel descriptions that state the source and interpretation, especially where RDS and Prometheus differ.

## Empty, Partial, and Error States

- Stat panels return a typed zero or `N/A` as appropriate rather than Grafana's generic `No data`.
- Rate and p95 panels display `N/A` when no terminal run exists; they must not imply 0% success or zero latency.
- Detail panels explain when no workflow occurred in the selected range.
- Trace/log panels instruct the operator to select a trace from the index when `trace_id` is empty.
- Missing trace IDs are displayed as an instrumentation gap in the run/index table so pre-deployment historical rows are understandable.
- RDS, Loki, or Tempo errors remain visible as datasource errors; queries must not transform failures into healthy zeros.

## Cardinality, Privacy, and Security

- Prometheus labels remain restricted to bounded dimensions such as service, route template, workflow type, outcome, cache result, and model tier.
- User IDs, project IDs, pipeline-run IDs, repository names, and trace IDs remain in RDS, Loki fields, or Tempo attributes.
- Dashboard tables should prefer project/reference identifiers over user identity and must not surface email addresses or prompt/output text.
- Logs and span attributes must sanitize errors and exclude credentials, source content, generated prose, and private user data.
- Existing Grafana datasource permissions and dashboard RBAC remain the access boundary.

## Rollout Sequence

1. Implement and test trace propagation, root/stage spans, grounding attribution, persistence summaries, and structured logs in `ai-applications`.
2. Deploy the application changes and trigger one clustering run, one full case-study run, one cache-hit run, and one refine run.
3. Verify that each run has a root Tempo trace, trace-enriched Loki events, `pipeline_runs.metadata.traceId`, and trace-linked `prompt_invocations` rows.
4. Implement the provisioned Grafana row in `kubernetes-bootstrap` using the verified field shapes.
5. Deploy the dashboard, inspect every panel against the generated runs, and verify exact table-to-Tempo-to-Loki pivots.
6. Compare aggregate RDS spend with existing Bedrock metrics and invoice-level data as a reconciliation check, not an equality assertion for arbitrary time windows.

## Validation Plan

### Application

- Unit tests for trace ID insertion in direct and agent-based cost recording.
- Tests that root spans end and terminal metadata/logs are emitted on success, cache hit, and failure.
- Tests for grounding cost context and project/trace attribution.
- Tests for persistence inserted/pruned/skipped aggregation.
- Existing project clustering and case-study suites remain green.

### Dashboard as code

- JSON syntax validation and repository dashboard validation.
- Query review for range bounding, units, zero/`N/A` semantics, and table limits.
- Panel ID and grid-position uniqueness checks.
- Existing repository test and type-check commands, with unrelated pre-existing failures documented rather than hidden.

### Live verification

- Query each RDS panel against known generated runs.
- Validate the PromQL route selector and aggregation against the live Prometheus datasource.
- Validate trace-filtered LogQL against a known trace ID.
- Validate exact Tempo lookup and waterfall completeness.
- Capture panel screenshots at desktop width in light/dark theme where practical and inspect clipping, legends, thresholds, empty states, and table links.

## Acceptance Criteria

The work is complete when:

1. The LLM Operations dashboard contains the dedicated collapsible project-generation row and all agreed operational views.
2. Selected-range run, success, latency, cache/refine, quality, and cost values come from durable RDS records and agree with known test runs.
3. Clustering, case-study, grounding, and system-tour charges are attributable by project, agent, model, and trace.
4. Every new project workflow emits one root trace with meaningful stage spans and trace-enriched structured logs.
5. Operators can select a workflow or invocation row and pivot to its exact Tempo waterfall and Loki logs without copying an identifier manually.
6. Model-tier violations are explicit and visually accessible.
7. Empty ranges, cache-only runs, pre-instrumentation history, and datasource errors render honestly.
8. Prometheus receives no new high-cardinality labels, and the dashboard remains bounded when its row is collapsed or expanded.
