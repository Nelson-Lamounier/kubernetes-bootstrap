# Project Generation Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-grade collapsible project-generation row to `LLM Operations - Cost, Latency & Quality` with cost, execution, quality, API, trace, and log correlation.

**Architecture:** The provisioned dashboard reads range-bounded workflow and charge truth from RDS, API RED signals from Prometheus, selected-trace events from Loki, and the selected waterfall from Tempo. The row is nested and collapsed by default; the existing `trace_id` variable drives exact same-dashboard pivots.

**Tech Stack:** Grafana schema 39, PostgreSQL, Prometheus/PromQL, Loki/LogQL, Tempo/TraceQL, JSON-as-code, Vitest, Grafana MCP, Helm/GitOps.

## Global Constraints

- Work in `/Users/nelsonlamounier/Desktop/portfolio/kubernetes-bootstrap` on `codex/project-generation-observability` based on `origin/main`.
- Start only after the telemetry plan is deployed and its live field shapes are verified.
- Modify provisioned JSON; do not overwrite the read-only live dashboard through Grafana MCP.
- Use RDS for selected-range runs, success, duration, cache/refine, effects, quality, and charges.
- Never use Pushgateway `increase(project_case_study_*)` or `increase(project_clustering_*)` for run totals.
- Keep Prometheus dimensions bounded to service, route template, status code, environment, and histogram bucket.
- Use the existing `trace_id` variable and exact Tempo/Loki pivots.
- Use theme-aware colors, textual statuses, correct units, bounded tables, and honest empty states.
- Preserve all unrelated untracked files and credential manifests.

---

## File Structure

- Modify `charts/monitoring/chart/dashboards/llm-operations.json`: add nested row 700 and panels 701-716.
- Create `charts/monitoring/tests/llm-operations-project-generation.test.ts`: dashboard-specific source/query contract.
- Reuse the existing generic dashboard validator unchanged.

### Task 1: Lock the dashboard contract with a failing test

**Files:**
- Create: `charts/monitoring/tests/llm-operations-project-generation.test.ts`
- Test: `charts/monitoring/chart/dashboards/llm-operations.json`

**Interfaces:**
- Requires row 700, panels 701-716, existing `trace_id`, and datasource UIDs `rds-postgres`, `prometheus`, `loki`, `tempo`.

- [ ] **Step 1: Write the failing contract test**

```typescript
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Panel = {
  id: number;
  type?: string;
  collapsed?: boolean;
  panels?: Panel[];
  targets?: Array<{ rawSql?: string; expr?: string; query?: string }>;
};
const dashboard = JSON.parse(readFileSync(resolve(
  __dirname, '../chart/dashboards/llm-operations.json',
), 'utf8')) as { panels: Panel[]; templating: { list: Array<{ name: string }> } };
const row = dashboard.panels.find((panel) => panel.id === 700);
const nested = row?.panels ?? [];
const byId = (id: number): Panel => {
  const panel = nested.find((candidate) => candidate.id === id);
  if (!panel) throw new Error(`missing project-generation panel ${id}`);
  return panel;
};

describe('LLM Operations project-generation row', () => {
  it('is nested and collapsed by default', () => {
    expect(row).toMatchObject({ type: 'row', collapsed: true });
    expect(nested.map((panel) => panel.id)).toEqual([
      701, 702, 703, 704, 705, 706, 707, 708,
      709, 710, 711, 712, 716, 713, 714, 715,
    ]);
  });
  it('uses range-bounded RDS truth', () => {
    for (const id of [701, 702, 703, 704, 705, 706, 707, 708, 709, 710, 711, 713]) {
      const sql = byId(id).targets?.map((target) => target.rawSql ?? '').join('\n') ?? '';
      expect(sql).toContain('$__timeFilter');
      expect(sql).not.toMatch(/INTERVAL\s+'24 hours'/i);
      expect(sql).not.toMatch(/increase\s*\(/i);
    }
  });
  it('keeps PromQL low-cardinality and pivots exact', () => {
    const promql = [...(byId(712).targets ?? []), ...(byId(716).targets ?? [])]
      .map((target) => target.expr ?? '').join('\n');
    expect(promql).toContain('route=~"/api/admin/projects.*"');
    expect(promql).not.toMatch(/user_id|project_id|trace_id/);
    expect(byId(714).targets?.[0]?.query).toContain('${trace_id}');
    expect(byId(715).targets?.[0]?.expr).toContain('trace_id=${trace_id:json}');
  });
  it('retains trace_id', () => {
    expect(dashboard.templating.list.some((variable) => variable.name === 'trace_id')).toBe(true);
  });
});
```

- [ ] **Step 2: Verify red and commit** `[git-commit skill]`

Run `yarn vitest run charts/monitoring/tests/llm-operations-project-generation.test.ts`.

Expected: FAIL with missing panel 701. Commit the test as `test(monitoring): define project dashboard`.

### Task 2: Add executive health, spend, and model governance

**Files:**
- Modify: `charts/monitoring/chart/dashboards/llm-operations.json`

**Interfaces:**
- Produces row 700 and panels 701-707.
- Consumes `pipeline_runs` types `clustering`/`case_study` and project charge pipelines.

- [ ] **Step 1: Append the collapsed nested row after panel 604**

```json
{
  "id": 700,
  "type": "row",
  "title": "Project generation — cost, execution, quality & traces",
  "description": "RDS workflow truth with Prometheus API health and exact Tempo/Loki pivots. Collapsed by default to bound query load.",
  "collapsed": true,
  "gridPos": { "h": 1, "w": 24, "x": 0, "y": 97 },
  "panels": []
}
```

Nested panels use monotonic `gridPos.y`, a 24-column grid, and unique IDs.

- [ ] **Step 2: Add stat panels 701-704**

Use four six-column stats with units `currencyUSD`, `short`, `percent`, and `s`:

```sql
-- 701 Spend
SELECT COALESCE(SUM(total_cost_cents), 0) / 100.0 AS usd
FROM prompt_invocations
WHERE $__timeFilter(invoked_at)
  AND (pipeline IN ('project-clustering', 'project-case-study')
    OR (pipeline = 'grounding-verify' AND project_id IS NOT NULL))
  AND (${user_id:sqlstring} = '' OR user_id::text = ${user_id:sqlstring});

-- 702 Runs
SELECT COUNT(*)::bigint AS runs
FROM pipeline_runs
WHERE $__timeFilter(created_at)
  AND pipeline_type IN ('clustering', 'case_study')
  AND (${user_id:sqlstring} = '' OR user_id::text = ${user_id:sqlstring});

-- 703 Success; NULL renders N/A when no terminal run exists
SELECT ROUND(100.0 *
  COUNT(*) FILTER (WHERE status = 'complete' AND metadata->>'skipped' IS NULL) /
  NULLIF(COUNT(*) FILTER (
    WHERE status IN ('complete', 'failed') AND metadata->>'skipped' IS NULL
  ), 0), 2) AS success_pct
FROM pipeline_runs
WHERE $__timeFilter(created_at)
  AND pipeline_type IN ('clustering', 'case_study')
  AND (${user_id:sqlstring} = '' OR user_id::text = ${user_id:sqlstring});

-- 704 p95 terminal duration
SELECT PERCENTILE_CONT(0.95) WITHIN GROUP (
  ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at))
) AS p95_seconds
FROM pipeline_runs
WHERE $__timeFilter(created_at)
  AND pipeline_type IN ('clustering', 'case_study')
  AND status IN ('complete', 'failed')
  AND metadata->>'skipped' IS NULL
  AND (${user_id:sqlstring} = '' OR user_id::text = ${user_id:sqlstring});
```

Success thresholds: red below 95, amber at 95, green at 99. Do not invent a p95 SLO.

- [ ] **Step 3: Add cost trend 705 and charge ledger 706**

```sql
-- 705 time series
SELECT $__timeGroupAlias(invoked_at, '1h'),
  CASE WHEN pipeline = 'grounding-verify' THEN 'grounding / ' || model_id
       ELSE agent || ' / ' || model_id END AS metric,
  SUM(total_cost_cents) / 100.0 AS usd
FROM prompt_invocations
WHERE $__timeFilter(invoked_at)
  AND (pipeline IN ('project-clustering', 'project-case-study')
    OR (pipeline = 'grounding-verify' AND project_id IS NOT NULL))
  AND (${user_id:sqlstring} = '' OR user_id::text = ${user_id:sqlstring})
GROUP BY 1, metric ORDER BY 1;

-- 706 table
SELECT pi.invoked_at AS time,
  COALESCE(p.name, pi.project_id::text, 'clustering') AS project,
  pi.pipeline, pi.agent, pi.model_id,
  pi.user_message_tokens + pi.system_prompt_tokens AS input_tokens,
  pi.output_tokens, pi.latency_ms,
  pi.total_cost_cents / 100.0 AS usd, pi.trace_id
FROM prompt_invocations pi
LEFT JOIN projects p ON p.id = pi.project_id
WHERE $__timeFilter(pi.invoked_at)
  AND (pi.pipeline IN ('project-clustering', 'project-case-study')
    OR (pi.pipeline = 'grounding-verify' AND pi.project_id IS NOT NULL))
  AND (${user_id:sqlstring} = '' OR pi.user_id::text = ${user_id:sqlstring})
ORDER BY pi.invoked_at DESC LIMIT 200;
```

Set correct token, latency, and USD units; sort newest first.

- [ ] **Step 4: Add model-tier compliance panel 707**

```sql
WITH governed AS (
  SELECT CASE
      WHEN pipeline = 'project-clustering' THEN 'clustering'
      WHEN pipeline = 'grounding-verify' THEN 'grounding'
      WHEN agent = 'project-system-tour' THEN 'system tour'
      ELSE 'case study' END AS stage,
    model_id,
    CASE WHEN pipeline IN ('project-clustering', 'grounding-verify')
      THEN model_id LIKE '%haiku-4-5%'
      ELSE model_id LIKE '%sonnet-4-6%' END AS compliant
  FROM prompt_invocations
  WHERE $__timeFilter(invoked_at)
    AND (pipeline IN ('project-clustering', 'project-case-study')
      OR (pipeline = 'grounding-verify' AND project_id IS NOT NULL))
    AND (${user_id:sqlstring} = '' OR user_id::text = ${user_id:sqlstring})
)
SELECT stage,
  CASE WHEN stage IN ('clustering', 'grounding') THEN 'Haiku 4.5' ELSE 'Sonnet 4.6' END AS expected,
  model_id AS observed, COUNT(*) AS invocations,
  ROUND(100.0 * COUNT(*) FILTER (WHERE compliant) / NULLIF(COUNT(*), 0), 2) AS compliance_pct,
  CASE WHEN BOOL_AND(compliant) THEN 'COMPLIANT' ELSE 'VIOLATION' END AS status
FROM governed GROUP BY stage, model_id ORDER BY stage, model_id;
```

Keep textual status, map compliant green and violation red, and apply 95/99 percentage thresholds.

- [ ] **Step 5: Validate and commit** `[git-commit skill]`

Run `jq empty` and the focused test. It should remain red only for later panels. Commit `feat(monitoring): add project cost panels`.

### Task 3: Add execution, cache/refine, persistence, and grounding

**Files:**
- Modify: `charts/monitoring/chart/dashboards/llm-operations.json`

**Interfaces:**
- Produces panels 708-711 from deployed telemetry metadata.

- [ ] **Step 1: Add workflow table 708**

```sql
WITH trace_spend AS (
  SELECT trace_id, SUM(total_cost_cents) / 100.0 AS usd
  FROM prompt_invocations
  WHERE $__timeFilter(invoked_at) AND trace_id IS NOT NULL
  GROUP BY trace_id
)
SELECT pr.created_at AS started, pr.id AS run_id,
  pr.pipeline_type AS workflow,
  COALESCE(p.name, pr.reference_id, 'unattributed') AS project,
  pr.status, COALESCE(pr.metadata->>'generationMode', 'n/a') AS mode,
  CASE WHEN pr.metadata->>'cacheHit' = 'true' THEN 'hit'
       WHEN pr.metadata ? 'cacheHit' THEN 'miss' ELSE 'n/a' END AS cache,
  CASE WHEN pr.status IN ('complete', 'failed')
    THEN EXTRACT(EPOCH FROM (pr.updated_at - pr.created_at))
    ELSE EXTRACT(EPOCH FROM (NOW() - pr.created_at)) END AS duration_s,
  COALESCE(ts.usd, NULLIF(pr.metadata->>'costUsd', '')::numeric, 0) AS usd,
  pr.metadata->>'traceId' AS trace_id, pr.error_message
FROM pipeline_runs pr
LEFT JOIN projects p ON p.id::text = pr.reference_id
LEFT JOIN trace_spend ts ON ts.trace_id = pr.metadata->>'traceId'
WHERE $__timeFilter(pr.created_at)
  AND pr.pipeline_type IN ('clustering', 'case_study')
  AND (${user_id:sqlstring} = '' OR pr.user_id::text = ${user_id:sqlstring})
ORDER BY pr.created_at DESC LIMIT 200;
```

Map queued/running/complete/failed and cache hit/miss textually. Null trace IDs map to `missing instrumentation`.

- [ ] **Step 2: Add cache/mode bar gauge 709**

```sql
WITH runs AS (
  SELECT pipeline_type, metadata FROM pipeline_runs
  WHERE $__timeFilter(created_at)
    AND pipeline_type IN ('clustering', 'case_study')
    AND (${user_id:sqlstring} = '' OR user_id::text = ${user_id:sqlstring})
), buckets AS (
  SELECT CASE WHEN metadata->>'cacheHit' = 'true' THEN 'cache: hit' ELSE 'cache: miss' END AS bucket
  FROM runs WHERE metadata ? 'cacheHit'
  UNION ALL
  SELECT 'mode: ' || COALESCE(metadata->>'generationMode', 'full')
  FROM runs WHERE pipeline_type = 'case_study'
)
SELECT bucket, COUNT(*) AS runs FROM buckets GROUP BY bucket ORDER BY bucket;
```

Use labels plus colors; cache miss is neutral rather than unhealthy.

- [ ] **Step 3: Add context/effects table 710**

```sql
SELECT created_at AS time, id AS run_id, pipeline_type AS workflow, reference_id,
  COALESCE((metadata->>'commitsLoaded')::int, 0) AS commits,
  COALESCE((metadata->>'kbChunksLoaded')::int, 0) AS kb_chunks,
  COALESCE((metadata->>'digestsLoaded')::int, 0) AS repo_digests,
  COALESCE((metadata->>'decisionsInserted')::int, 0) AS decisions_in,
  COALESCE((metadata->>'decisionsPruned')::int, 0) AS decisions_out,
  COALESCE((metadata->>'highlightsInserted')::int, 0) AS highlights_in,
  COALESCE((metadata->>'highlightsPruned')::int, 0) AS highlights_out,
  COALESCE((metadata->>'challengesInserted')::int, 0) AS challenges_in,
  COALESCE((metadata->>'challengesPruned')::int, 0) AS challenges_out,
  COALESCE(metadata->>'skippedSections', '[]') AS sticky_skipped
FROM pipeline_runs
WHERE $__timeFilter(created_at)
  AND pipeline_type IN ('clustering', 'case_study')
  AND (${user_id:sqlstring} = '' OR user_id::text = ${user_id:sqlstring})
ORDER BY created_at DESC LIMIT 200;
```

- [ ] **Step 4: Add grounding table 711**

```sql
WITH grounding_spend AS (
  SELECT trace_id, SUM(total_cost_cents) / 100.0 AS usd
  FROM prompt_invocations
  WHERE $__timeFilter(invoked_at) AND pipeline = 'grounding-verify'
    AND project_id IS NOT NULL AND trace_id IS NOT NULL
  GROUP BY trace_id
)
SELECT pr.created_at AS time, COALESCE(p.name, pr.reference_id) AS project,
  COALESCE((pr.metadata->>'groundingChecked')::int, 0) AS checked,
  COALESCE((pr.metadata->>'groundingGrounded')::int, 0) AS grounded,
  COALESCE((pr.metadata->>'groundingFlagged')::int, 0) AS flagged,
  COALESCE((pr.metadata->>'groundingNotVerified')::int, 0) AS not_verified,
  COALESCE(gs.usd, NULLIF(pr.metadata->>'groundingCostUsd', '')::numeric, 0) AS grounding_usd,
  pr.metadata->>'traceId' AS trace_id
FROM pipeline_runs pr
LEFT JOIN projects p ON p.id::text = pr.reference_id
LEFT JOIN grounding_spend gs ON gs.trace_id = pr.metadata->>'traceId'
WHERE $__timeFilter(pr.created_at) AND pr.pipeline_type = 'case_study'
  AND (${user_id:sqlstring} = '' OR pr.user_id::text = ${user_id:sqlstring})
ORDER BY pr.created_at DESC LIMIT 200;
```

Color flagged red only above zero; keep value text. Use USD for spend.

- [ ] **Step 5: Validate and commit** `[git-commit skill]`

Run `jq empty` and the focused test. Commit `feat(monitoring): add project quality panels`.

### Task 4: Add API RED and exact RDS → Tempo → Loki pivots

**Files:**
- Modify: `charts/monitoring/chart/dashboards/llm-operations.json`

**Interfaces:**
- Produces panels 712, 716, 713, 714, 715.

- [ ] **Step 1: Add request/error panel 712**

```promql
sum by (route, status_code) (
  rate(http_requests_total{
    env="$env", service="admin-api", route=~"/api/admin/projects.*"
  }[5m])
)
```

Unit `reqps`, legend `{{route}} · {{status_code}}`, 5xx red and 4xx amber with status text retained.

- [ ] **Step 2: Add separate p95 latency panel 716**

```promql
histogram_quantile(0.95,
  sum by (le, route) (
    rate(http_request_duration_seconds_bucket{
      env="$env", service="admin-api", route=~"/api/admin/projects.*"
    }[5m])
  )
)
```

Unit `s`, legend `p95 · {{route}}`, min 0. The separate panel avoids mixed units.

- [ ] **Step 3: Add trace index 713**

```sql
SELECT pr.created_at AS started, pr.id AS run_id,
  pr.pipeline_type AS workflow,
  COALESCE(p.name, pr.reference_id, 'unattributed') AS project,
  pr.status, pi.agent, pi.model_id, pi.latency_ms,
  pi.total_cost_cents / 100.0 AS usd,
  pr.metadata->>'traceId' AS trace_id
FROM pipeline_runs pr
LEFT JOIN projects p ON p.id::text = pr.reference_id
LEFT JOIN prompt_invocations pi ON pi.trace_id = pr.metadata->>'traceId'
WHERE $__timeFilter(pr.created_at)
  AND pr.pipeline_type IN ('clustering', 'case_study')
  AND (${user_id:sqlstring} = '' OR pr.user_id::text = ${user_id:sqlstring})
ORDER BY pr.created_at DESC, pi.total_cost_cents DESC NULLS LAST
LIMIT 300;
```

Add this link to `trace_id` in panels 706, 708, 711, 713:

```json
{
  "title": "Select this trace",
  "url": "/grafana/d/llm-operations/llm-operations-cost-latency-and-quality?from=${__from}&to=${__to}&var-env=$env&var-trace_id=${__value.raw}",
  "targetBlank": false
}
```

- [ ] **Step 4: Add selected trace 714 and logs 715**

Tempo target uses the deployed dashboard's direct-ID pattern:

```json
{ "refId": "A", "queryType": "traceql", "query": "${trace_id}" }
```

LogQL remains exact without indexing the trace as a Loki label:

```logql
{namespace="job-strategist", app=~"project-case-study|project-clustering"}
| json
| __error__=""
| trace_id=${trace_id:json}
```

Tempo/log descriptions instruct selection from panel 713. Loki uses max 200, newest first, wrap enabled, no deduplication.

- [ ] **Step 5: Verify green and commit** `[git-commit skill]`

Run the focused test. Expected: PASS. Commit `feat(monitoring): add project trace pivots`.

### Task 5: Run repository validation

**Files:**
- Correct only defects in the new dashboard/test.

- [ ] **Step 1: Run syntax and dashboard validators**

```bash
jq empty charts/monitoring/chart/dashboards/llm-operations.json
yarn vitest run charts/monitoring/tests/llm-operations-project-generation.test.ts charts/monitoring/tests/validate-dashboards.test.ts
yarn tsx charts/monitoring/scripts/validate-dashboards.ts
```

Expected: PASS, including nested datasource checks.

- [ ] **Step 2: Run full repository gates**

Run `yarn test` and `yarn typecheck`.

Expected: existing 148 tests plus new tests PASS. The known base-branch type-check error is `scripts/test-ami-build.ts` missing the `js-yaml` declaration; verify it on `origin/main`, record it, and do not add an unrelated dependency change.

- [ ] **Step 3: Inspect safety and layout**

```bash
jq '[.panels[], (.panels[]?.panels[]?)] | map(select(.id >= 700)) | map({id,title,type,gridPos})' charts/monitoring/chart/dashboards/llm-operations.json
rg -n "INTERVAL '24 hours'|increase\(project_(case_study|clustering)|user_id=|project_id=|trace_id=" charts/monitoring/chart/dashboards/llm-operations.json
git diff --check
git status --short
```

Expected: unique IDs, valid 24-column layout, no project Pushgateway increase query, and no high-cardinality PromQL labels.

- [ ] **Step 4: Commit validation corrections only when required** `[git-commit skill]`

If tracked corrections were needed, commit `test(monitoring): validate project dashboard`; otherwise retain Task 4 as the tip.

### Task 6: Deploy through GitOps and verify live with Grafana MCP

**Files:**
- No source changes expected unless live checks expose a reproducible defect.

- [ ] **Step 1: Open the dashboard PR to `main`**

Link the merged telemetry PR and include local validation, known baseline type-check failure, and four representative trace IDs.

- [ ] **Step 2: Validate provisioning when branch preview is available**

Use Grafana MCP `validate_provisioning_file` for `charts/monitoring/chart/dashboards/llm-operations.json`. If no provisioning repository exists, record that and rely on repository validation.

- [ ] **Step 3: Merge and verify ArgoCD**

Wait for monitoring to be `Synced` and `Healthy`; confirm row 700 and the new panel count through Grafana MCP `get_dashboard_summary`.

- [ ] **Step 4: Verify RDS panels**

Compare 701-711 and 713 with known runs. Cache hits remain visible with zero generation charge; no-run rate/p95 shows N/A rather than a healthy zero.

- [ ] **Step 5: Verify PromQL**

Use Grafana MCP metric/label discovery before querying 712 and 716. Confirm normalized project routes, status splits, and `sum(rate(...)) by (le, route)` for p95.

- [ ] **Step 6: Verify exact correlation**

Click a row in 713. Confirm time range preservation, exact Tempo waterfall in 714, exact trace logs in 715, cache-hit root traces without model calls, and explicit missing-instrumentation history.

- [ ] **Step 7: Render and inspect visuals**

Use Grafana MCP `get_panel_image` for the expanded row at desktop width. Inspect light/dark theme where available for clipping, legends, units, dense tables, empty states, and color-only meaning. Fix source JSON and repeat checks if needed.

- [ ] **Step 8: Reconcile cost sources**

Compare selected-range RDS charges with Bedrock application metrics and 30-day Cost Explorer lines. Record expected billing/time-window differences; investigate unexplained gaps as instrumentation defects.
