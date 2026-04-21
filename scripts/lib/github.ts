/**
 * GitHub Actions Helpers
 *
 * Shared utilities for writing GitHub Actions outputs and step summaries.
 * Vendored from @repo/script-utils — standalone copy for kubernetes-bootstrap.
 */

import { appendFileSync } from 'fs';
import { randomUUID } from 'crypto';

// =============================================================================
// GitHub Actions Outputs ($GITHUB_OUTPUT)
// =============================================================================

export function setOutput(key: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;

  const delimiter = `EOF_${randomUUID().slice(0, 8)}`;
  appendFileSync(outputFile, `${key}<<${delimiter}\n${value}\n${delimiter}\n`);
}

// =============================================================================
// GitHub Actions Step Summary ($GITHUB_STEP_SUMMARY)
// =============================================================================

export function writeSummary(line: string): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;

  appendFileSync(summaryFile, line + '\n');
}

// =============================================================================
// CI Detection
// =============================================================================

export function isCI(): boolean {
  return process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
}

export function maskSecret(value: string): void {
  if (!isCI()) return;
  console.log(`::add-mask::${value}`);
}

// =============================================================================
// GitHub Actions Annotations
// =============================================================================

export function emitAnnotation(
  level: 'error' | 'warning' | 'notice',
  message: string,
  title?: string,
): void {
  if (!isCI()) return;
  const titlePart = title ? ` title=${title}` : '';
  console.log(`::${level}${titlePart}::${message}`);
}
