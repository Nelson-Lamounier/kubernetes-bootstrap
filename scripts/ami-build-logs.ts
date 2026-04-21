#!/usr/bin/env npx tsx
/**
 * @format
 * ami-build-logs.ts — Fetch Image Builder per-step logs from S3 after a failed bake.
 *
 * Replicates the manual troubleshooting flow:
 *   1. Resolve scripts S3 bucket from SSM /k8s/{env}/scripts-bucket
 *   2. List image-builder-logs/ recursively, pick the most recent execution
 *      (or the one matching --workflow-id if provided from the CF error)
 *   3. Download the TOE console.log for that execution
 *   4. Parse step boundaries, find failed steps, highlight stderr context
 *   5. Exit 1 if a failure was found so the CI job fails visibly
 *
 * Usage:
 *   npx tsx scripts/ami-build-logs.ts
 *   npx tsx scripts/ami-build-logs.ts --env production --profile prod-account
 *   npx tsx scripts/ami-build-logs.ts --workflow-id wf-0f54b5ce-93be-4941-8563-13c6783783c6
 */

import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { buildAwsConfig, parseArgs, resolveAuth } from './lib/aws.js';
import log from './lib/logger.js';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = parseArgs(
    [
        { name: 'env',         description: 'Target environment',                                    hasValue: true,  default: 'development' },
        { name: 'region',      description: 'AWS region',                                            hasValue: true,  default: 'eu-west-1' },
        { name: 'profile',     description: 'AWS profile',                                           hasValue: true,  default: 'dev-account' },
        { name: 'workflow-id', description: 'Image Builder workflow ID to fetch (e.g. wf-abc123)', hasValue: true,  default: '' },
        { name: 'tail',        description: 'Lines of context to print around each error',           hasValue: true,  default: '15' },
    ],
    'Fetch Image Builder per-step logs from S3 after a failed AMI bake.',
);

const env        = args['env'] as string;
const region     = args['region'] as string;
const profile    = args['profile'] as string;
const workflowId = args['workflow-id'] as string;
const awsConfig  = buildAwsConfig(args);
const { credentials } = resolveAuth(profile);

const s3Client  = new S3Client({ ...awsConfig, credentials });
const ssmClient = new SSMClient({ ...awsConfig, credentials });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getScriptsBucket(): Promise<string> {
    const res = await ssmClient.send(new GetParameterCommand({ Name: `/k8s/${env}/scripts-bucket` }));
    const bucket = res.Parameter?.Value;
    if (!bucket) throw new Error(`SSM /k8s/${env}/scripts-bucket not found — deploy SsmAutomation stack first`);
    return bucket;
}

async function listPrefix(bucket: string, prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
        const res = await s3Client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const obj of res.Contents ?? []) {
            if (obj.Key) keys.push(obj.Key);
        }
        token = res.NextContinuationToken;
    } while (token);
    return keys;
}

async function getObject(bucket: string, key: string): Promise<string> {
    const res = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    log.info(`Fetching Image Builder logs — env=${env} region=${region}`);

    const bucket = await getScriptsBucket();
    log.info(`Scripts bucket: ${bucket}`);

    const logPrefix = 'image-builder-logs/';
    log.info(`Scanning s3://${bucket}/${logPrefix}...`);

    const allKeys = await listPrefix(bucket, logPrefix);

    if (allKeys.length === 0) {
        log.error('No Image Builder logs found. Logs are only present after the first bake with S3 logging enabled.');
        process.exit(1);
    }

    // Group keys by execution root: image-builder-logs/<recipe>/<version>/<wf-id>/
    const execRoots = new Map<string, string[]>();
    for (const key of allKeys) {
        const parts = key.replace(logPrefix, '').split('/');
        if (parts.length < 4) continue;
        const execRoot = `${logPrefix}${parts[0]}/${parts[1]}/${parts[2]}`;
        const group = execRoots.get(execRoot) ?? [];
        group.push(key);
        execRoots.set(execRoot, group);
    }

    // Select target execution
    let targetRoot: string;
    let targetKeys: string[];

    if (workflowId) {
        const match = [...execRoots.entries()].find(([k]) => k.includes(workflowId));
        if (!match) {
            log.error(`No execution found matching workflow ID: ${workflowId}`);
            log.info('Available executions:');
            for (const root of execRoots.keys()) log.info(`  ${root}`);
            process.exit(1);
        }
        [targetRoot, targetKeys] = match;
    } else {
        // Sort by latest key timestamp (S3 key name contains UTC timestamps)
        const sorted = [...execRoots.entries()].sort((a, b) => {
            const latestKey = (arr: string[]) => arr.reduce((best, k) => (k > best ? k : best), '');
            return latestKey(b[1]).localeCompare(latestKey(a[1]));
        });
        [targetRoot, targetKeys] = sorted[0]!;
    }

    log.info(`\nExecution: ${targetRoot}`);
    log.info(`Files: ${targetKeys.length}`);

    // Find TOE console.log (primary per-step log)
    const consoleLogKey = targetKeys.find(k => k.includes('/TOE_') && k.endsWith('/console.log'));
    if (!consoleLogKey) {
        log.warn('console.log not found in this execution. Available files:');
        for (const k of targetKeys) log.info(`  s3://${bucket}/${k}`);
        process.exit(1);
    }

    log.info(`\nFetching: s3://${bucket}/${consoleLogKey}`);
    const consoleLog = await getObject(bucket, consoleLogKey);
    const lines = consoleLog.split('\n');
    log.info(`Log lines: ${lines.length}\n`);

    // -------------------------------------------------------------------------
    // Parse step boundaries and detect failures
    // -------------------------------------------------------------------------
    const stepStartRe = /Step (\w+)$/;
    const failRe      = /\[ ERROR \]|ExitCode [^0]|FATAL:|level=fatal|command was not successfully|resulted in an error/i;
    const stderrRe    = /CmdExecution: Stderr:/;

    type StepBlock = { name: string; startIdx: number; endIdx: number; failed: boolean };
    const steps: StepBlock[] = [];
    let current: StepBlock | null = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const m = line.match(stepStartRe);
        if (m) {
            if (current) { current.endIdx = i - 1; steps.push(current); }
            current = { name: m[1]!, startIdx: i, endIdx: i, failed: false };
        }
        if (current && failRe.test(line)) current.failed = true;
    }
    if (current) { current.endIdx = lines.length - 1; steps.push(current); }

    // -------------------------------------------------------------------------
    // Output: step table + failed step detail
    // -------------------------------------------------------------------------
    console.log('\n' + '═'.repeat(70));
    console.log('  Image Builder Step Summary');
    console.log('═'.repeat(70));

    for (const step of steps) {
        const icon = step.failed ? '❌' : '✅';
        console.log(`  ${icon}  ${step.name.padEnd(38)} L${step.startIdx + 1}–${step.endIdx + 1}`);
    }

    const failed = steps.filter(s => s.failed);

    if (failed.length === 0) {
        console.log('\n⚠  No failed step detected via pattern matching.');
        console.log(`   Last 30 lines of console.log:\n`);
        console.log(lines.slice(-30).join('\n'));
        process.exit(0);
    }

    for (const step of failed) {
        console.log('\n' + '═'.repeat(70));
        console.log(`  ❌  FAILED STEP: ${step.name}`);
        console.log('═'.repeat(70) + '\n');

        const stepLines = lines.slice(step.startIdx, step.endIdx + 1);
        for (const line of stepLines) {
            const marker = failRe.test(line) || stderrRe.test(line) ? '>>>' : '   ';
            console.log(`  ${marker}  ${line}`);
        }
    }

    // SSM-level stderr (brief summary written by the workflow runner)
    const ssmStderrKey = targetKeys.find(k => k.includes('ApplyBuildComponents') && k.endsWith('stderr'));
    if (ssmStderrKey) {
        const stderr = await getObject(bucket, ssmStderrKey);
        if (stderr.trim()) {
            console.log('\n' + '─'.repeat(70));
            console.log('  SSM ApplyBuildComponents stderr:');
            console.log('─'.repeat(70));
            console.log(stderr);
        }
    }

    console.log('\n' + '═'.repeat(70));
    console.log(`  ${failed.length} step(s) failed. See output above.`);
    console.log('═'.repeat(70) + '\n');

    process.exit(1);
}

main().catch(err => {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
