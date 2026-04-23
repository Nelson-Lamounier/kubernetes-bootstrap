#!/usr/bin/env tsx
/**
 * @format
 * @module orchestrator
 * Bootstrap Orchestrator — dispatches to {@link control_plane} or {@link worker}
 * based on the `--mode` CLI flag.
 *
 * This thin entry point exists so a single binary (this file) can be invoked by
 * the SSM Automation document for both node types.  The actual bootstrap logic
 * lives in the mode-specific modules to keep concerns separated.
 *
 * @example
 * ```bash
 * # Control-plane bootstrap (default)
 * npx tsx orchestrator.ts
 *
 * # Worker-node bootstrap
 * npx tsx orchestrator.ts --mode worker
 *
 * # Dry-run: print target module without executing
 * npx tsx orchestrator.ts --dry-run
 * npx tsx orchestrator.ts --mode worker --dry-run
 * ```
 */

import { info } from './common.js';

// =============================================================================
// CLI argument parsing
// =============================================================================

/**
 * Parsed CLI arguments for the orchestrator.
 */
interface OrchestratorArgs {
    /** Target bootstrap mode. */
    mode: 'control-plane' | 'worker';
    /** When `true`, logs the target module and exits without executing. */
    dryRun: boolean;
}

/**
 * Parses `process.argv` and returns the orchestrator's runtime arguments.
 *
 * @remarks
 * `--mode` accepts exactly `"control-plane"` or `"worker"`.  Any other value
 * is treated as an error and the process exits with code 1.
 *
 * @returns Parsed {@link OrchestratorArgs}.
 */
const parseArgs = (): OrchestratorArgs => {
    const args = process.argv.slice(2);
    const modeIdx = args.indexOf('--mode');
    const rawMode = modeIdx >= 0 ? args[modeIdx + 1] : 'control-plane';
    const dryRun  = args.includes('--dry-run');

    if (rawMode !== 'control-plane' && rawMode !== 'worker') {
        process.stderr.write(`Invalid --mode: ${rawMode}. Must be 'control-plane' or 'worker'.\n`);
        process.exit(1);
    }

    return { mode: rawMode as OrchestratorArgs['mode'], dryRun };
};

// =============================================================================
// Entry point
// =============================================================================

const { mode, dryRun } = parseArgs();

if (dryRun) {
    const target = mode === 'control-plane' ? 'control_plane.ts' : 'worker.ts';
    info(`DRY RUN — would execute: npx tsx ${target}`);
    info(`Mode: ${mode}`);
    process.exit(0);
}

info(`Orchestrator starting: mode=${mode}`);

if (mode === 'control-plane') {
    const { main } = await import('./control_plane.js');
    await main();
} else {
    const { main } = await import('./worker.js');
    await main();
}
