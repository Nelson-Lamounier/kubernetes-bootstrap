/** @format */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = resolve(
  TEST_DIR,
  '../chart/dashboards/llm-operations.json',
);

type DashboardPanel = {
  id?: number;
  title?: string;
  type?: string;
  collapsed?: boolean;
  panels?: DashboardPanel[];
  datasource?: { uid?: string; type?: string };
  targets?: Array<{
    datasource?: { uid?: string; type?: string };
    expr?: string;
    query?: string;
    queryType?: string;
    rawSql?: string;
  }>;
};

type Dashboard = {
  panels: DashboardPanel[];
  templating?: { list?: Array<{ name?: string; query?: string }> };
};

function loadDashboard(): Dashboard {
  return JSON.parse(readFileSync(DASHBOARD_PATH, 'utf8')) as Dashboard;
}

function projectRow(dashboard = loadDashboard()): DashboardPanel {
  const row = dashboard.panels.find((panel) => panel.id === 700);
  assert.ok(row, 'project-generation row 700 should exist');
  return row;
}

function nestedPanel(id: number, row = projectRow()): DashboardPanel {
  const panel = row.panels?.find((candidate) => candidate.id === id);
  assert.ok(panel, `nested project-generation panel ${id} should exist`);
  return panel;
}

function firstTarget(panel: DashboardPanel): NonNullable<DashboardPanel['targets']>[number] {
  const target = panel.targets?.[0];
  assert.ok(target, `panel ${panel.id} should have a first query target`);
  return target;
}

describe('LLM Operations project-generation dashboard row', () => {
  it('adds a collapsed project-generation drilldown row with stable panel IDs', () => {
    const row = projectRow();

    assert.equal(
      row.title,
      'Project generation — cost, execution, quality & traces',
    );
    assert.equal(row.type, 'row');
    assert.equal(row.collapsed, true);
    assert.deepEqual(
      row.panels?.map((panel) => panel.id),
      [
        701, 702, 703, 704,
        705, 706, 707, 708,
        709, 710, 711, 712,
        716, 713, 714, 715,
      ],
    );
  });

  it('keeps project pipeline filters selectable from the existing variable', () => {
    const pipeline = loadDashboard().templating?.list?.find(
      (variable) => variable.name === 'pipeline',
    );

    assert.ok(pipeline, 'pipeline variable should exist');
    const values = String(pipeline.query).split(',');
    assert.ok(values.includes('project-clustering'));
    assert.ok(values.includes('project-case-study'));
    assert.ok(values.includes('project-system-tour'));
    assert.ok(values.includes('grounding-verify'));
  });

  it('uses range-bounded RDS queries for project workflow source-of-truth panels', () => {
    const row = projectRow();
    const rdsPanelIds = [701, 702, 703, 704, 705, 706, 707, 708, 709, 710, 711, 713];

    for (const id of rdsPanelIds) {
      const panel = nestedPanel(id, row);
      const target = firstTarget(panel);
      const sql = target.rawSql ?? '';

      assert.equal(
        target.datasource?.uid ?? panel.datasource?.uid,
        'rds-postgres',
        `panel ${id} should query RDS`,
      );
      assert.match(sql, /\$__timeFilter\(/, `panel ${id} should use dashboard time range`);
      assert.doesNotMatch(sql, /INTERVAL '24 hours'/, `panel ${id} should not hard-code 24h`);
      assert.doesNotMatch(sql, /\bincrease\s*\(/i, `panel ${id} should not use Prometheus increase`);
    }
  });

  it('guards PostgreSQL JSON operator precedence in categorical run breakdowns', () => {
    const sql = firstTarget(nestedPanel(709)).rawSql ?? '';

    assert.match(sql, /\|\| \(metadata->>'generationMode'\)/);
    assert.match(sql, /\|\| \(metadata->>'cacheResult'\)/);
  });

  it('keeps terminal duration p95 scoped to trace-instrumented rows', () => {
    const sql = firstTarget(nestedPanel(704)).rawSql ?? '';

    assert.match(sql, /metadata->>'traceId' IS NOT NULL/);
  });

  it('uses low-cardinality Prometheus route queries for project API health', () => {
    for (const id of [712, 716]) {
      const panel = nestedPanel(id);
      const expr = firstTarget(panel).expr ?? '';

      assert.equal(panel.datasource?.uid, 'prometheus');
      assert.match(expr, /route=~"\/api\/admin\/projects\.\*"/);
      assert.doesNotMatch(expr, /user_id|project_id|trace_id/);
    }
  });

  it('pivots selected traces into exact Tempo and Loki views', () => {
    const traceQuery = firstTarget(nestedPanel(714)).query ?? '';
    const logExpr = firstTarget(nestedPanel(715)).expr ?? '';

    assert.match(traceQuery, /\$\{trace_id\}/);
    assert.match(logExpr, /trace_id=\$\{trace_id:json\}/);
  });
});
