/** @format */
/**
 * Grafana Dashboard Validation Tests
 *
 * Uses Node.js built-in test runner (node:test) for zero-dependency,
 * ESM-compatible testing. Run with: npx tsx --test <file>
 *
 * Complements the standalone CLI script (validate-dashboards.ts)
 * with per-file granularity.
 *
 * Checks:
 *   1. JSON Syntax     — every file parses without errors
 *   2. Required Fields — title, uid, panels, schemaVersion present
 *   3. Unique UIDs     — no two dashboards share a uid
 *   4. UID Format      — uid uses only lowercase, digits, hyphens
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DASHBOARDS_DIR = resolve(
  import.meta.dirname ?? __dirname,
  '..',
  'chart/dashboards',
);
const REQUIRED_FIELDS = ['title', 'uid', 'panels', 'schemaVersion'];
const UID_PATTERN = /^[a-z0-9-]+$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDashboardFiles(): string[] {
  return readdirSync(DASHBOARDS_DIR).filter((f) => f.endsWith('.json'));
}

function loadDashboard(file: string): Record<string, unknown> {
  const raw = readFileSync(join(DASHBOARDS_DIR, file), 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const files = getDashboardFiles();

describe('Grafana Dashboard Validation', () => {
  it('should find dashboard files', () => {
    assert.ok(files.length > 0, 'No dashboard JSON files found');
  });

  // -------------------------------------------------------------------------
  // Per-file checks
  // -------------------------------------------------------------------------
  for (const file of files) {
    describe(file, () => {
      let dashboard: Record<string, unknown>;

      it('is valid JSON', () => {
        dashboard = loadDashboard(file);
        assert.ok(dashboard, 'Dashboard parsed to falsy value');
        assert.equal(typeof dashboard, 'object');
      });

      for (const field of REQUIRED_FIELDS) {
        it(`has required field: ${field}`, () => {
          if (!dashboard) dashboard = loadDashboard(file);
          assert.ok(
            field in dashboard,
            `Missing required field "${field}" in ${file}`,
          );
        });
      }

      it('has a valid uid format (lowercase, digits, hyphens)', () => {
        if (!dashboard) dashboard = loadDashboard(file);
        const uid = dashboard.uid as string;
        assert.match(
          uid,
          UID_PATTERN,
          `UID "${uid}" in ${file} must be lowercase kebab-case`,
        );
      });

      it('has no panels with empty datasource UIDs', () => {
        if (!dashboard) dashboard = loadDashboard(file);
        const panels = dashboard.panels as Array<Record<string, unknown>>;
        const emptyUids: string[] = [];

        const check = (panelList: Array<Record<string, unknown>>): void => {
          for (const panel of panelList) {
            const id = (panel.id as number) ?? '?';
            const ds = panel.datasource as { uid?: string } | undefined;
            if (ds && typeof ds.uid === 'string' && ds.uid.trim() === '') {
              emptyUids.push(`panel ${id}`);
            }
            const targets = panel.targets as Array<Record<string, unknown>> | undefined;
            if (Array.isArray(targets)) {
              for (const t of targets) {
                const tds = t.datasource as { uid?: string } | undefined;
                if (tds && typeof tds.uid === 'string' && tds.uid.trim() === '') {
                  emptyUids.push(`panel ${id} query ${t.refId ?? '?'}`);
                }
              }
            }
            const nested = panel.panels as Array<Record<string, unknown>> | undefined;
            if (Array.isArray(nested)) check(nested);
          }
        };

        check(panels);
        assert.deepEqual(
          emptyUids,
          [],
          `Empty datasource UIDs found in ${file}: ${emptyUids.join(', ')}`,
        );
      });
    });
  }

  // -------------------------------------------------------------------------
  // Cross-file checks
  // -------------------------------------------------------------------------
  describe('Cross-file validation', () => {
    it('all UIDs are unique', () => {
      const seen = new Map<string, string>();
      const duplicates: string[] = [];

      for (const file of files) {
        const dash = loadDashboard(file);
        const uid = dash.uid as string;
        const existing = seen.get(uid);
        if (existing) {
          duplicates.push(`"${uid}" in ${file} (first in ${existing})`);
        } else {
          seen.set(uid, file);
        }
      }

      assert.deepEqual(
        duplicates,
        [],
        `Duplicate UIDs found:\n${duplicates.join('\n')}`,
      );
    });
  });
});
