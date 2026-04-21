#!/usr/bin/env npx tsx
/**
 * @format
 * AMI Troubleshooter
 *
 * Three-phase diagnostic tool for the Golden AMI pipeline:
 *
 *   during  — Discover Image Builder log groups and show recent errors.
 *             Use --follow to tail logs live during a build.
 *   after   — Confirm AMI ID in SSM and verify state = available.
 *   asg     — Check the launch template points to the expected AMI.
 *
 * Usage:
 *   npx tsx scripts/troubleshoot-ami.ts                          # all phases
 *   npx tsx scripts/troubleshoot-ami.ts --mode during            # logs only
 *   npx tsx scripts/troubleshoot-ami.ts --mode during --follow   # tail live
 *   npx tsx scripts/troubleshoot-ami.ts --mode after             # SSM + AMI state
 *   npx tsx scripts/troubleshoot-ami.ts --mode asg               # launch template
 *   npx tsx scripts/troubleshoot-ami.ts --env production --profile prod-account
 */

import {
    CloudWatchLogsClient,
    DescribeLogGroupsCommand,
    FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
    EC2Client,
    DescribeImagesCommand,
    DescribeLaunchTemplateVersionsCommand,
    DescribeLaunchTemplatesCommand,
} from '@aws-sdk/client-ec2';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

import { buildAwsConfig, execShell, execShellStream, parseArgs, resolveAuth } from './lib/aws.js';
import log from './lib/logger.js';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = parseArgs(
    [
        { name: 'env',     description: 'Target environment',       hasValue: true,  default: 'development' },
        { name: 'region',  description: 'AWS region',               hasValue: true,  default: 'eu-west-1' },
        { name: 'profile', description: 'AWS profile',              hasValue: true,  default: 'dev-account' },
        { name: 'mode',    description: 'during | after | asg | all', hasValue: true, default: 'all' },
        { name: 'minutes', description: 'Log lookback window (min)', hasValue: true,  default: '30' },
        { name: 'follow',  description: 'Tail Image Builder logs live (during mode only)', hasValue: false, default: false },
    ],
    'AMI pipeline troubleshooter — during creation, after creation, and ASG readiness checks.',
);

const env        = args.env as string;
const region     = args.region as string;
const profile    = args.profile as string;
const mode       = args.mode as string;
const minutes    = parseInt(args.minutes as string, 10);
const follow     = args.follow as boolean;
const awsConfig  = buildAwsConfig(args);
const { credentials } = resolveAuth(profile);

const cwClient  = new CloudWatchLogsClient({ region, credentials });
const ec2Client = new EC2Client({ region, credentials });
const ssmClient = new SSMClient({ region, credentials });

// short env abbreviation — matches CDK naming convention
function shortEnv(e: string): string {
    return e === 'development' ? 'dev' : e === 'staging' ? 'stg' : e === 'production' ? 'prd' : e;
}

// ---------------------------------------------------------------------------
// Phase 1 — During creation: Image Builder logs
// ---------------------------------------------------------------------------
async function phaseDuring(): Promise<void> {
    log.header('Phase 1 — Image Builder Logs (During Creation)');

    // Discover log groups
    const { logGroups = [] } = await cwClient.send(
        new DescribeLogGroupsCommand({ logGroupNamePrefix: '/aws/imagebuilder/' }),
    );

    const k8sGroups = logGroups
        .map(g => g.logGroupName!)
        .filter(n => n.includes(`k8s-${shortEnv(env)}`));

    if (k8sGroups.length === 0) {
        log.warn(`No Image Builder log groups found for /aws/imagebuilder/k8s-${shortEnv(env)}*`);
        log.info('Pipeline has not run yet, or log groups were not created.');
        log.info('All Image Builder log groups in this account:');
        logGroups.forEach(g => log.listItem(g.logGroupName!));
        return;
    }

    log.success(`Found ${k8sGroups.length} log group(s):`);
    k8sGroups.forEach(g => log.listItem(g));
    log.blank();

    if (follow) {
        log.task(`Tailing ${k8sGroups[0]} (Ctrl-C to stop)...`);
        log.blank();
        execShellStream(
            `aws logs tail "${k8sGroups[0]}" --follow --format short --region ${region} --profile ${profile}`,
        );
        return;
    }

    // Show recent errors / warnings from each log group
    const startTime = Date.now() - minutes * 60 * 1000;
    for (const group of k8sGroups) {
        log.task(`Scanning ${group} (last ${minutes} min)...`);

        const { events = [] } = await cwClient.send(
            new FilterLogEventsCommand({
                logGroupName: group,
                startTime,
                filterPattern: '?FATAL ?ERROR ?FAIL ?error ?failed',
                limit: 50,
            }),
        );

        if (events.length === 0) {
            log.success('No errors or failures found.');
        } else {
            log.warn(`${events.length} error/failure event(s):`);
            events.forEach(e => {
                const ts = e.timestamp ? new Date(e.timestamp).toISOString() : '?';
                console.log(`  [${ts}] ${e.message?.trimEnd()}`);
            });
        }
        log.blank();
    }

    log.dim(`Tip: just troubleshoot-ami --mode during --follow   ← tail live`);
}

// ---------------------------------------------------------------------------
// Phase 2 — After creation: SSM parameter + AMI state
// ---------------------------------------------------------------------------
async function phaseAfter(): Promise<void> {
    log.header('Phase 2 — AMI Readiness (After Creation)');

    const ssmPath = `/k8s/${env}/golden-ami/latest`;
    log.task(`Checking SSM parameter: ${ssmPath}`);

    let amiId: string | undefined;
    try {
        const { Parameter } = await ssmClient.send(
            new GetParameterCommand({ Name: ssmPath }),
        );
        amiId = Parameter?.Value;
    } catch (e: unknown) {
        const err = e as Error;
        if (err.name === 'ParameterNotFound') {
            log.error(`SSM parameter not found: ${ssmPath}`);
            log.info('CfnImage writes this after a successful AMI distribution.');
            log.info('If the pipeline just ran, wait 1-2 min and retry.');
        } else {
            log.error(`SSM lookup failed: ${err.message}`);
        }
        return;
    }

    if (!amiId || !amiId.startsWith('ami-')) {
        log.error(`SSM parameter exists but value is invalid: "${amiId}"`);
        return;
    }

    log.success(`AMI ID in SSM: ${amiId}`);

    // Check AMI state
    log.task(`Checking AMI state for ${amiId}...`);
    const { Images = [] } = await ec2Client.send(
        new DescribeImagesCommand({ ImageIds: [amiId] }),
    );

    if (Images.length === 0) {
        log.error(`AMI ${amiId} not found in ${region}. Was it distributed to this region?`);
        return;
    }

    const ami = Images[0]!;
    const state = ami.State ?? 'unknown';
    const name  = ami.Name ?? 'unknown';
    const created = ami.CreationDate ?? 'unknown';

    log.keyValue('Name',    name);
    log.keyValue('State',   state);
    log.keyValue('Created', created);
    log.keyValue('Arch',    ami.Architecture ?? 'unknown');

    if (state === 'available') {
        log.success(`AMI ${amiId} is available and ready.`);
    } else if (state === 'pending') {
        log.warn(`AMI ${amiId} is still pending — snapshot copy in progress. Retry in ~2 min.`);
    } else {
        log.error(`AMI ${amiId} state is "${state}" — not usable.`);
    }
}

// ---------------------------------------------------------------------------
// Phase 3 — ASG readiness: launch template AMI check
// ---------------------------------------------------------------------------
async function phaseAsg(): Promise<void> {
    log.header('Phase 3 — ASG Readiness (Launch Template)');

    // Resolve the expected AMI from SSM
    const ssmPath = `/k8s/${env}/golden-ami/latest`;
    let expectedAmi: string | undefined;
    try {
        const { Parameter } = await ssmClient.send(
            new GetParameterCommand({ Name: ssmPath }),
        );
        expectedAmi = Parameter?.Value;
    } catch {
        log.warn(`Could not read expected AMI from SSM (${ssmPath}). Skipping comparison.`);
    }

    if (expectedAmi) log.keyValue('Expected AMI (SSM)', expectedAmi);

    // Find launch templates matching k8s-{env}-* or k8s-{shortEnv}-*
    const nameFilter = [`k8s-${env}-*`, `k8s-${shortEnv(env)}-*`];
    log.task(`Searching launch templates: ${nameFilter.join(', ')}`);

    const { LaunchTemplates = [] } = await ec2Client.send(
        new DescribeLaunchTemplatesCommand({
            Filters: [{ Name: 'launch-template-name', Values: nameFilter }],
        }),
    );

    if (LaunchTemplates.length === 0) {
        log.warn('No matching launch templates found.');
        log.info('The ASG launch template is created by CloudFormation — has the compute stack been deployed?');
        return;
    }

    log.success(`Found ${LaunchTemplates.length} launch template(s):`);
    log.blank();

    for (const lt of LaunchTemplates) {
        const ltName = lt.LaunchTemplateName!;
        const ltId   = lt.LaunchTemplateId!;
        log.task(`${ltName} (${ltId})`);

        const { LaunchTemplateVersions = [] } = await ec2Client.send(
            new DescribeLaunchTemplateVersionsCommand({
                LaunchTemplateId: ltId,
                Versions: ['$Latest'],
            }),
        );

        if (LaunchTemplateVersions.length === 0) {
            log.warn('No versions found for this launch template.');
            continue;
        }

        const ltv  = LaunchTemplateVersions[0]!;
        const ltAmi = ltv.LaunchTemplateData?.ImageId ?? 'unknown';
        log.keyValue('Launch Template AMI', ltAmi);
        log.keyValue('Version',             String(ltv.VersionNumber));
        log.keyValue('Default',             String(ltv.DefaultVersion));

        if (!expectedAmi) {
            log.dim('(No SSM AMI to compare against)');
        } else if (ltAmi === expectedAmi) {
            log.success('Launch template AMI matches SSM — ASG will use the latest Golden AMI.');
        } else {
            log.warn(`Mismatch: Launch template has ${ltAmi}, SSM has ${expectedAmi}.`);
            log.info('Trigger a CDK deploy or instance refresh to update the ASG.');
        }
        log.blank();
    }

    log.dim('Next: just ssm-bootstrap-status   ← verify SSM Automation ran after instance refresh');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
    log.header(`AMI Troubleshooter — ${env} (${region}, profile: ${profile})`);
    log.blank();

    void awsConfig; // resolved but used via credentials directly

    try {
        if (mode === 'during' || mode === 'all') await phaseDuring();
        if (mode === 'after'  || mode === 'all') await phaseAfter();
        if (mode === 'asg'    || mode === 'all') await phaseAsg();

        if (!['during', 'after', 'asg', 'all'].includes(mode)) {
            log.error(`Unknown mode: "${mode}". Use: during | after | asg | all`);
            process.exit(1);
        }
    } catch (e: unknown) {
        const err = e as Error;
        log.error(`Unexpected error: ${err.message}`);
        if (err.name === 'CredentialsProviderError') {
            log.info(`Check your AWS profile: --profile ${profile}`);
        }
        process.exit(1);
    }
}

main();
