# Project Generation Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make project clustering and case-study workflows emit durable cost attribution, root/stage traces, trace-correlated logs, grounding quality, and persistence-effect metadata.

**Architecture:** `ai-applications` remains the telemetry producer. A shared OpenTelemetry helper creates one workflow root and bounded child stages; its trace ID flows into `prompt_invocations.trace_id`, `pipeline_runs.metadata.traceId`, and structured terminal logs. PostgreSQL supplies durable time-window truth while Prometheus keeps bounded service/outcome labels.

**Tech Stack:** TypeScript 5.8, Jest 29, OpenTelemetry API 1.9, Pino, PostgreSQL, Bedrock Converse, prom-client, Yarn 4 workspaces.

## Global Constraints

- Work in `/Users/nelsonlamounier/Desktop/portfolio/ai-applications` on a feature branch based on `develop`, as required by that repository's branch workflow.
- Never add user, project, repository, run, or trace identifiers as Prometheus labels.
- Never log prompts, generated prose, source content, credentials, or user PII.
- Keep grounding in `flag` mode; observability must not rewrite product output.
- Keep case-study/system-tour generation on Sonnet 4.6 and clustering/grounding on Haiku 4.5.
- Preserve content-hash idempotency, pruning, user-confirmed rows, and sticky overrides.
- Follow red-green-refactor and make focused conventional commits.
- Deploy this plan before the dependent dashboard plan.

---

## File Structure

- Create `applications/shared/src/observability/workflow-trace.ts` and its test for root/stage span lifecycle and active trace extraction.
- Modify shared observability barrels, `agent-runner.ts`, and RDS cost recording to persist active trace IDs.
- Create migration `095_prompt_invocations_trace_id_index.sql` for exact trace joins.
- Modify the grounding verifier and case-study orchestrator for project/trace cost attribution and quality aggregates.
- Modify case-study persistence to report both inserted and pruned rows.
- Modify clustering/case-study orchestrators to expose bounded stage traces and accurate status hooks.
- Modify both project Job entrypoints to create root traces, durable metadata, terminal events, and flush telemetry.

### Task 1: Persist the active workflow trace on every model charge

**Files:**
- Create: `applications/shared/src/observability/workflow-trace.ts`
- Create: `applications/shared/src/observability/workflow-trace.test.ts`
- Modify: `applications/shared/src/observability/index.ts`
- Modify: `applications/shared/src/index.ts`
- Modify: `applications/shared/src/agent-runner.ts:468-499`
- Modify: `applications/shared/src/agent-runner.test.ts:725-777`
- Modify: `applications/shared/src/rds/bedrock-cost.ts:39-215`
- Modify: `applications/shared/src/rds/bedrock-cost.test.ts:44-99`
- Create: `applications/platform-rds-bootstrap/migrations/095_prompt_invocations_trace_id_index.sql`

**Interfaces:**
- Produces `currentTraceContext(): { traceId?: string; spanId?: string }`.
- Produces `withWorkflowTrace<T>(options, work): Promise<{ result: T; traceId: string }>`.
- Produces `WorkflowTrace.stage<T>(name, attributes, work): Promise<T>`.
- Extends `CostRecord` and `recordInvocationToRds` context with `traceId?: string`.

- [ ] **Step 1: Write failing trace and persistence tests**

```typescript
it('uses the active OTel trace for the invocation log', async () => {
  currentTraceContextMock.mockReturnValue({ traceId: '0123456789abcdef0123456789abcdef' });
  const sink = jest.fn(async () => {});
  await runAgent({
    config: buildConfig(VALID_MAX_TOKENS, DISABLED_THINKING_BUDGET),
    userMessage: TEST_USER_MESSAGE,
    parseResponse: (text: string) => text,
    pipelineContext: { ...buildPipelineContext(), userId: 'user-42', onInvocationComplete: sink },
  });
  expect(sink.mock.calls[0]![0].traceId).toBe('0123456789abcdef0123456789abcdef');
});

it('writes trace_id on the prompt invocation', async () => {
  const { pool, queries } = fakePool();
  await recordInvocationToRds(pool, 'project-case-study', {
    projectId: '00000000-0000-4000-8000-000000000001',
    traceId: '0123456789abcdef0123456789abcdef',
  })({ ...baseLog, traceId: undefined });
  const insert = queries.find((query) => /INSERT INTO prompt_invocations/.test(query.sql))!;
  expect(insert.sql).toMatch(/trace_id/);
  expect(insert.params).toContain('0123456789abcdef0123456789abcdef');
});
```

- [ ] **Step 2: Run the focused tests and verify red**

Run `yarn workspace @bedrock/shared test workflow-trace.test.ts agent-runner.test.ts bedrock-cost.test.ts --runInBand`.

Expected: FAIL because the workflow helper and trace INSERT parameter do not exist.

- [ ] **Step 3: Implement the shared trace helper**

```typescript
import {
  context, trace, SpanStatusCode,
  type Attributes, type Context, type Span,
} from '@opentelemetry/api';
import { xrayTraceContextFromEnv } from './xray-trace-id.js';

export interface WorkflowTrace {
  readonly traceId: string;
  readonly rootSpan: Span;
  setAttributes(attributes: Attributes): void;
  stage<T>(name: string, attributes: Attributes, work: () => Promise<T>): Promise<T>;
}

export function currentTraceContext(): { traceId?: string; spanId?: string } {
  const active = trace.getSpan(context.active());
  if (active) {
    const ids = active.spanContext();
    if (ids.traceId) return { traceId: ids.traceId, spanId: ids.spanId };
  }
  const xray = xrayTraceContextFromEnv();
  return { traceId: xray.trace_id, spanId: xray.span_id };
}

export async function withWorkflowTrace<T>(
  options: { name: string; parentContext: Context; attributes: Attributes },
  work: (workflow: WorkflowTrace) => Promise<T>,
): Promise<{ result: T; traceId: string }> {
  const tracer = trace.getTracer('@bedrock/shared-project-workflows');
  const rootSpan = tracer.startSpan(options.name, { attributes: options.attributes }, options.parentContext);
  const traceId = rootSpan.spanContext().traceId;
  const activeContext = trace.setSpan(options.parentContext, rootSpan);
  const workflow: WorkflowTrace = {
    traceId,
    rootSpan,
    setAttributes: (attributes) => rootSpan.setAttributes(attributes),
    stage: async (name, attributes, stageWork) => context.with(activeContext, async () =>
      tracer.startActiveSpan(name, { attributes }, async (span) => {
        try { return await stageWork(); }
        catch (error) {
          const exception = error instanceof Error ? error : new Error(String(error));
          span.recordException(exception);
          span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
          throw error;
        } finally { span.end(); }
      })),
  };
  try {
    const result = await context.with(activeContext, () => work(workflow));
    rootSpan.setStatus({ code: SpanStatusCode.OK });
    return { result, traceId };
  } catch (error) {
    const exception = error instanceof Error ? error : new Error(String(error));
    rootSpan.recordException(exception);
    rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
    throw error;
  } finally { rootSpan.end(); }
}
```

Test an active OTel span, X-Ray fallback, child/root shared trace ID, and child/root error status. Export the helper from both shared barrels. Replace the runner's Lambda-only trace assignment with `currentTraceContext().traceId`.

- [ ] **Step 4: Extend cost persistence and add the lookup index**

Add `traceId?: string` to `CostRecord` and the adapter context. Add `trace_id` to the INSERT after `sync_kind`, bind `record.traceId ?? null`, and pass `log.traceId ?? context?.traceId`.

```sql
CREATE INDEX IF NOT EXISTS idx_prompt_invocations_trace_id
  ON prompt_invocations (trace_id, invoked_at DESC)
  INCLUDE (pipeline, agent, model_id, project_id, total_cost_cents, latency_ms)
  WHERE trace_id IS NOT NULL;
```

- [ ] **Step 5: Verify and commit** `[git-commit skill]`

Run:

```bash
yarn workspace @bedrock/shared test workflow-trace.test.ts agent-runner.test.ts bedrock-cost.test.ts --runInBand
yarn workspace @bedrock/shared typecheck
yarn workspace @bedrock/platform-rds-bootstrap typecheck
```

Expected: PASS. Stage the exact files above and commit `feat(observability): persist workflow traces`.

### Task 2: Attribute grounding cost and expose quality aggregates

**Files:**
- Modify: `applications/shared/src/grounding/bedrock-grounding-verifier.ts`
- Modify: `applications/shared/src/grounding/bedrock-grounding-verifier.test.ts`
- Modify: `applications/shared/src/projects/case-study-orchestrator.ts`
- Modify: `applications/shared/src/projects/case-study-orchestrator.test.ts`

**Interfaces:**
- Extends `GroundingCostContext` with `projectId?: string` and `traceId?: string`.
- Produces `GroundingUsage { calls, inputTokens, outputTokens, costUsd }`.
- Produces `GroundingSummary { checked, grounded, flagged, notVerified }` on `RunCaseStudyOutput`.

- [ ] **Step 1: Write failing verifier and summary tests**

```typescript
expect(recordCostMock).toHaveBeenCalledWith(pool, expect.objectContaining({
  pipeline: 'grounding-verify',
  agent: 'grounding-verifier',
  projectId: '00000000-0000-4000-8000-000000000001',
  traceId: '0123456789abcdef0123456789abcdef',
}));
expect(summarizeGrounding(caseStudyWithVerdicts(
  'GROUNDED', 'NOT_GROUNDED', 'NOT_VERIFIED',
))).toEqual({ checked: 2, grounded: 1, flagged: 1, notVerified: 1 });
```

- [ ] **Step 2: Verify red**

Run `yarn workspace @bedrock/shared test bedrock-grounding-verifier.test.ts case-study-orchestrator.test.ts --runInBand`.

Expected: FAIL because default cost context, usage callback, and summary are absent.

- [ ] **Step 3: Implement cost and quality contracts**

```typescript
export interface GroundingCostContext {
  pool: Pool;
  userId: string;
  projectId?: string;
  traceId?: string;
}
export interface GroundingUsage {
  calls: 1;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}
```

Add `costContext` and `onUsage` to verifier config. Resolve `verify` cost context as its explicit argument or configured default. Use `computeCostCents` for the callback, and pass `agent`, `projectId`, and `traceId` into `recordBedrockCost`.

```typescript
export function summarizeGrounding(caseStudy: CaseStudy): GroundingSummary {
  const signals = [
    ...caseStudy.decisions.map((row) => row.sourceSignals),
    ...caseStudy.highlights.map((row) => row.sourceSignals),
    ...caseStudy.challenges.map((row) => row.sourceSignals),
  ];
  return {
    checked: signals.filter((s) => s.grounding !== 'NOT_VERIFIED').length,
    grounded: signals.filter((s) => s.grounding === 'GROUNDED').length,
    flagged: signals.filter((s) => s.grounding === 'NOT_GROUNDED').length,
    notVerified: signals.filter((s) => s.grounding === 'NOT_VERIFIED').length,
  };
}
```

Return `grounding` for generated and cached case studies.

- [ ] **Step 4: Verify and commit** `[git-commit skill]`

Run the focused tests and `yarn workspace @bedrock/shared typecheck`. Expected: PASS. Commit `feat(projects): attribute grounding quality` with only the four task files.

### Task 3: Report inserted and pruned persistence effects

**Files:**
- Modify: `applications/shared/src/projects/case-study-persistence.ts:81-452`
- Modify: `applications/shared/src/projects/case-study-persistence.test.ts:117-178`

**Interfaces:**
- Replaces `insertGenerated(...): Promise<number>` with `Promise<{ inserted: number; pruned: number }>`.
- Extends `PersistCaseStudySummary` with `stackItemsPruned`, `decisionsPruned`, `highlightsPruned`, and `challengesPruned`.

- [ ] **Step 1: Write failing row-count tests**

Make generated-row DELETEs return `rowCount: 2`, assert all four prune fields equal 2, and assert a sticky section remains zero.

- [ ] **Step 2: Verify red**

Run `yarn workspace @bedrock/shared test case-study-persistence.test.ts --runInBand`.

Expected: FAIL because prune counts are not returned.

- [ ] **Step 3: Return DELETE counts without changing reconciliation**

```typescript
const deleted = currentHashes.length > 0
  ? await client.query(
      `DELETE FROM ${table}
        WHERE project_id = $1
          AND content_hash <> ALL($2::text[])${preserveClause}`,
      [input.projectId, currentHashes],
    )
  : await client.query(
      `DELETE FROM ${table}
        WHERE project_id = $1
          AND content_hash IS NOT NULL${preserveClause}`,
      [input.projectId],
    );
return { inserted, pruned: deleted.rowCount ?? 0 };
```

Destructure each section result and initialize sticky-section inserted/pruned values to zero.

- [ ] **Step 4: Verify and commit** `[git-commit skill]`

Run the persistence test and shared type check. Expected: PASS. Commit `feat(projects): report pruned case-study rows`.

### Task 4: Trace case-study generation from root to terminal event

**Files:**
- Modify: `applications/shared/src/projects/case-study-orchestrator.ts`
- Modify: `applications/shared/src/projects/case-study-orchestrator.test.ts`
- Modify: `applications/job-strategist/src/run-case-study.ts`

**Interfaces:**
- Adds `RunCaseStudyInput.workflow?: WorkflowTrace`.
- Adds `onStage?: (stage: 'fetching_context' | 'generating' | 'grounding' | 'persisting') => Promise<void>`.
- Persists trace, grounding, prune, cache/refine, context, token, cost, and system-tour metadata.

- [ ] **Step 1: Write failing stage-order tests**

For a miss, expect `load_context`, `cache_lookup`, `generate`, `ground`, `persist`, `cache_write` under the `project.case_study.*` prefix and statuses `fetching_context`, `generating`, `grounding`, `persisting`. For a hit, expect no generate/ground stage and still expect persist.

- [ ] **Step 2: Verify red**

Run `yarn workspace @bedrock/shared test case-study-orchestrator.test.ts --runInBand`.

Expected: FAIL because workflow/stage hooks are absent.

- [ ] **Step 3: Wrap bounded stages and update status at the real stage**

```typescript
async function runStage<T>(workflow: WorkflowTrace | undefined, name: string, work: () => Promise<T>): Promise<T> {
  return workflow ? workflow.stage(name, {}, work) : work();
}
```

Wrap context load/refine, cache lookup, model generation, grounding, persistence, and cache write. Invoke `onStage` immediately before the associated work. Keep cache bypass for refine and all current product behavior unchanged.

- [ ] **Step 4: Execute the Job inside the root trace**

```typescript
const traced = await withWorkflowTrace({
  name: 'project.case_study.run',
  parentContext: obs.parentContext,
  attributes: {
    'pipeline.run_id': env.pipelineRunId,
    'project.id': env.projectId,
    'workflow.type': 'case_study',
  },
}, async (workflow) => {
  traceId = workflow.traceId;
  await updatePipelineRunMetadata(pool, env.pipelineRunId, { traceId });
  ctx.onInvocationComplete = recordInvocationToRds(pool, 'project-case-study', {
    projectId: env.projectId,
    traceId,
  });
  return runCaseStudyOrchestration(pool, {
    projectId: env.projectId, pipelineRunId: env.pipelineRunId,
    model: env.model, kbTag, agent: bedrockCaseStudyAgent,
    verifier, cache, ctx, refine, workflow,
    onStage: (stage) => updatePipelineRun(pool, env.pipelineRunId, stage),
  });
});
```

Construct the grounding verifier inside the callback with pool/user/project/trace context and usage accumulator. Wrap system tour as `project.case_study.system_tour`. Add grounding counts/cost, four prune counts, `generationMode`, and total cost to metadata.

- [ ] **Step 5: Emit terminal events and flush**

Emit `project.case_study.complete` or `.failed` with explicit `trace_id`, run/project IDs, outcome, duration, cache/mode, counts, tokens, and cost. Errors include sanitized class/message. Call `await obs.shutdown()` after the metrics push and before exit.

- [ ] **Step 6: Verify and commit** `[git-commit skill]`

Run case-study orchestrator/persistence/grounding tests plus shared and job-strategist type checks. Expected: PASS. Commit `feat(projects): trace case-study workflows`.

### Task 5: Trace clustering from root to terminal event

**Files:**
- Modify: `applications/shared/src/projects/clustering-orchestrator.ts`
- Modify: `applications/shared/src/projects/clustering-orchestrator.test.ts`
- Modify: `applications/job-strategist/src/run-clustering.ts`

**Interfaces:**
- Adds `RunClusteringInput.workflow?: WorkflowTrace`.
- Adds `onStage?: (stage: 'signals_extracting' | 'analysing' | 'persisting') => Promise<void>`.

- [ ] **Step 1: Write failing stage-order tests**

For a two-repo miss, expect `project.clustering.load_signals`, `cache_lookup`, `generate`, `ground_components`, `persist`, and `cache_write`; expect statuses `signals_extracting`, `analysing`, `persisting`. A hit omits generate but persists.

- [ ] **Step 2: Verify red**

Run `yarn workspace @bedrock/shared test clustering-orchestrator.test.ts --runInBand`.

Expected: FAIL because workflow/stage hooks are absent.

- [ ] **Step 3: Implement bounded stages and root correlation**

Use the Task 4 stage adapter without changing the fewer-than-two-repositories short circuit. Wrap the Job with root `project.clustering.run`, attributes `pipeline.run_id` and `workflow.type`, persist `traceId` before work, and pass it to `recordInvocationToRds`.

- [ ] **Step 4: Emit complete metadata/logs and flush**

Keep all current clustering counts and add trace ID, cache result, model, tokens, cost, duration, and terminal outcome to `project.clustering.complete` or `.failed`. Sanitize errors and call `obs.shutdown()`.

- [ ] **Step 5: Verify and commit** `[git-commit skill]`

Run clustering/workflow-trace tests and shared/job-strategist type checks. Expected: PASS. Commit `feat(projects): trace clustering workflows`.

### Task 6: Run the complete application quality gate

**Files:**
- Verify only; correct failures only in files changed by Tasks 1-5.

- [ ] **Step 1: Run all gates**

```bash
yarn lint
yarn test
yarn typecheck
yarn build
```

Expected: every command exits 0. Verify unrelated failures on the base branch and document them without modifying unrelated code.

- [ ] **Step 2: Inspect the branch**

Run `git diff --check`, `git diff --stat origin/main...HEAD`, and `git status --short`.

Expected: no whitespace errors, only planned files tracked, and user-owned untracked files untouched.

- [ ] **Step 3: Commit test corrections only when required** `[git-commit skill]`

If Task 6 required tracked corrections, commit `test(projects): verify workflow telemetry`; otherwise leave the branch at Task 5.

### Task 7: Deploy and prove telemetry before dashboard work

**Files:**
- No source changes expected.

- [ ] **Step 1: Open, review, and merge the application PR through its normal deployment workflow**

The PR lists trace propagation, grounding attribution, prune counts, migration 095, and quality-gate output. The dashboard PR does not merge first.

- [ ] **Step 2: Trigger representative workflows**

Run one clustering, one first/full case study, one identical-input cache hit, and one refine after new evidence.

- [ ] **Step 3: Verify RDS**

Confirm each new run has `metadata.traceId`, terminal metadata, mode/cache/effect fields, and that related model and grounding rows carry the same trace and project attribution.

- [ ] **Step 4: Verify Loki and Tempo through Grafana MCP**

Each run has one root, bounded child stages, and one terminal event with the same trace ID. No prompts, generated prose, repository content, credentials, or PII appear.

- [ ] **Step 5: Record redacted evidence for the dashboard PR**

Capture one field-shape example per workflow, one charge per agent, one terminal event, and one trace tree. These are the data contract for the dashboard plan.
