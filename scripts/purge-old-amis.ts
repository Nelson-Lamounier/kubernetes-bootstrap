#!/usr/bin/env npx tsx
/**
 * @format
 * Purge Old Golden AMIs
 *
 * Finds and deregisters Golden AMIs (tagged Purpose=GoldenAMI) that are no
 * longer referenced by any Launch Template version and are not the current
 * AMI published to SSM. Also deletes associated EBS snapshots.
 *
 * Safety rules applied before any deletion:
 *   1. The current SSM AMI (/k8s/{env}/golden-ami/latest) is always kept.
 *   2. Any AMI referenced by an active ASG Launch Template version is kept.
 *   3. Dry-run mode is the default — pass --force to actually delete.
 *   4. The most-recent N AMIs are kept regardless (--keep-count, default 2).
 *
 * Usage:
 *   npx tsx scripts/purge-old-amis.ts                             # dry-run, development
 *   npx tsx scripts/purge-old-amis.ts --env staging               # dry-run, staging
 *   npx tsx scripts/purge-old-amis.ts --force                     # actually delete
 *   npx tsx scripts/purge-old-amis.ts --keep-count 3 --force      # keep 3 newest, delete rest
 *   npx tsx scripts/purge-old-amis.ts --env production --profile prod-account --force
 */

import {
    AutoScalingClient,
    DescribeAutoScalingGroupsCommand,
    paginateDescribeAutoScalingGroups,
} from '@aws-sdk/client-auto-scaling';
import {
    EC2Client,
    DescribeImagesCommand,
    DescribeLaunchTemplatesCommand,
    DescribeLaunchTemplateVersionsCommand,
    DeregisterImageCommand,
    DeleteSnapshotCommand,
    paginateDescribeImages,
} from '@aws-sdk/client-ec2';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

import { buildAwsConfig, parseArgs, resolveAuth } from '@nelsonlamounier/cdk-deploy-scripts/aws.js';
import log from '@nelsonlamounier/cdk-deploy-scripts/logger.js';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = parseArgs(
    [
        { name: 'env',         description: 'Target environment',          hasValue: true,  default: 'development' },
        { name: 'region',      description: 'AWS region',                  hasValue: true,  default: 'eu-west-1' },
        { name: 'profile',     description: 'AWS profile',                 hasValue: true,  default: 'dev-account' },
        { name: 'keep-count',  description: 'Always keep N newest AMIs',   hasValue: true,  default: '2' },
        { name: 'force',       description: 'Actually delete (not dry-run)', hasValue: false, default: false },
    ],
    'Purge old Golden AMIs that are no longer referenced by any Launch Template.',
);

const env        = args['env'] as string;
const region     = args['region'] as string;
const profile    = args['profile'] as string;
const keepCount  = parseInt(args['keep-count'] as string, 10);
const force      = args['force'] as boolean;
const awsConfig  = buildAwsConfig(args);
const { credentials } = resolveAuth(profile);

const SSM_AMI_PATH = `/k8s/${env}/golden-ami/latest`;
const AMI_NAME_PREFIX = `k8s-${env}-golden-ami`;

// ---------------------------------------------------------------------------
// AWS clients
// ---------------------------------------------------------------------------

const ec2 = new EC2Client({ ...awsConfig, credentials });
const ssm = new SSMClient({ ...awsConfig, credentials });
const autoscaling = new AutoScalingClient({ ...awsConfig, credentials });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the current Golden AMI ID from SSM. Returns undefined if not found. */
async function getCurrentSsmAmiId(): Promise<string | undefined> {
    try {
        const { Parameter } = await ssm.send(
            new GetParameterCommand({ Name: SSM_AMI_PATH }),
        );
        return Parameter?.Value;
    } catch {
        return undefined;
    }
}

/** Get all AMI IDs referenced by any version of any Launch Template in this account. */
async function getReferencedAmiIds(): Promise<Set<string>> {
    const referenced = new Set<string>();

    // 1. Get all LT names with the environment prefix
    const { LaunchTemplates } = await ec2.send(
        new DescribeLaunchTemplatesCommand({
            Filters: [{ Name: 'launch-template-name', Values: [`*${env}*`] }],
        }),
    );

    for (const lt of LaunchTemplates ?? []) {
        if (!lt.LaunchTemplateId) continue;

        // 2. For each LT, get ALL versions (not just default) — a rolling ASG
        //    update may still reference an old version during the transition.
        let nextToken: string | undefined;
        do {
            const { LaunchTemplateVersions, NextToken } = await ec2.send(
                new DescribeLaunchTemplateVersionsCommand({
                    LaunchTemplateId: lt.LaunchTemplateId,
                    NextToken: nextToken,
                }),
            );
            for (const v of LaunchTemplateVersions ?? []) {
                const imageId = v.LaunchTemplateData?.ImageId;
                if (imageId) referenced.add(imageId);
            }
            nextToken = NextToken;
        } while (nextToken);
    }

    // 3. Also check ASG active launch template versions (belt-and-suspenders)
    for await (const page of paginateDescribeAutoScalingGroups({ client: autoscaling }, {})) {
        for (const asg of page.AutoScalingGroups ?? []) {
            const ltSpec = asg.LaunchTemplate;
            if (!ltSpec?.LaunchTemplateId || !ltSpec.Version) continue;

            try {
                const { LaunchTemplateVersions } = await ec2.send(
                    new DescribeLaunchTemplateVersionsCommand({
                        LaunchTemplateId: ltSpec.LaunchTemplateId,
                        Versions: [ltSpec.Version],
                    }),
                );
                const imageId = LaunchTemplateVersions?.[0]?.LaunchTemplateData?.ImageId;
                if (imageId) referenced.add(imageId);
            } catch {
                // LT version may no longer exist — ignore
            }
        }
    }

    return referenced;
}

/** Get all Golden AMIs in the account, sorted newest-first (by CreationDate). */
async function getAllGoldenAmis(): Promise<Array<{ imageId: string; name: string; creationDate: string }>> {
    const images: Array<{ imageId: string; name: string; creationDate: string }> = [];

    for await (const page of paginateDescribeImages(
        { client: ec2 },
        {
            Owners: ['self'],
            Filters: [{ Name: 'tag:Purpose', Values: ['GoldenAMI'] }],
        },
    )) {
        for (const img of page.Images ?? []) {
            if (img.ImageId) {
                images.push({
                    imageId: img.ImageId,
                    name: img.Name ?? img.ImageId,
                    creationDate: img.CreationDate ?? '',
                });
            }
        }
    }

    return images.sort((a, b) => b.creationDate.localeCompare(a.creationDate));
}

/** Get all EBS snapshot IDs associated with an AMI's block device mapping. */
async function getAmiSnapshotIds(imageId: string): Promise<string[]> {
    const { Images } = await ec2.send(new DescribeImagesCommand({ ImageIds: [imageId] }));
    return (Images?.[0]?.BlockDeviceMappings ?? [])
        .map((b) => b.Ebs?.SnapshotId)
        .filter((id): id is string => !!id);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    log.info(`Environment : ${env}`);
    log.info(`Region      : ${region}`);
    log.info(`Keep count  : ${keepCount} newest AMIs`);
    log.info(`Mode        : ${force ? 'FORCE DELETE' : 'dry-run (pass --force to delete)'}`);
    log.info('');

    // 1. Gather data
    const [currentSsmAmiId, referencedAmiIds, allAmis] = await Promise.all([
        getCurrentSsmAmiId(),
        getReferencedAmiIds(),
        getAllGoldenAmis(),
    ]);

    if (!currentSsmAmiId) {
        log.warn(`SSM parameter ${SSM_AMI_PATH} not found — no current AMI to protect.`);
    } else {
        log.info(`Current SSM AMI : ${currentSsmAmiId}`);
    }

    log.info(`Total Golden AMIs found : ${allAmis.length}`);
    log.info(`AMI IDs referenced by LT/ASG : ${referencedAmiIds.size}`);
    log.info('');
    log.info('All Golden AMIs (newest first):');
    for (const ami of allAmis) {
        log.info(`  ${ami.imageId}  ${ami.name}  (created ${ami.creationDate})`);
    }
    log.info('');

    if (allAmis.length === 0) {
        log.info('No Golden AMIs found. Nothing to do.');
        return;
    }

    // 2. Classify each AMI
    const toDelete: typeof allAmis = [];
    const toKeep:   typeof allAmis = [];

    for (let i = 0; i < allAmis.length; i++) {
        const ami = allAmis[i];
        const reasons: string[] = [];

        if (ami.imageId === currentSsmAmiId)    reasons.push('current SSM AMI');
        if (referencedAmiIds.has(ami.imageId))  reasons.push('referenced by LT/ASG');
        if (i < keepCount)                      reasons.push(`in newest-${keepCount} window`);

        if (reasons.length > 0) {
            toKeep.push(ami);
            log.info(`  KEEP  ${ami.imageId}  ${ami.name}  [${reasons.join(', ')}]`);
        } else {
            toDelete.push(ami);
            log.info(`  DELETE ${ami.imageId}  ${ami.name}  (created ${ami.creationDate})`);
        }
    }

    log.info('');
    log.info(`Summary: ${toKeep.length} to keep, ${toDelete.length} to delete`);

    if (toDelete.length === 0) {
        log.info('Nothing to delete.');
        return;
    }

    if (!force) {
        log.warn('Dry-run mode — no changes made. Pass --force to delete.');
        return;
    }

    // 3. Deregister AMIs and delete snapshots
    log.info('');
    log.info('Deleting...');

    for (const ami of toDelete) {
        const snapshotIds = await getAmiSnapshotIds(ami.imageId);

        log.info(`  Deregistering ${ami.imageId} (${ami.name})...`);
        await ec2.send(new DeregisterImageCommand({ ImageId: ami.imageId }));

        for (const snapId of snapshotIds) {
            log.info(`    Deleting snapshot ${snapId}...`);
            await ec2.send(new DeleteSnapshotCommand({ SnapshotId: snapId }));
        }

        log.info(`  Done: ${ami.imageId} + ${snapshotIds.length} snapshot(s) deleted`);
    }

    log.info('');
    log.info(`Purge complete. ${toDelete.length} AMI(s) deleted.`);
}

main().catch((err) => {
    log.error(`Purge failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
});
