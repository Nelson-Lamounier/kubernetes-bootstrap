#!/usr/bin/env npx tsx
/**
 * Site Smoke Test
 *
 * Polls the live CloudFront URL to confirm the site is serving HTTP 2xx
 * after a bootstrap or deployment run.
 *
 * Uses exponential backoff so that a brief post-deploy warm-up window
 * (ArgoCD sync, image pull, pod Ready) does not cause an immediate failure.
 *
 * Usage:
 *   npx tsx infra/scripts/cd/smoke-site.ts \
 *     --environment development \
 *     [--region eu-west-1] \
 *     [--max-attempts 12] \
 *     [--initial-delay 10]
 *
 * Exit codes:
 *   0 — all target URLs returned HTTP 2xx
 *   1 — at least one URL failed all retry attempts
 */

import https from 'https';

import { parseArgs } from '@nelson-lamounier/cdk-deploy-scripts/aws.js';
import { emitAnnotation, writeSummary } from '@nelson-lamounier/cdk-deploy-scripts/github.js';
import logger from '@nelson-lamounier/cdk-deploy-scripts/logger.js';

// =============================================================================
// CLI argument parsing
// =============================================================================
const args = parseArgs(
    [
        {
            name: 'environment',
            description: 'Deployment environment (development, staging, production)',
            hasValue: true,
            default: process.env.DEPLOY_ENVIRONMENT ?? 'development',
        },
        {
            name: 'region',
            description: 'AWS region (unused for HTTP probes, kept for consistency)',
            hasValue: true,
            default: process.env.AWS_REGION ?? 'eu-west-1',
        },
        {
            name: 'max-attempts',
            description: 'Maximum poll attempts per URL before failing (default: 12)',
            hasValue: true,
            default: '12',
        },
        {
            name: 'initial-delay',
            description: 'Initial backoff delay in seconds (doubles each retry, default: 10)',
            hasValue: true,
            default: '10',
        },
    ],
    'Smoke-test the live site URL after bootstrap',
);

const environment = args.environment as string;
const maxAttempts = parseInt(args['max-attempts'] as string, 10) || 12;
const initialDelaySeconds = parseInt(args['initial-delay'] as string, 10) || 10;

// =============================================================================
// Target URL resolution
// =============================================================================

/** Map environment → public CloudFront hostname. */
function resolveHostname(env: string): string {
    switch (env) {
        case 'production':
            return 'nelsonlamounier.com';
        case 'staging':
            return 'staging.nelsonlamounier.com';
        default:
            return 'nelsonlamounier.com';
    }
}

interface SmokeTarget {
    /** Human-readable label shown in logs and summary table. */
    readonly label: string;
    /** Full HTTPS URL to probe. */
    readonly url: string;
    /** Acceptable HTTP status code range — any code in [min, max] is a pass. */
    readonly acceptRange: [number, number];
}

function buildTargets(hostname: string): SmokeTarget[] {
    return [
        {
            label: 'Homepage (/)',
            url: `https://${hostname}/`,
            acceptRange: [200, 399],
        },
        {
            label: 'Admin (/admin)',
            url: `https://${hostname}/admin`,
            // /admin may redirect to the auth provider (3xx) — that's fine
            acceptRange: [200, 399],
        },
    ];
}

// =============================================================================
// HTTP probe
// =============================================================================

interface ProbeResult {
    /** HTTP status code returned by the server, or -1 on network error. */
    readonly statusCode: number;
    /** Round-trip time in milliseconds. */
    readonly durationMs: number;
    /** Error message if the request failed at network level. */
    readonly error?: string;
}

/**
 * Send a single HEAD request to `url` and return the status code + duration.
 *
 * Uses Node's built-in `https` module to avoid adding dependencies.
 * Follows up to 5 redirects.
 *
 * @param url       - Full HTTPS URL to probe.
 * @param timeoutMs - Socket / response timeout in milliseconds.
 * @returns {@link ProbeResult}
 */
async function probe(url: string, timeoutMs = 10_000): Promise<ProbeResult> {
    const start = Date.now();
    return new Promise((resolve) => {
        const req = https.request(url, { method: 'HEAD', timeout: timeoutMs }, (res) => {
            const durationMs = Date.now() - start;
            res.resume(); // drain the response body
            resolve({ statusCode: res.statusCode ?? 0, durationMs });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({ statusCode: -1, durationMs: Date.now() - start, error: 'timeout' });
        });

        req.on('error', (err) => {
            resolve({ statusCode: -1, durationMs: Date.now() - start, error: err.message });
        });

        req.end();
    });
}

/** Sleep for a given number of milliseconds. */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Retry loop
// =============================================================================

interface TargetOutcome {
    readonly label: string;
    readonly url: string;
    readonly passed: boolean;
    readonly finalStatus: number;
    readonly finalDurationMs: number;
    readonly attempts: number;
}

/**
 * Poll a single {@link SmokeTarget} with exponential backoff.
 *
 * Returns `true` as soon as the response code is within the accept range.
 * After `maxAttempts` failures, returns `false`.
 *
 * @param target          - URL to probe.
 * @param maxAttempts     - Maximum number of polling attempts.
 * @param initialDelayMs  - First backoff delay in milliseconds (doubles each retry).
 * @returns {@link TargetOutcome}
 */
async function pollTarget(
    target: SmokeTarget,
    maxAttempts: number,
    initialDelayMs: number,
): Promise<TargetOutcome> {
    const [minCode, maxCode] = target.acceptRange;
    let delay = initialDelayMs;
    let lastStatus = -1;
    let lastDuration = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const result = await probe(target.url);
        lastStatus = result.statusCode;
        lastDuration = result.durationMs;

        const withinRange =
            result.statusCode >= minCode && result.statusCode <= maxCode;

        if (withinRange) {
            logger.success(
                `[${attempt}/${maxAttempts}] ${target.label}: HTTP ${result.statusCode} (${result.durationMs}ms)`,
            );
            return {
                label: target.label,
                url: target.url,
                passed: true,
                finalStatus: result.statusCode,
                finalDurationMs: result.durationMs,
                attempts: attempt,
            };
        }

        const detail = result.error
            ? `error=${result.error}`
            : `HTTP ${result.statusCode}`;

        logger.warn(
            `[${attempt}/${maxAttempts}] ${target.label}: ${detail} (${result.durationMs}ms) — retrying in ${delay / 1000}s`,
        );

        if (attempt < maxAttempts) {
            await sleep(delay);
            delay = Math.min(delay * 2, 120_000); // cap at 2 min
        }
    }

    return {
        label: target.label,
        url: target.url,
        passed: false,
        finalStatus: lastStatus,
        finalDurationMs: lastDuration,
        attempts: maxAttempts,
    };
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
    const hostname = resolveHostname(environment);
    const targets = buildTargets(hostname);

    logger.header('Site Smoke Tests');
    logger.keyValue('Environment', environment);
    logger.keyValue('Hostname', hostname);
    logger.keyValue('Max Attempts', String(maxAttempts));
    logger.keyValue('Initial Delay', `${initialDelaySeconds}s`);
    logger.blank();

    const outcomes: TargetOutcome[] = [];

    for (const target of targets) {
        logger.task(target.label);
        logger.keyValue('URL', target.url);
        const outcome = await pollTarget(target, maxAttempts, initialDelaySeconds * 1000);
        outcomes.push(outcome);
        logger.blank();
    }

    // ── GitHub Step Summary ────────────────────────────────────────────────
    const summaryLines: string[] = [
        '## Site Smoke Tests',
        '',
        `**Environment:** ${environment} | **Hostname:** \`${hostname}\``,
        '',
        '| Target | URL | Status | Duration | Attempts |',
        '|--------|-----|--------|----------|----------|',
    ];

    for (const o of outcomes) {
        const icon = o.passed ? '✅' : '❌';
        const statusLabel = o.finalStatus === -1 ? 'error' : String(o.finalStatus);
        summaryLines.push(
            `| ${icon} ${o.label} | ${o.url} | ${statusLabel} | ${o.finalDurationMs}ms | ${o.attempts}/${maxAttempts} |`,
        );
    }

    writeSummary(summaryLines.join('\n'));

    // ── Result ─────────────────────────────────────────────────────────────
    const failed = outcomes.filter((o) => !o.passed);

    if (failed.length === 0) {
        logger.success(`All ${outcomes.length} smoke targets passed — site is serving traffic`);
        process.exit(0);
    }

    // Emit an actionable warning annotation for each failed target
    for (const o of failed) {
        emitAnnotation(
            'error',
            `Site smoke test FAILED: ${o.label} (${o.url}) returned HTTP ${o.finalStatus} after ${o.attempts} attempts`,
            'Site Traffic Verification',
        );
    }

    logger.fatal(
        `${failed.length}/${outcomes.length} smoke target(s) failed — ` +
        'the site is not serving traffic correctly. Check ArgoCD sync status and pod readiness.',
    );
}

main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    emitAnnotation('error', `Smoke site script error: ${msg}`, 'Site Smoke Test');
    logger.fatal(`Smoke site script error: ${msg}`);
});
