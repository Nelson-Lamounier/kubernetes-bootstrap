#!/usr/bin/env tsx
/**
 * @format
 * Bootstrap Orchestrator — dispatches to control_plane.ts or worker.ts main().
 *
 * Usage:
 *   npx tsx orchestrator.ts                   # control-plane (default)
 *   npx tsx orchestrator.ts --mode worker     # worker node
 *   npx tsx orchestrator.ts --dry-run         # print target without executing
 */

import { info } from './common.js';

const parseArgs = (): { mode: 'control-plane' | 'worker'; dryRun: boolean } => {
    const args = process.argv.slice(2);
    const mode = args.includes('--mode')
        ? (args[args.indexOf('--mode') + 1] as 'control-plane' | 'worker')
        : 'control-plane';
    const dryRun = args.includes('--dry-run');
    if (mode !== 'control-plane' && mode !== 'worker') {
        process.stderr.write(`Invalid --mode: ${mode}. Must be 'control-plane' or 'worker'.\n`);
        process.exit(1);
    }
    return { mode, dryRun };
};

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
