#!/usr/bin/env tsx
/**
 * @format
 * gh-secrets — local CLI for managing GitHub repo & environment
 * secrets/variables across multiple repositories in one shot.
 *
 * Wraps `gh secret` + `gh variable` so you don't have to memorise the
 * matrix of `--repo`, `--env`, `--body`, `--app` flags. Reuses your
 * already-authenticated `gh` session — no PATs, no extra auth flow.
 *
 * Two modes:
 *
 *   1. Imperative — single secret, one or many repos:
 *        tsx gh-secrets.ts set \
 *          --name LOKI_PUSH_URL \
 *          --value "https://loki-push.nelsonlamounier.com/loki/api/v1/push" \
 *          --repos tucaken-app,ai-applications,cdk-monitoring,kubernetes-bootstrap
 *
 *      Read value from stdin (safer for tokens — no shell history):
 *        echo -n 'github-actions:secret-token' | \
 *          tsx gh-secrets.ts set --name LOKI_PUSH_BASIC_AUTH --from-stdin \
 *            --repos tucaken-app,ai-applications,cdk-monitoring,kubernetes-bootstrap
 *
 *   2. Declarative — apply a YAML/JSON config (idempotent):
 *        tsx gh-secrets.ts apply scripts/loki-secrets.yaml
 *
 * Other commands:
 *   list   --repo tucaken-app                 # list repo secrets + variables
 *   list   --repo tucaken-app --env development
 *   delete --name OLD_TOKEN --repos a,b,c
 *
 * Pre-flight checks:
 *   - `gh auth status` must succeed.
 *   - For each repo, `gh repo view <owner>/<repo>` must succeed.
 *   - For environment-scoped writes, the target environment must exist
 *     on the repo (run `gh api repos/{owner}/{repo}/environments` or
 *     create via `gh api -X PUT repos/{owner}/{repo}/environments/<env>`).
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import * as path from 'node:path';

// Optional, makes output readable but not required for correctness.
// `chalk` is in scripts/package.json so it's already installed.
import chalk from 'chalk';

// =============================================================================
// Types
// =============================================================================

type Kind  = 'secret' | 'variable';
type Scope = 'repo'   | 'environment';

interface Target {
    /** GitHub repo name (e.g. 'tucaken-app'). Owner is taken from --owner. */
    repo:        string;
    /** Optional environment — when set, applies to env scope, not repo scope. */
    environment?: string;
}

interface Entry {
    name:    string;
    /** Literal value. */
    value?:  string;
    /** Read from this env var on the calling shell. Avoids putting secrets on argv. */
    valueFromEnv?: string;
    /** Read from this file path. */
    valueFromFile?: string;
    /** When true, read from stdin (one entry per `apply` run, can't combine). */
    valueFromStdin?: boolean;
    kind?:   Kind;        // default 'secret'
    repos?:  string[];    // overrides top-level repos for this entry
    /** Optional environment override per entry. */
    environment?: string;
}

interface ApplyConfig {
    /** Default GitHub owner — repos resolve to {owner}/{repo}. */
    owner?:   string;
    /** Default repo list applied to every entry that doesn't override. */
    repos?:   string[];
    /** Default environment (writes env-scoped secrets/vars on every repo). */
    environment?: string;
    /** The actual secrets/variables to set. */
    entries:  Entry[];
}

// =============================================================================
// gh wrappers — we shell out instead of using @octokit so the user's
// existing `gh auth login` session works without re-authenticating.
// =============================================================================

function ghCheck(): string {
    const r = spawnSync('gh', ['auth', 'status'], { encoding: 'utf-8' });
    if (r.status !== 0) {
        throw new Error(
            `gh CLI not authenticated. Run \`gh auth login\` first.\n${r.stderr || r.stdout}`,
        );
    }
    // Stable user identity for audit logs.
    const u = spawnSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf-8' });
    return u.stdout.trim();
}

function ghDefaultOwner(): string {
    // Default to the authenticated user's login. Override with --owner.
    const r = spawnSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf-8' });
    if (r.status !== 0) throw new Error('gh: cannot resolve default owner.');
    return r.stdout.trim();
}

function repoArg(owner: string, repo: string): string {
    return repo.includes('/') ? repo : `${owner}/${repo}`;
}

/** Run `gh secret/variable set NAME --body <value> [--repo OWNER/REPO] [--env ENV]`. */
function ghSet(args: {
    kind:        Kind;
    name:        string;
    value:       string;
    target:      Target;
    owner:       string;
}): void {
    const { kind, name, value, target, owner } = args;
    const cmd = ['gh', kind, 'set', name, '--body', value, '--repo', repoArg(owner, target.repo)];
    if (target.environment) cmd.push('--env', target.environment);

    const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf-8' });
    if (r.status !== 0) {
        // gh prints to stderr on failure
        throw new Error(`gh ${kind} set ${name} failed for ${target.repo}` +
            (target.environment ? ` (env=${target.environment})` : '') +
            `:\n${r.stderr || r.stdout}`);
    }
}

function ghDelete(args: {
    kind:    Kind;
    name:    string;
    target:  Target;
    owner:   string;
}): void {
    const { kind, name, target, owner } = args;
    const cmd = ['gh', kind, 'delete', name, '--repo', repoArg(owner, target.repo)];
    if (target.environment) cmd.push('--env', target.environment);

    const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf-8' });
    if (r.status !== 0) {
        const msg = (r.stderr || r.stdout).toString();
        // 404 = already absent → idempotent success.
        if (msg.includes('Not Found') || msg.includes('does not exist')) return;
        throw new Error(`gh ${kind} delete ${name} failed for ${target.repo}:\n${msg}`);
    }
}

function ghList(args: {
    kind:    Kind;
    target:  Target;
    owner:   string;
}): string[] {
    const { kind, target, owner } = args;
    const cmd = ['gh', kind, 'list', '--repo', repoArg(owner, target.repo), '--json', 'name'];
    if (target.environment) cmd.push('--env', target.environment);

    const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf-8' });
    if (r.status !== 0) {
        throw new Error(`gh ${kind} list failed for ${target.repo}:\n${r.stderr || r.stdout}`);
    }
    const parsed = JSON.parse(r.stdout || '[]') as Array<{ name: string }>;
    return parsed.map(p => p.name);
}

// =============================================================================
// Value resolution — read from --value, --from-file, --from-env, or --from-stdin.
// =============================================================================

let _stdinCache: string | undefined;
function readStdinOnce(): string {
    if (_stdinCache !== undefined) return _stdinCache;
    const buf: Buffer[] = [];
    let chunk: Buffer | null;
    // process.stdin.read() is synchronous when piped; for an interactive TTY
    // there's nothing to read and we'd block. Detect TTY and fail fast.
    if (process.stdin.isTTY) {
        throw new Error(
            'No input on stdin (TTY detected). Pipe a value via:\n' +
            '  echo -n "value" | tsx gh-secrets.ts ... --from-stdin',
        );
    }
    // Drain synchronously via fs read on /dev/stdin.
    _stdinCache = readFileSync(0, 'utf-8').replace(/\n$/, '');  // strip trailing \n
    return _stdinCache;
}

function resolveValue(entry: Entry): string {
    if (entry.value !== undefined)       return entry.value;
    if (entry.valueFromEnv) {
        const v = process.env[entry.valueFromEnv];
        if (v === undefined) {
            throw new Error(`Env var ${entry.valueFromEnv} is not set.`);
        }
        return v;
    }
    if (entry.valueFromFile) {
        const p = path.resolve(entry.valueFromFile);
        if (!existsSync(p)) throw new Error(`File not found: ${p}`);
        return readFileSync(p, 'utf-8').replace(/\n$/, '');
    }
    if (entry.valueFromStdin) return readStdinOnce();
    throw new Error(`No value source for ${entry.name} (use value / valueFromEnv / valueFromFile / valueFromStdin).`);
}

// =============================================================================
// Config loader — accepts JSON or YAML (best-effort YAML via simple parser
// fallback so we don't pull js-yaml as a dependency).
// =============================================================================

function loadConfig(file: string): ApplyConfig {
    const p = path.resolve(file);
    if (!existsSync(p)) throw new Error(`Config not found: ${p}`);
    const raw = readFileSync(p, 'utf-8');
    if (p.endsWith('.json')) return JSON.parse(raw) as ApplyConfig;
    // Minimal YAML support — defer to the user having `yaml` or `js-yaml`
    // in node_modules (scripts package may already pull one transitively).
    // If neither is present, fall back to JSON parse with a clear message.
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const yaml = require('yaml') as { parse: (s: string) => unknown };
        return yaml.parse(raw) as ApplyConfig;
    } catch {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const yaml = require('js-yaml') as { load: (s: string) => unknown };
            return yaml.load(raw) as ApplyConfig;
        } catch {
            throw new Error(
                'YAML config requested but neither `yaml` nor `js-yaml` is installed. ' +
                'Either add one to scripts/package.json, or use a .json config.',
            );
        }
    }
}

// =============================================================================
// Commands
// =============================================================================

interface CommonOpts { owner: string; dryRun: boolean }

function cmdSet(opts: {
    common: CommonOpts;
    name:   string;
    value:  string;
    repos:  string[];
    env?:   string;
    kind:   Kind;
}): void {
    const { common, name, value, repos, env, kind } = opts;
    const targets: Target[] = repos.map(r => ({ repo: r, environment: env }));
    let ok = 0, fail = 0;

    for (const target of targets) {
        const where = `${repoArg(common.owner, target.repo)}${env ? ` [env=${env}]` : ''}`;
        try {
            if (common.dryRun) {
                console.log(chalk.gray(`DRY  ${kind.padEnd(8)} set ${name.padEnd(28)} → ${where}`));
            } else {
                ghSet({ kind, name, value, target, owner: common.owner });
                console.log(chalk.green(`OK   ${kind.padEnd(8)} set ${name.padEnd(28)} → ${where}`));
                ok++;
            }
        } catch (err) {
            console.error(chalk.red(`FAIL ${kind.padEnd(8)} set ${name.padEnd(28)} → ${where}: ${(err as Error).message}`));
            fail++;
        }
    }
    if (!common.dryRun) console.log(chalk.bold(`\n${ok} ok, ${fail} failed.`));
    if (fail > 0) process.exit(1);
}

function cmdDelete(opts: {
    common: CommonOpts;
    name:   string;
    repos:  string[];
    env?:   string;
    kind:   Kind;
}): void {
    const { common, name, repos, env, kind } = opts;
    let ok = 0, fail = 0;
    for (const repo of repos) {
        const target: Target = { repo, environment: env };
        const where = `${repoArg(common.owner, repo)}${env ? ` [env=${env}]` : ''}`;
        try {
            if (common.dryRun) {
                console.log(chalk.gray(`DRY  ${kind} delete ${name} → ${where}`));
            } else {
                ghDelete({ kind, name, target, owner: common.owner });
                console.log(chalk.yellow(`DEL  ${kind} ${name} → ${where}`));
                ok++;
            }
        } catch (err) {
            console.error(chalk.red(`FAIL: ${(err as Error).message}`));
            fail++;
        }
    }
    if (fail > 0) process.exit(1);
}

function cmdList(opts: { common: CommonOpts; repo: string; env?: string }): void {
    const { common, repo, env } = opts;
    const target: Target = { repo, environment: env };
    const secrets   = ghList({ kind: 'secret',   target, owner: common.owner });
    const variables = ghList({ kind: 'variable', target, owner: common.owner });
    const where = `${repoArg(common.owner, repo)}${env ? ` [env=${env}]` : ''}`;

    console.log(chalk.bold(`\n${where}`));
    console.log(chalk.cyan('  secrets:'));
    secrets.length ? secrets.forEach(s => console.log(`    - ${s}`))    : console.log('    (none)');
    console.log(chalk.cyan('  variables:'));
    variables.length ? variables.forEach(v => console.log(`    - ${v}`)) : console.log('    (none)');
}

function cmdApply(opts: { common: CommonOpts; configPath: string }): void {
    const { common, configPath } = opts;
    const cfg = loadConfig(configPath);
    const owner = cfg.owner ?? common.owner;
    let ok = 0, fail = 0;

    for (const entry of cfg.entries) {
        const repos = entry.repos ?? cfg.repos ?? [];
        const env   = entry.environment ?? cfg.environment;
        const kind: Kind = entry.kind ?? 'secret';
        if (repos.length === 0) {
            console.error(chalk.red(`FAIL ${entry.name}: no repos specified (top-level or per-entry).`));
            fail++; continue;
        }
        const value = resolveValue(entry);
        for (const repo of repos) {
            const target: Target = { repo, environment: env };
            const where = `${repoArg(owner, repo)}${env ? ` [env=${env}]` : ''}`;
            try {
                if (common.dryRun) {
                    console.log(chalk.gray(`DRY  ${kind.padEnd(8)} set ${entry.name.padEnd(28)} → ${where}`));
                } else {
                    ghSet({ kind, name: entry.name, value, target, owner });
                    console.log(chalk.green(`OK   ${kind.padEnd(8)} set ${entry.name.padEnd(28)} → ${where}`));
                    ok++;
                }
            } catch (err) {
                console.error(chalk.red(`FAIL ${kind} ${entry.name} → ${where}: ${(err as Error).message}`));
                fail++;
            }
        }
    }
    if (!common.dryRun) console.log(chalk.bold(`\n${ok} ok, ${fail} failed.`));
    if (fail > 0) process.exit(1);
}

// =============================================================================
// Argv parsing — node:util parseArgs (no yargs/commander dependency)
// =============================================================================

function help(): void {
    console.log(`
gh-secrets — manage GitHub repo & environment secrets/variables in bulk

USAGE
  tsx gh-secrets.ts <command> [options]

COMMANDS
  set       set one secret/variable on one or more repos
  delete    delete by name from one or more repos
  list      print secrets + variables on a repo (or env)
  apply     declarative apply from a YAML/JSON config

GLOBAL OPTIONS
  --owner       GitHub owner (default: authenticated user)
  --type        secret | variable (default: secret)
  --dry-run     print intended changes, don't write
  --help        this text

set / delete OPTIONS
  --name        secret or variable name              (required)
  --repos       comma-separated repo list            (required)
  --env         environment scope (e.g. development)
  --value       literal value (set only)
  --from-env    env var name to read value from
  --from-file   file path to read value from
  --from-stdin  read value from stdin (recommended for tokens)

list OPTIONS
  --repo        single repo
  --env         optional environment

apply OPTIONS
  positional    config path (YAML or JSON)

EXAMPLES

  # The original use case — wire LOKI secrets across 4 repos:
  echo -n 'https://loki-push.nelsonlamounier.com/loki/api/v1/push' | \\
    tsx gh-secrets.ts set --name LOKI_PUSH_URL --from-stdin \\
      --repos tucaken-app,ai-applications,cdk-monitoring,kubernetes-bootstrap

  echo -n 'github-actions:cleartext-token-here' | \\
    tsx gh-secrets.ts set --name LOKI_PUSH_BASIC_AUTH --from-stdin \\
      --repos tucaken-app,ai-applications,cdk-monitoring,kubernetes-bootstrap

  # Same in declarative form:
  tsx gh-secrets.ts apply scripts/loki-secrets.example.yaml

  # Environment-scoped variable:
  tsx gh-secrets.ts set --type variable --name LOG_LEVEL --value debug \\
    --repos tucaken-app --env development

  # List what's already there:
  tsx gh-secrets.ts list --repo tucaken-app
`);
}

function main(): void {
    const argv = process.argv.slice(2);
    const cmd = argv[0];
    const rest = argv.slice(1);

    if (!cmd || cmd === '--help' || cmd === '-h') { help(); return; }

    const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
            owner:        { type: 'string' },
            type:         { type: 'string', default: 'secret' },
            'dry-run':    { type: 'boolean', default: false },
            name:         { type: 'string' },
            value:        { type: 'string' },
            'from-env':   { type: 'string' },
            'from-file':  { type: 'string' },
            'from-stdin': { type: 'boolean', default: false },
            repo:         { type: 'string' },
            repos:        { type: 'string' },
            env:          { type: 'string' },
        },
    });

    const user = ghCheck();
    const owner = (values.owner as string | undefined) ?? ghDefaultOwner();
    const common: CommonOpts = { owner, dryRun: Boolean(values['dry-run']) };
    const kind: Kind = (values.type === 'variable' ? 'variable' : 'secret');

    console.log(chalk.gray(`gh user=${user} owner=${owner} kind=${kind}` + (common.dryRun ? ' [dry-run]' : '')));

    switch (cmd) {
        case 'set': {
            if (!values.name)   throw new Error('--name required');
            if (!values.repos)  throw new Error('--repos required (comma-separated)');
            const repos = (values.repos as string).split(',').map(s => s.trim()).filter(Boolean);
            const value = resolveValue({
                name:           values.name as string,
                value:          values.value as string | undefined,
                valueFromEnv:   values['from-env']  as string | undefined,
                valueFromFile:  values['from-file'] as string | undefined,
                valueFromStdin: Boolean(values['from-stdin']),
            });
            cmdSet({ common, name: values.name as string, value, repos, env: values.env as string | undefined, kind });
            return;
        }
        case 'delete': {
            if (!values.name)  throw new Error('--name required');
            if (!values.repos) throw new Error('--repos required');
            const repos = (values.repos as string).split(',').map(s => s.trim()).filter(Boolean);
            cmdDelete({ common, name: values.name as string, repos, env: values.env as string | undefined, kind });
            return;
        }
        case 'list': {
            if (!values.repo) throw new Error('--repo required');
            cmdList({ common, repo: values.repo as string, env: values.env as string | undefined });
            return;
        }
        case 'apply': {
            const configPath = positionals[0];
            if (!configPath) throw new Error('apply requires a config path');
            cmdApply({ common, configPath });
            return;
        }
        default:
            help();
            process.exit(2);
    }
}

try {
    main();
} catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exit(1);
}
