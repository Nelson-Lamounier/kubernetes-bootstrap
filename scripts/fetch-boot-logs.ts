#!/usr/bin/env npx tsx
/**
 * @format
 * Fetch Boot Logs from CloudWatch
 *
 * Queries the EC2 instance boot log group for recent log events and prints
 * them to the console. Designed for CI/CD failure diagnostics — when a
 * deployment or smoke test fails, this script fetches the last N minutes
 * of boot logs so engineers can see exactly what happened without SSH.
 *
 * The CloudWatch Agent (baked into the Golden AMI) streams three log files:
 *   - /var/log/user-data.log          → {instance_id}/user-data
 *   - /var/log/cloud-init-output.log  → {instance_id}/cloud-init-output
 *   - /var/log/messages               → {instance_id}/syslog
 *
 * Instead of hunting for a specific Instance ID, this script uses
 * FilterLogEventsCommand to query the entire Log Group for events in the
 * last 15 minutes — automatically grabbing logs from whatever instance
 * just tried to boot.
 *
 * Usage:
 *   npx tsx kubernetes-app/k8s-bootstrap/scripts/fetch-boot-logs.ts development
 *   npx tsx kubernetes-app/k8s-bootstrap/scripts/fetch-boot-logs.ts production --region eu-west-1 --minutes 30
 *   npx tsx kubernetes-app/k8s-bootstrap/scripts/fetch-boot-logs.ts development --log-group /ec2/custom/instances
 *
 * Exit codes:
 *   0 = always (diagnostic tool — must never break the pipeline)
 */

import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  type FilteredLogEvent,
} from '@aws-sdk/client-cloudwatch-logs';

import log from '@repo/script-utils/logger.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const environment = args[0];

function getFlag(name: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : '';
}

const region = getFlag('region') || process.env.AWS_REGION || 'eu-west-1';
const minutesBack = parseInt(getFlag('minutes') || '15', 10);
const customLogGroup = getFlag('log-group');

if (!environment) {
  console.error(
    'Usage: fetch-boot-logs.ts <environment> [--region <region>] [--minutes <N>] [--log-group <name>]',
  );
  process.exit(0); // Don't fail the pipeline
}

// ---------------------------------------------------------------------------
// Log group resolution
// ---------------------------------------------------------------------------
const logGroupName = customLogGroup || `/ec2/k8s-${environment}/instances`;

// ---------------------------------------------------------------------------
// CloudWatch client
// ---------------------------------------------------------------------------
const cwClient = new CloudWatchLogsClient({ region });

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatTimestamp(ts: number | undefined): string {
  if (!ts) return '???';
  return new Date(ts).toISOString().replace('T', ' ').replace('Z', '');
}

function getStreamLabel(streamName: string): string {
  const parts = streamName.split('/');
  return parts.length > 1 ? parts.slice(1).join('/') : streamName;
}

function isCI(): boolean {
  return process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  log.header('Fetch EC2 Boot Logs from CloudWatch');
  log.keyValue('Log Group', logGroupName);
  log.keyValue('Region', region);
  log.keyValue('Time Window', `last ${minutesBack} minutes`);
  log.blank();

  const startTime = Date.now() - minutesBack * 60 * 1000;

  try {
    const allEvents: (FilteredLogEvent & { logStreamName: string })[] = [];
    let nextToken: string | undefined;

    do {
      const response = await cwClient.send(
        new FilterLogEventsCommand({
          logGroupName,
          startTime,
          endTime: Date.now(),
          nextToken,
          limit: 1000,
        }),
      );

      if (response.events) {
        for (const event of response.events) {
          allEvents.push({
            ...event,
            logStreamName: event.logStreamName ?? 'unknown',
          });
        }
      }

      nextToken = response.nextToken;
    } while (nextToken);

    if (allEvents.length === 0) {
      log.warn('No log events found in the specified time window.');
      log.info('This could mean:');
      log.listItem('No instance attempted to boot recently');
      log.listItem('The CloudWatch Agent did not start');
      log.listItem(`The log group "${logGroupName}" does not exist yet`);
      return;
    }

    log.success(`Found ${allEvents.length} log events`);
    log.blank();

    const streamMap = new Map<string, FilteredLogEvent[]>();
    for (const event of allEvents) {
      const stream = event.logStreamName ?? 'unknown';
      if (!streamMap.has(stream)) {
        streamMap.set(stream, []);
      }
      streamMap.get(stream)!.push(event);
    }

    for (const [streamName, events] of streamMap) {
      const label = getStreamLabel(streamName);
      const instanceId = streamName.split('/')[0] || 'unknown';

      if (isCI()) {
        console.log(`::group::📋 ${label} (${instanceId}) — ${events.length} events`);
      } else {
        log.header(`${label} (${instanceId}) — ${events.length} events`);
      }

      events.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

      for (const event of events) {
        const ts = formatTimestamp(event.timestamp);
        const msg = event.message?.trimEnd() ?? '';
        console.log(`[${ts}] ${msg}`);
      }

      if (isCI()) {
        console.log('::endgroup::');
      }

      log.blank();
    }

    log.header('Summary');
    log.keyValue('Total Events', String(allEvents.length));
    log.keyValue('Log Streams', String(streamMap.size));
    log.keyValue(
      'Instances',
      [...new Set([...streamMap.keys()].map((s) => s.split('/')[0]))].join(', '),
    );
  } catch (error) {
    const err = error as Error;

    if (err.name === 'ResourceNotFoundException') {
      log.warn(`Log group "${logGroupName}" does not exist.`);
      log.info('This is expected if the compute stack has never been deployed.');
    } else if (err.name === 'AccessDeniedException') {
      log.warn('Access denied — ensure the CI role has logs:FilterLogEvents permission.');
      log.dim(err.message);
    } else {
      log.warn(`Failed to fetch boot logs: ${err.message}`);
      log.dim(err.name ?? 'UnknownError');
    }
  }
}

main().catch((err) => {
  log.error(`Unexpected error: ${err}`);
  process.exit(0);
});
