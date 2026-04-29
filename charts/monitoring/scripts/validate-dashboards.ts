#!/usr/bin/env npx tsx
/**
 * @format
 * Grafana Dashboard Validation
 *
 * Validates all JSON dashboard files in the monitoring Helm chart.
 *
 * Checks performed:
 *   1. JSON Syntax         — every file parses as valid JSON
 *   2. Required Fields      — title, uid, panels, schemaVersion present
 *   3. Unique UIDs          — no two dashboards share a uid
 *   4. UID Format           — uid uses only lowercase, digits, hyphens
 *   5. Datasource UIDs      — no panel uses an empty datasource uid
 *
 * Usage:
 *   npx tsx kubernetes-app/platform/charts/monitoring/scripts/validate-dashboards.ts
 *   just validate-dashboards
 *
 * Exit codes:
 *   0 = all checks passed
 *   1 = one or more checks failed
 */

import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

import log from '@repo/script-utils/logger.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DASHBOARDS_DIR = resolve(
  import.meta.dirname ?? __dirname,
  '..',
  'chart/dashboards',
);

const REQUIRED_FIELDS = ['title', 'uid', 'panels', 'schemaVersion'] as const;
const UID_PATTERN = /^[a-z0-9-]+$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DashboardData {
  file: string;
  json: Record<string, unknown>;
}

interface ValidationResult {
  check: string;
  passed: boolean;
  details: string[];
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function loadDashboards(): {
  dashboards: DashboardData[];
  syntaxErrors: string[];
} {
  const files = readdirSync(DASHBOARDS_DIR).filter((f) => f.endsWith('.json'));

  if (files.length === 0) {
    log.error(`No .json files found in ${DASHBOARDS_DIR}`);
    process.exit(1);
  }

  const dashboards: DashboardData[] = [];
  const syntaxErrors: string[] = [];

  for (const file of files) {
    const filePath = join(DASHBOARDS_DIR, file);
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const json = JSON.parse(raw) as Record<string, unknown>;
      dashboards.push({ file, json });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      syntaxErrors.push(`${file}: ${message}`);
    }
  }

  return { dashboards, syntaxErrors };
}

function checkSyntax(syntaxErrors: string[]): ValidationResult {
  return {
    check: 'JSON Syntax',
    passed: syntaxErrors.length === 0,
    details: syntaxErrors,
  };
}

function checkRequiredFields(dashboards: DashboardData[]): ValidationResult {
  const errors: string[] = [];

  for (const { file, json } of dashboards) {
    const missing = REQUIRED_FIELDS.filter((field) => !(field in json));
    if (missing.length > 0) {
      errors.push(`${file}: missing ${missing.join(', ')}`);
    }
  }

  return {
    check: 'Required Fields',
    passed: errors.length === 0,
    details: errors,
  };
}

function checkUniqueUids(dashboards: DashboardData[]): ValidationResult {
  const errors: string[] = [];
  const seen = new Map<string, string>(); // uid → first file

  for (const { file, json } of dashboards) {
    const uid = json.uid as string | undefined;
    if (!uid) continue; // caught by required fields check

    const existing = seen.get(uid);
    if (existing) {
      errors.push(
        `Duplicate uid "${uid}" in ${file} (first seen in ${existing})`,
      );
    } else {
      seen.set(uid, file);
    }
  }

  return {
    check: 'Unique UIDs',
    passed: errors.length === 0,
    details: errors,
  };
}

function checkUidFormat(dashboards: DashboardData[]): ValidationResult {
  const errors: string[] = [];

  for (const { file, json } of dashboards) {
    const uid = json.uid as string | undefined;
    if (!uid) continue; // caught by required fields check

    if (!UID_PATTERN.test(uid)) {
      errors.push(
        `${file}: uid "${uid}" must use only lowercase, digits, hyphens`,
      );
    }
  }

  return {
    check: 'UID Format',
    passed: errors.length === 0,
    details: errors,
  };
}

/**
 * Check that no panel has an empty datasource uid.
 * An empty uid ("" or missing) means Grafana cannot resolve the datasource
 * and all queries will return "No Data".
 */
function checkDatasourceUids(dashboards: DashboardData[]): ValidationResult {
  const errors: string[] = [];

  for (const { file, json } of dashboards) {
    const panels = json.panels as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(panels)) continue;

    const check = (
      panelList: Array<Record<string, unknown>>,
      parentPath: string,
    ): void => {
      for (const panel of panelList) {
        const panelId = (panel.id as number) ?? '?';
        const ds = panel.datasource as
          | { uid?: string; type?: string }
          | undefined;

        if (ds && typeof ds.uid === 'string' && ds.uid.trim() === '') {
          errors.push(
            `${file}: panel ${panelId} (${parentPath}) has empty datasource uid`,
          );
        }

        // Recurse into nested panels (rows)
        const nested = panel.panels as
          | Array<Record<string, unknown>>
          | undefined;
        if (Array.isArray(nested)) {
          check(nested, `${parentPath} > row ${panelId}`);
        }

        // Check targets for per-query datasource overrides
        const targets = panel.targets as
          | Array<Record<string, unknown>>
          | undefined;
        if (Array.isArray(targets)) {
          for (const target of targets) {
            const tds = target.datasource as
              | { uid?: string; type?: string }
              | undefined;
            if (tds && typeof tds.uid === 'string' && tds.uid.trim() === '') {
              errors.push(
                `${file}: panel ${panelId} (${parentPath}) query has empty datasource uid`,
              );
            }
          }
        }
      }
    };

    check(panels, 'root');
  }

  return {
    check: 'Datasource UIDs',
    passed: errors.length === 0,
    details: errors,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  log.header('Grafana Dashboard Validation');
  log.info(`Directory: ${DASHBOARDS_DIR}`);
  log.blank();

  const { dashboards, syntaxErrors } = loadDashboards();
  const totalFiles = dashboards.length + syntaxErrors.length;
  log.info(`Found ${totalFiles} dashboard file(s)`);
  log.blank();

  const results: ValidationResult[] = [
    checkSyntax(syntaxErrors),
    checkRequiredFields(dashboards),
    checkUniqueUids(dashboards),
    checkUidFormat(dashboards),
    checkDatasourceUids(dashboards),
  ];

  let failures = 0;

  for (const result of results) {
    if (result.passed) {
      log.success(`${result.check}`);
    } else {
      log.error(`${result.check}`);
      for (const detail of result.details) {
        log.listItem(detail);
      }
      failures++;
    }
  }

  log.blank();

  if (failures > 0) {
    log.error(`${failures} check(s) failed`);
    process.exit(1);
  }

  log.success(
    `All ${results.length} checks passed (${dashboards.length} dashboards)`,
  );
}

main();
