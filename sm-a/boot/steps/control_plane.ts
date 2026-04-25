#!/usr/bin/env tsx
// @format

/**
 * @module control_plane
 * Control Plane Bootstrap — ten idempotent steps, single file.
 *
 * Migrated from `boot/steps/cp/` (11 Python files, ~2 200 lines).
 * AWS SDK v3 replaces all 15 subprocess AWS CLI calls.
 *
 * **Step sequence:**
 * 0. Mount the EBS data volume (NVMe-aware, ext4, fstab).
 * 1. DR restore from S3 (PKI + etcd snapshot).
 * 2. `kubeadm init` (fresh) or second-run reconstruction.
 * 3. Install Calico CNI via Tigera operator.
 * 4. Install AWS Cloud Controller Manager via Helm.
 * 5. Configure `kubectl` for root / ec2-user / ssm-user.
 * 6. Bootstrap ArgoCD.
 * 7. Verify cluster (nodes + system namespaces + NLB connectivity).
 * 8. Install etcd backup systemd timer.
 * 9. Install kubeadm join-token rotator (12 h).
 *
 * @example
 * ```bash
 * # Direct execution (called by orchestrator.ts)
 * npx tsx boot/steps/control_plane.ts
 *
 * # Dry-run (logs steps without side-effects)
 * npx tsx boot/steps/control_plane.ts --dry-run
 * ```
 */

import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ChangeResourceRecordSetsCommand, Route53Client } from '@aws-sdk/client-route-53';

import {
    ECR_PROVIDER_CONFIG,
    ensureEcrCredentialProvider, error, imds, info, makeRunStep, run,
    ssmGet, ssmPut, validateKubeadmToken, warn, waitUntil,
} from './common.js';

const runStep = makeRunStep('control_plane');

// =============================================================================
// Types
// =============================================================================

/**
 * Immutable runtime configuration for the control-plane bootstrap.
 *
 * Populated once at startup by {@link fromEnv} and threaded through every
 * step function.  All fields have safe defaults suitable for local development
 * so the bootstrap can be exercised without a live cluster.
 */
export interface BootConfig {
    /**
     * SSM Parameter Store key prefix (e.g. `/k8s/development`).
     * All bootstrap parameters, join tokens, and status records live under this prefix.
     */
    readonly ssmPrefix: string;

    /** AWS region for SSM, S3, Route 53, and IMDS calls (e.g. `"eu-west-1"`). */
    readonly awsRegion: string;

    /**
     * Kubernetes version string passed to `kubeadm init --kubernetes-version`.
     * Format: `MAJOR.MINOR.PATCH` (e.g. `"1.35.1"`).
     */
    readonly k8sVersion: string;

    /**
     * Absolute path to the persistent data directory.
     * etcd data and other cluster state are stored here on the EBS volume so
     * they survive instance replacement.
     */
    readonly dataDir: string;

    /**
     * CIDR block for the pod network (e.g. `"192.168.0.0/16"`).
     * Passed to `kubeadm init --pod-network-cidr` and the Calico `Installation` CR.
     */
    readonly podCidr: string;

    /**
     * CIDR block for Kubernetes `Service` objects (e.g. `"10.96.0.0/12"`).
     * Passed to `kubeadm init --service-cidr` and `kubeadm init phase addon coredns`.
     */
    readonly serviceCidr: string;

    /**
     * Route 53 hosted zone ID.  When non-empty, the API server's private IP is
     * upserted into the zone as an `A` record on every bootstrap run.
     */
    readonly hostedZoneId: string;

    /**
     * DNS name registered as the control-plane endpoint (e.g. `"k8s-api.k8s.internal"`).
     * Must be resolvable by worker nodes at join time.
     */
    readonly apiDnsName: string;

    /** S3 bucket used for DR backups (PKI archives) and etcd snapshots. */
    readonly s3Bucket: string;

    /**
     * Mount point for the EBS data volume (e.g. `"/data"`).
     * The bootstrap creates `kubernetes/`, `k8s-bootstrap/`, and `app-deploy/` subdirectories here.
     */
    readonly mountPoint: string;

    /**
     * Calico CNI version to install via the Tigera operator (e.g. `"v3.29.3"`).
     * Used when the pre-cached operator YAML is absent from the golden AMI.
     */
    readonly calicoVersion: string;

    /**
     * Short environment name applied as a node label (e.g. `"development"`, `"production"`).
     * Derived from `ENVIRONMENT` env var, defaulting to `"development"`.
     */
    readonly environment: string;

    /**
     * CloudWatch log group name for bootstrap log forwarding.
     * When empty, log forwarding is skipped.
     */
    readonly logGroupName: string;
}

// =============================================================================
// Constants
// =============================================================================

const ADMIN_CONF       = '/etc/kubernetes/admin.conf';
const SUPER_ADMIN_CONF = '/etc/kubernetes/super-admin.conf';
const KUBECONFIG       = { KUBECONFIG: ADMIN_CONF };
const DR_BACKUP_PREFIX = 'dr-backups';

const DATA_MOUNT_MARKER    = '/etc/kubernetes/.data-mounted';
const DR_RESTORE_MARKER    = '/etc/kubernetes/.dr-restored';
const CALICO_MARKER        = '/etc/kubernetes/.calico-installed';
const CCM_MARKER           = '/etc/kubernetes/.ccm-installed';
const TOKEN_ROTATOR_MARKER = '/etc/systemd/system/kubeadm-token-rotator.timer';

// =============================================================================
// Config
// =============================================================================

/**
 * Reads environment variables and returns an immutable {@link BootConfig}.
 *
 * @remarks
 * All fields have safe defaults for local development:
 *
 * | Env var               | Default                      |
 * |-----------------------|------------------------------|
 * | `SSM_PREFIX`          | `/k8s/development`           |
 * | `AWS_REGION`          | `eu-west-1`                  |
 * | `K8S_VERSION`         | `1.35.1`                     |
 * | `DATA_DIR`            | `/data/kubernetes`           |
 * | `POD_CIDR`            | `192.168.0.0/16`             |
 * | `SERVICE_CIDR`        | `10.96.0.0/12`               |
 * | `HOSTED_ZONE_ID`      | `""` (DNS update skipped)    |
 * | `API_DNS_NAME`        | `k8s-api.k8s.internal`       |
 * | `S3_BUCKET`           | `""` (DR skipped)            |
 * | `MOUNT_POINT`         | `/data`                      |
 * | `CALICO_VERSION`      | `v3.29.3`                    |
 * | `ENVIRONMENT`         | `development`                |
 * | `LOG_GROUP_NAME`      | `""` (log forwarding skipped)|
 *
 * @returns Populated, immutable {@link BootConfig}.
 *
 * @example
 * ```bash
 * SSM_PREFIX=/k8s/production AWS_REGION=eu-west-1 npx tsx control_plane.ts
 * ```
 */
export const fromEnv = (): BootConfig => ({
    ssmPrefix:    process.env.SSM_PREFIX      ?? '/k8s/development',
    awsRegion:    process.env.AWS_REGION      ?? 'eu-west-1',
    k8sVersion:   process.env.K8S_VERSION     ?? '1.35.1',
    dataDir:      process.env.DATA_DIR        ?? '/data/kubernetes',
    podCidr:      process.env.POD_CIDR        ?? '192.168.0.0/16',
    serviceCidr:  process.env.SERVICE_CIDR    ?? '10.96.0.0/12',
    hostedZoneId: process.env.HOSTED_ZONE_ID  ?? '',
    apiDnsName:   process.env.API_DNS_NAME    ?? 'k8s-api.k8s.internal',
    s3Bucket:     process.env.S3_BUCKET       ?? '',
    mountPoint:   process.env.MOUNT_POINT     ?? '/data',
    calicoVersion: process.env.CALICO_VERSION ?? 'v3.29.3',
    environment:  process.env.ENVIRONMENT     ?? 'development',
    logGroupName: process.env.LOG_GROUP_NAME  ?? '',
});

// =============================================================================
// AWS SDK clients — lazy singletons, initialised once cfg.awsRegion is known
// =============================================================================

let _s3:  S3Client      | undefined;
let _r53: Route53Client | undefined;

const s3Client  = (region: string): S3Client      => (_s3  ??= new S3Client({ region }));
const r53Client = (region: string): Route53Client => (_r53 ??= new Route53Client({ region }));

// =============================================================================
// S3 helpers
// =============================================================================

const s3Exists = async (bucket: string, key: string, region: string): Promise<boolean> => {
    try {
        await s3Client(region).send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
    } catch {
        return false;
    }
};

const s3Download = async (bucket: string, key: string, dest: string, region: string): Promise<void> => {
    const response = await s3Client(region).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!response.Body) throw new Error(`S3 GetObject returned no body: s3://${bucket}/${key}`);
    // SDK v3 Body carries transformToByteArray() from the SDK stream mixin
    const body = response.Body as unknown as { transformToByteArray(): Promise<Uint8Array> };
    const bytes = await body.transformToByteArray();
    writeFileSync(dest, Buffer.from(bytes));
};

const s3Upload = async (bucket: string, key: string, src: string, region: string): Promise<void> => {
    await s3Client(region).send(new PutObjectCommand({
        Bucket: bucket, Key: key,
        Body: readFileSync(src),
        ServerSideEncryption: 'AES256',
    }));
};

// =============================================================================
// Route 53
// =============================================================================

const updateDns = async (privateIp: string, cfg: BootConfig): Promise<void> => {
    if (!cfg.hostedZoneId) { warn('HOSTED_ZONE_ID not set — skipping DNS update'); return; }
    info(`Updating DNS: ${cfg.apiDnsName} → ${privateIp}`);
    await r53Client(cfg.awsRegion).send(new ChangeResourceRecordSetsCommand({
        HostedZoneId: cfg.hostedZoneId,
        ChangeBatch: {
            Changes: [{
                Action: 'UPSERT',
                ResourceRecordSet: {
                    Name: cfg.apiDnsName, Type: 'A', TTL: 30,
                    ResourceRecords: [{ Value: privateIp }],
                },
            }],
        },
    }));
    info(`DNS updated: ${cfg.apiDnsName} → ${privateIp}`);
};

const patchProviderID = (kubeconfig: string): void => {
    const instanceId = imds('instance-id');
    const az         = imds('placement/availability-zone');
    const hostname   = imds('hostname');
    if (!instanceId || !az || !hostname) {
        warn('Could not retrieve instance metadata from IMDS — skipping providerID patch');
        return;
    }
    const providerID = `aws:///${az}/${instanceId}`;
    info(`Setting providerID: ${providerID}`);
    const patchResult = run(
        ['kubectl', '--kubeconfig', kubeconfig, 'patch', 'node', hostname,
            '--type', 'merge', '-p', JSON.stringify({ spec: { providerID } })],
        { check: false, quiet: true, env: { KUBECONFIG: kubeconfig } },
    );
    if (!patchResult.ok) {
        warn(`providerID patch skipped — node ${hostname} not yet registered (will retry in configure-kubectl)`);
    }
};

const bootstrapKubeconfigEnv = (): Record<string, string> =>
    existsSync(SUPER_ADMIN_CONF) ? { KUBECONFIG: SUPER_ADMIN_CONF } : KUBECONFIG;

const setupKubeconfigForUser = (user: string, home: string): void => {
    const kubeDir    = `${home}/.kube`;
    const configPath = `${kubeDir}/config`;
    mkdirSync(kubeDir, { recursive: true });
    run(['cp', '-f', ADMIN_CONF, configPath]);
    if (user !== 'root') run(['chown', `${user}:${user}`, configPath], { check: false });
    run(['chmod', '600', configPath]);
    info(`kubeconfig configured for ${user}`);
};

// =============================================================================
// Step 0: Mount data volume (NVMe-aware, ext4, fstab)
// =============================================================================

/**
 * Resolves the EBS data volume block device path.
 *
 * @remarks
 * On older EC2 instance types the volume appears as `/dev/xvdf` (Xen).  On
 * Nitro-based instances (all current-gen types) the NVMe controller enumerates
 * it as `/dev/nvme[1-9]n1` — `nvme0n1` is the root volume, so the first
 * non-root NVMe device is used.  The list is sorted to produce a stable pick
 * when multiple additional volumes are attached.
 *
 * @returns The resolved device path (e.g. `"/dev/nvme1n1"`), or `""` when no
 *          matching device is visible yet (caller should retry).
 *
 * @example
 * ```typescript
 * let device = '';
 * await waitUntil(() => { device = resolveNvmeDevice(); return device !== ''; },
 *     { timeoutMs: 60_000, label: 'data volume block device' });
 * ```
 */
export const resolveNvmeDevice = (): string => {
    if (existsSync('/dev/xvdf')) return '/dev/xvdf';
    const lsResult = run(['ls', '/dev/'], { check: false });
    const devices  = lsResult.stdout.split('\n')
        .map(d => d.trim())
        .filter(d => /^nvme[1-9]n1$/.test(d))
        .sort()
        .map(d => `/dev/${d}`);
    return devices[0] ?? '';
};

/**
 * Creates the standard subdirectory layout under `mountPoint`.
 *
 * @remarks
 * Three directories are created (all `recursive: true` so they are idempotent):
 * - `kubernetes/` — etcd data and kubelet state symlinked here by kubeadm.
 * - `k8s-bootstrap/` — bootstrap scripts and manifests copied from the AMI.
 * - `app-deploy/` — writable by the `ssm-user` group for operator use.
 *
 * The `app-deploy/` directory is group-writable for `ssm-user` so operators can
 * deploy manifests without `sudo`.
 *
 * @param mountPoint - Absolute path to the mounted EBS volume (e.g. `"/data"`).
 *
 * @example
 * ```typescript
 * ensureDataDirectories('/data');
 * // → /data/kubernetes, /data/k8s-bootstrap, /data/app-deploy (g+w, root:ssm-user)
 * ```
 */
export const ensureDataDirectories = (mountPoint: string): void => {
    for (const sub of ['kubernetes', 'k8s-bootstrap', 'app-deploy']) {
        mkdirSync(nodePath.join(mountPoint, sub), { recursive: true });
    }
    const appDeploy = nodePath.join(mountPoint, 'app-deploy');
    run(['chown', '-R', 'root:ssm-user', appDeploy], { check: false });
    run(['chmod', '-R', 'g+w', appDeploy], { check: false });
    info(`Data directories ensured under ${mountPoint}`);
};

const mountDataVolume = async (cfg: BootConfig): Promise<void> => {
    const mountCheck = run(['mountpoint', '-q', cfg.mountPoint], { check: false });
    if (mountCheck.ok) {
        info(`${cfg.mountPoint} is already a mount point — skipping mount`);
        ensureDataDirectories(cfg.mountPoint);
        return;
    }

    let device = '';
    await waitUntil(
        () => { device = resolveNvmeDevice(); return device !== ''; },
        { timeoutMs: 60_000, label: 'data volume block device' },
    );
    if (!device) throw new Error(
        'Data volume block device not found after 60s. Check launch template /dev/xvdf mapping. Run lsblk.',
    );
    info(`Block device appeared: ${device}`);

    const blkid = run(['blkid', '-o', 'value', '-s', 'TYPE', device], { check: false });
    if (blkid.stdout.trim()) {
        info(`Device ${device} already has filesystem: ${blkid.stdout.trim()}`);
    } else {
        info(`No filesystem on ${device} — formatting as ext4`);
        run(['mkfs', '-t', 'ext4', device]);
    }

    mkdirSync(cfg.mountPoint, { recursive: true });
    run(['mount', device, cfg.mountPoint]);

    const fstabPath = '/etc/fstab';
    const fstab = existsSync(fstabPath) ? readFileSync(fstabPath, 'utf8') : '';
    if (!fstab.includes(cfg.mountPoint)) {
        appendFileSync(fstabPath, `${device}  ${cfg.mountPoint}  ext4  defaults,nofail  0  2\n`);
        info(`fstab entry added for ${cfg.mountPoint}`);
    }

    ensureDataDirectories(cfg.mountPoint);
    info(`Data volume mounted: ${device} → ${cfg.mountPoint}`);
};

// =============================================================================
// Step 1: DR restore from S3
// =============================================================================

const restoreCertificates = async (cfg: BootConfig): Promise<boolean> => {
    const key = `${DR_BACKUP_PREFIX}/pki/latest.tar.gz`;
    if (!(await s3Exists(cfg.s3Bucket, key, cfg.awsRegion))) {
        warn('No PKI backup found in S3 — fresh init will generate new certs');
        return false;
    }
    const archivePath = '/tmp/k8s-pki-restore.tar.gz';
    try {
        info(`Downloading PKI backup from s3://${cfg.s3Bucket}/${key}`);
        await s3Download(cfg.s3Bucket, key, archivePath, cfg.awsRegion);
        mkdirSync('/etc/kubernetes/pki', { recursive: true });
        run(['tar', 'xzf', archivePath, '-C', '/etc/kubernetes']);
        info('PKI certificates restored from S3 backup');
        return true;
    } catch (e) {
        error(`Certificate restore failed: ${e}`);
        return false;
    } finally {
        if (existsSync(archivePath)) unlinkSync(archivePath);
    }
};

const restoreEtcdSnapshot = async (cfg: BootConfig): Promise<boolean> => {
    const key = `${DR_BACKUP_PREFIX}/etcd/latest.db`;
    if (!(await s3Exists(cfg.s3Bucket, key, cfg.awsRegion))) {
        warn('No etcd backup found in S3 — fresh init will start empty');
        return false;
    }
    const snapshotPath = '/tmp/etcd-restore.db';
    const etcdDataDir  = `${cfg.dataDir}/etcd`;
    try {
        info(`Downloading etcd snapshot from s3://${cfg.s3Bucket}/${key}`);
        await s3Download(cfg.s3Bucket, key, snapshotPath, cfg.awsRegion);
        info(`Restoring etcd snapshot to ${etcdDataDir}`);
        run(
            ['etcdctl', 'snapshot', 'restore', snapshotPath, '--data-dir', etcdDataDir, '--skip-hash-check'],
            { env: { ETCDCTL_API: '3' } },
        );
        info(`etcd snapshot restored to ${etcdDataDir}`);
        return true;
    } catch (e) {
        error(`etcd restore failed: ${e}`);
        run(['rm', '-rf', etcdDataDir], { check: false });
        return false;
    } finally {
        if (existsSync(snapshotPath)) unlinkSync(snapshotPath);
    }
};

const drRestore = async (cfg: BootConfig): Promise<void> => {
    if (existsSync(ADMIN_CONF)) {
        info('admin.conf exists — EBS volume has data, skipping DR restore');
        return;
    }
    if (!cfg.s3Bucket) {
        warn('S3_BUCKET not set — cannot check for backups');
        return;
    }
    info('EBS volume appears empty — checking S3 for DR backups...');
    const certsRestored = await restoreCertificates(cfg);
    const etcdRestored  = await restoreEtcdSnapshot(cfg);
    info(`DR restore: certs=${certsRestored ? 'restored' : 'not found'}, etcd=${etcdRestored ? 'restored' : 'not found'}`);
};

// =============================================================================
// Step 2: kubeadm init / second-run reconstruction
// =============================================================================

const APISERVER_MANIFEST = '/etc/kubernetes/manifests/kube-apiserver.yaml';

const patchApiserverResources = (): void => {
    if (!existsSync(APISERVER_MANIFEST)) { warn('kube-apiserver manifest not found — skipping resource patch'); return; }
    const content = readFileSync(APISERVER_MANIFEST, 'utf8');
    if (content.includes('resources:')) { info('kube-apiserver manifest already has resource requests — skipping'); return; }
    const resourcesBlock =
        '        resources:\n' +
        '          requests:\n' +
        '            cpu: 250m\n' +
        '            memory: 512Mi\n';
    const patched = content.replace(/(\s+image:\s+[^\n]+kube-apiserver[^\n]+\n)/, `$1${resourcesBlock}`);
    if (patched === content) { warn('kube-apiserver resource patch: image line not found — skipping'); return; }
    writeFileSync(APISERVER_MANIFEST, patched);
    info('kube-apiserver manifest patched: requests cpu=250m memory=512Mi');
};

const labelControlPlaneNode = (cfg: BootConfig): void => {
    const nodeResult = run(
        ['kubectl', 'get', 'nodes', '-l', 'node-role.kubernetes.io/control-plane=',
            '-o', 'jsonpath={.items[0].metadata.name}'],
        { check: false, env: KUBECONFIG },
    );
    const nodeName = nodeResult.stdout.trim();
    if (!nodeName) { warn('Could not resolve control plane node name — skipping labels'); return; }
    run(
        ['kubectl', 'label', 'node', nodeName, '--overwrite',
            'node-pool=control-plane', 'workload=control-plane', `environment=${cfg.environment}`],
        { check: false, env: KUBECONFIG },
    );
    info(`Control plane node labelled: node-pool=control-plane, environment=${cfg.environment}`);
};

const publishKubeconfigToSsm = async (cfg: BootConfig): Promise<void> => {
    if (!existsSync(ADMIN_CONF)) { warn('admin.conf not found — skipping kubeconfig publish'); return; }
    const kubeconfig = readFileSync(ADMIN_CONF, 'utf8');
    const tunnelKubeconfig = kubeconfig.replace(/server:\s*https?:\/\/[^:]+:6443/, 'server: https://127.0.0.1:6443');
    await ssmPut(`${cfg.ssmPrefix}/kubeconfig`, tunnelKubeconfig, cfg.awsRegion, 'SecureString', 'Advanced');
    info(`Tunnel-ready kubeconfig published to SSM: ${cfg.ssmPrefix}/kubeconfig`);
};

const backupCertificates = async (cfg: BootConfig): Promise<void> => {
    if (!cfg.s3Bucket) { warn('S3_BUCKET not set — skipping cert backup'); return; }
    if (!existsSync('/etc/kubernetes/pki')) { warn('PKI directory not found — skipping cert backup'); return; }
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19);
    const archivePath = `/tmp/k8s-pki-${ts}.tar.gz`;
    try {
        const paths = ['pki'];
        if (existsSync(ADMIN_CONF)) paths.push('admin.conf');
        if (existsSync(SUPER_ADMIN_CONF)) paths.push('super-admin.conf');
        run(['tar', 'czf', archivePath, '-C', '/etc/kubernetes', ...paths]);
        await s3Upload(cfg.s3Bucket, `${DR_BACKUP_PREFIX}/pki/${ts}.tar.gz`, archivePath, cfg.awsRegion);
        await s3Upload(cfg.s3Bucket, `${DR_BACKUP_PREFIX}/pki/latest.tar.gz`, archivePath, cfg.awsRegion);
        info(`PKI backed up to s3://${cfg.s3Bucket}/${DR_BACKUP_PREFIX}/pki/${ts}.tar.gz`);
    } catch (e) {
        error(`Certificate backup failed: ${e}`);
        warn('Continuing bootstrap — backup failure is non-fatal');
    } finally {
        if (existsSync(archivePath)) unlinkSync(archivePath);
    }
};

const publishSsmParams = async (
    privateIp: string, publicIp: string, instanceId: string, cfg: BootConfig,
): Promise<void> => {
    info('Publishing cluster credentials to SSM...');
    const tokenResult = run(['kubeadm', 'token', 'create', '--ttl', '0'], { env: KUBECONFIG });
    const joinToken = validateKubeadmToken(tokenResult.stdout.trim(), 'kubeadm token create');

    // Shell pipe needed: openssl x509 | openssl rsa | openssl dgst | awk — no single-binary equivalent
    const caHash = run(
        ['/bin/sh', '-c',
            "openssl x509 -pubkey -in /etc/kubernetes/pki/ca.crt | openssl rsa -pubin -outform der 2>/dev/null | openssl dgst -sha256 -hex | awk '{print $2}'"],
    ).stdout.trim();

    await Promise.all([
        ssmPut(`${cfg.ssmPrefix}/join-token`, joinToken, cfg.awsRegion, 'SecureString'),
        ssmPut(`${cfg.ssmPrefix}/ca-hash`, `sha256:${caHash}`, cfg.awsRegion),
        ssmPut(`${cfg.ssmPrefix}/control-plane-endpoint`, `${cfg.apiDnsName}:6443`, cfg.awsRegion),
        ssmPut(`${cfg.ssmPrefix}/instance-id`, instanceId, cfg.awsRegion),
    ]);
    info('Cluster credentials published to SSM');
};

/**
 * Ensures the `cluster-info` ConfigMap and related bootstrap resources exist.
 *
 * @remarks
 * After a DR restore or an etcd compaction, the `cluster-info` ConfigMap in
 * `kube-public` can be absent, which prevents new workers from joining.  This
 * function checks for its presence and re-runs the relevant `kubeadm init`
 * phases if it is missing:
 * - `upload-config kubeadm` — writes the kubeadm config into `kube-system`.
 * - `upload-config kubelet` — writes kubelet config.
 * - `bootstrap-token` — recreates `cluster-info`, RBAC, and bootstrap token secrets.
 *
 * @example
 * ```typescript
 * ensureBootstrapToken();
 * // If cluster-info was missing: re-runs three kubeadm phases and logs restoration.
 * // If present: logs "cluster-info ConfigMap present" and returns immediately.
 * ```
 */
export const ensureBootstrapToken = (): void => {
    const check = run(
        ['kubectl', 'get', 'configmap', 'cluster-info', '-n', 'kube-public'],
        { check: false, env: KUBECONFIG },
    );
    if (check.ok && check.stdout.includes('cluster-info')) { info('cluster-info ConfigMap present'); return; }
    warn('cluster-info ConfigMap MISSING — restoring bootstrap resources');
    run(['kubeadm', 'init', 'phase', 'upload-config', 'kubeadm']);
    run(['kubeadm', 'init', 'phase', 'upload-config', 'kubelet']);
    run(['kubeadm', 'init', 'phase', 'bootstrap-token']);
    info('Bootstrap resources restored (cluster-info, kubeadm-config, kubelet-config, RBAC)');
};

/**
 * Ensures the `kube-proxy` DaemonSet is present in `kube-system`.
 *
 * @remarks
 * After a DR restore from an etcd snapshot taken before kube-proxy was
 * deployed, or after etcd data loss, the DaemonSet can be absent.  This
 * function deploys it via `kubeadm init phase addon kube-proxy` when missing.
 *
 * After deployment, it waits up to 60 s for at least one pod to reach
 * `Running` state before returning.
 *
 * @param cfg - Bootstrap config supplying `awsRegion`, `podCidr`, and `ssmPrefix`.
 * @throws {Error} When the private IP cannot be retrieved from IMDS (required
 *                 for the `--apiserver-advertise-address` flag).
 *
 * @example
 * ```typescript
 * await ensureKubeProxy(cfg);
 * // If DaemonSet missing: deploys via kubeadm + waits for Running.
 * // If present: logs "kube-proxy DaemonSet present" and returns.
 * ```
 */
export const ensureKubeProxy = async (cfg: BootConfig): Promise<void> => {
    const check = run(
        ['kubectl', 'get', 'daemonset', 'kube-proxy', '-n', 'kube-system'],
        { check: false, env: KUBECONFIG },
    );
    if (check.ok && check.stdout.includes('kube-proxy')) { info('kube-proxy DaemonSet present'); return; }
    warn('kube-proxy DaemonSet MISSING — deploying via kubeadm init phase');
    const privateIp = imds('local-ipv4');
    if (!privateIp) throw new Error('Cannot deploy kube-proxy: failed to retrieve private IP from IMDS');
    run(['kubeadm', 'init', 'phase', 'addon', 'kube-proxy',
        `--apiserver-advertise-address=${privateIp}`, `--pod-network-cidr=${cfg.podCidr}`]);
    await waitUntil(
        () => run(['kubectl', 'get', 'pods', '-n', 'kube-system', '-l', 'k8s-app=kube-proxy', '--no-headers'],
            { check: false, env: KUBECONFIG }).stdout.includes('Running'),
        { timeoutMs: 60_000, label: 'kube-proxy Running' },
    );
};

/**
 * Ensures the CoreDNS deployment is present in `kube-system`.
 *
 * @remarks
 * Same failure mode as {@link ensureKubeProxy}: a DR restore from a snapshot
 * taken before CoreDNS was deployed leaves the cluster without in-cluster DNS.
 * This function re-deploys it via `kubeadm init phase addon coredns` when missing.
 *
 * Unlike `ensureKubeProxy`, this is synchronous — `kubeadm init phase addon coredns`
 * blocks until the deployment is created (not until pods are running).
 *
 * @param cfg - Bootstrap config supplying `serviceCidr`.
 *
 * @example
 * ```typescript
 * ensureCoreDns(cfg);
 * // If deployment missing: re-deploys via kubeadm and logs restoration.
 * // If present: logs "CoreDNS deployment present" and returns.
 * ```
 */
export const ensureCoreDns = (cfg: BootConfig): void => {
    const check = run(
        ['kubectl', 'get', 'deployment', 'coredns', '-n', 'kube-system'],
        { check: false, env: KUBECONFIG },
    );
    if (check.ok && check.stdout.includes('coredns')) { info('CoreDNS deployment present'); return; }
    warn('CoreDNS MISSING — deploying via kubeadm init phase');
    run(['kubeadm', 'init', 'phase', 'addon', 'coredns', `--service-cidr=${cfg.serviceCidr}`]);
};

const reconstructControlPlane = async (cfg: BootConfig, privateIp: string): Promise<void> => {
    info('=== Reconstructing control plane from restored PKI ===');
    run(['systemctl', 'start', 'containerd']);
    ensureEcrCredentialProvider();

    mkdirSync('/etc/sysconfig', { recursive: true });
    writeFileSync('/etc/sysconfig/kubelet',
        `KUBELET_EXTRA_ARGS=--cloud-provider=external --node-ip=${privateIp}` +
        ` --image-credential-provider-config=${ECR_PROVIDER_CONFIG}` +
        ' --image-credential-provider-bin-dir=/usr/local/bin\n',
    );

    await updateDns(privateIp, cfg);

    const apiEndpoint = `${cfg.apiDnsName}:6443`;
    run(['kubeadm', 'init', 'phase', 'kubeconfig', 'all', `--control-plane-endpoint=${apiEndpoint}`]);
    run(['kubeadm', 'init', 'phase', 'kubelet-start',
        `--node-name=${run(['hostname', '-f'], { check: false }).stdout.trim()}`], { check: false });
    run(['kubeadm', 'init', 'phase', 'control-plane', 'all',
        `--control-plane-endpoint=${apiEndpoint}`, `--kubernetes-version=${cfg.k8sVersion}`]);
    patchApiserverResources();
    run(['kubeadm', 'init', 'phase', 'etcd', 'local']);
    run(['systemctl', 'restart', 'kubelet']);

    await waitUntil(
        () => run(['kubectl', 'get', '--raw', '/healthz'],
            { check: false, env: bootstrapKubeconfigEnv() }).stdout.toLowerCase().includes('ok'),
        { timeoutMs: 90_000, label: 'API server /healthz' },
    );

    mkdirSync('/root/.kube', { recursive: true });
    run(['cp', '-f', ADMIN_CONF, '/root/.kube/config']);
    run(['chmod', '600', '/root/.kube/config']);
    if (existsSync(SUPER_ADMIN_CONF)) {
        run(['cp', '-f', SUPER_ADMIN_CONF, '/root/.kube/super-admin.conf']);
        run(['chmod', '600', '/root/.kube/super-admin.conf']);
    }
    info('=== Control plane reconstruction complete ===');
};

/**
 * Ensures the `kubeadm-config` ConfigMap in kube-system contains the
 * cluster's `networking.podSubnet`.
 *
 * @remarks
 * After a DR restore, the kubeadm-config ConfigMap can carry an incomplete
 * ClusterConfiguration that omits `networking.podSubnet`. The Tigera operator's
 * IPPool controller reads this field to cross-validate the Installation CR's
 * `spec.calicoNetwork.ipPools[].cidr`. If absent, the controller fails with:
 *
 *     Could not resolve CalicoNetwork IPPool and kubeadm configuration:
 *     kubeadm configuration is missing required podSubnet field
 *
 * and the operator never schedules calico-system pods. This function checks
 * the CM and re-uploads a complete ClusterConfiguration via
 * `kubeadm init phase upload-config kubeadm --config <file>` when needed.
 */
const ensureKubeadmConfigComplete = (cfg: BootConfig): void => {
    const check = run(
        ['/bin/sh', '-c',
            `kubectl get cm kubeadm-config -n kube-system -o jsonpath='{.data.ClusterConfiguration}' | grep -q 'podSubnet: ${cfg.podCidr}'`],
        { check: false, quiet: true, env: KUBECONFIG },
    );
    if (check.ok) {
        info(`kubeadm-config already has podSubnet=${cfg.podCidr}`);
        return;
    }
    warn('kubeadm-config missing podSubnet — re-uploading complete ClusterConfiguration');
    const tmpConfig = '/tmp/kubeadm-uploadcfg.yaml';
    writeFileSync(tmpConfig, [
        'apiVersion: kubeadm.k8s.io/v1beta3',
        'kind: ClusterConfiguration',
        `kubernetesVersion: v${cfg.k8sVersion}`,
        'networking:',
        `  podSubnet: ${cfg.podCidr}`,
        `  serviceSubnet: ${cfg.serviceCidr}`,
        `controlPlaneEndpoint: ${cfg.apiDnsName}:6443`,
        '',
    ].join('\n'));
    run(['kubeadm', 'init', 'phase', 'upload-config', 'kubeadm', '--config', tmpConfig]);
    info(`kubeadm-config re-uploaded with podSubnet=${cfg.podCidr}`);
};

/**
 * Ensures the apiserver TLS cert SANs include the current instance's private IP.
 *
 * @remarks
 * After a DR restore, `/etc/kubernetes/pki/apiserver.crt` is the cert from the
 * previous instance — its IP SANs are stale. The static-pod kube-apiserver
 * still serves on the current IP via `--advertise-address`, but the cert it
 * presents lists only the OLD private/public IPs. Kubelet's node-registration
 * POST goes directly to `https://<currentIP>:6443/api/v1/nodes` and fails TLS
 * verification, so the node never registers and Calico never schedules.
 *
 * Detection: `openssl x509 -text` includes the current private IP in the
 * Subject Alternative Names. If absent, we regenerate the cert via
 * `kubeadm init phase certs apiserver`, then kill the running api-server
 * container (crictl) so kubelet recreates the static pod with the new cert.
 *
 * @param cfg - Bootstrap config (DNS name, region).
 * @param privateIp - Current instance private IP from IMDS.
 */
const ensureApiserverCertCurrent = async (cfg: BootConfig, privateIp: string): Promise<void> => {
    const isApiserverRunning = (): boolean =>
        run(['kubectl', 'get', '--raw', '/healthz'], { check: false, env: bootstrapKubeconfigEnv() })
            .stdout.toLowerCase().includes('ok');

    const certPath = '/etc/kubernetes/pki/apiserver.crt';
    const keyPath  = '/etc/kubernetes/pki/apiserver.key';
    if (!existsSync(certPath)) { warn(`${certPath} missing — skipping cert SAN check`); return; }

    const sanCheck = run(
        ['/bin/sh', '-c', `openssl x509 -noout -text -in ${certPath} | grep -E '^[[:space:]]*X509v3 Subject Alternative Name' -A1 | tail -1`],
        { check: false },
    );
    const sans = sanCheck.stdout.trim();
    info(`apiserver cert SANs: ${sans || '(none parsed)'}`);

    if (sans.includes(privateIp)) {
        info(`apiserver cert SANs already include ${privateIp} — no regeneration needed`);
        return;
    }

    warn(`apiserver cert SANs do NOT include current private IP ${privateIp} — regenerating (likely stale from DR restore)`);

    const publicIp = imds('public-ipv4');
    const extraSans = ['127.0.0.1', privateIp, cfg.apiDnsName, ...(publicIp ? [publicIp] : [])].join(',');

    unlinkSync(certPath);
    unlinkSync(keyPath);
    info(`Removed stale ${certPath} + ${keyPath}`);

    run(['kubeadm', 'init', 'phase', 'certs', 'apiserver',
        `--apiserver-cert-extra-sans=${extraSans}`,
        `--apiserver-advertise-address=${privateIp}`]);
    info(`Regenerated apiserver cert with SANs: ${extraSans}`);

    // Kill the running api-server container so kubelet recreates the static
    // pod and the new container loads the regenerated cert. The old container
    // has the cert open in memory and will keep serving the stale one until
    // restart.
    run(
        ['/bin/sh', '-c', 'crictl ps -q --name kube-apiserver | xargs -r crictl rm -f'],
        { check: false },
    );
    info('Killed kube-apiserver container — kubelet will recreate static pod with new cert');

    // Restart kubelet too so it (a) recreates the static pod immediately, and
    // (b) resets its own node-registration backoff so the next POST /nodes
    // happens fast against the now-valid cert.
    run(['systemctl', 'restart', 'kubelet'], { check: false });

    await waitUntil(isApiserverRunning, { timeoutMs: 180_000, label: 'API server back up with new cert' });
    info('API server healthy with regenerated cert');

    // Give kubelet 15 s to register, then dump diagnostics either way so
    // CloudWatch shows whether the fix worked or further investigation is needed.
    await new Promise<void>(r => setTimeout(r, 15_000));
    const nodeList = run(
        ['kubectl', 'get', 'nodes', '-o', 'wide', '--no-headers'],
        { check: false, env: KUBECONFIG },
    );
    info(`Registered nodes after cert regeneration: ${nodeList.stdout.trim() || '(none)'}`);
};

const handleSecondRun = async (cfg: BootConfig): Promise<void> => {
    info('Cluster already initialised — running second-run maintenance');
    const privateIp = imds('local-ipv4');
    if (!privateIp) throw new Error('Failed to retrieve private IP from IMDS');

    const isApiserverRunning = (): boolean =>
        run(['kubectl', 'get', '--raw', '/healthz'], { check: false, env: bootstrapKubeconfigEnv() })
            .stdout.toLowerCase().includes('ok');

    if (!existsSync(APISERVER_MANIFEST) || !isApiserverRunning()) {
        info('Manifests missing or API server not responding — reconstructing control plane...');
        await reconstructControlPlane(cfg, privateIp);
    } else {
        info('API server already running — checking apiserver cert SANs against current IP');
        await updateDns(privateIp, cfg);
        await ensureApiserverCertCurrent(cfg, privateIp);
    }

    await ssmPut(`${cfg.ssmPrefix}/control-plane-endpoint`, `${cfg.apiDnsName}:6443`, cfg.awsRegion);

    const ssmUserCheck = run(['id', 'ssm-user'], { check: false, quiet: true });
    if (ssmUserCheck.ok) setupKubeconfigForUser('ssm-user', '/home/ssm-user');

    await publishKubeconfigToSsm(cfg);
    ensureBootstrapToken();
    ensureKubeadmConfigComplete(cfg);
    await ensureKubeProxy(cfg);
    ensureCoreDns(cfg);

    // RBAC repair — handles post-DR Forbidden case
    const adminCheck = run(['kubectl', 'get', 'nodes'], { check: false, env: { KUBECONFIG: ADMIN_CONF } });
    if (!adminCheck.ok && (adminCheck.stderr + adminCheck.stdout).includes('Forbidden')) {
        warn('admin.conf returned 403 Forbidden — repairing kubeadm:cluster-admins binding');
        run(['kubectl', 'apply', '-f', '-'], {
            input: [
                'apiVersion: rbac.authorization.k8s.io/v1',
                'kind: ClusterRoleBinding',
                'metadata:',
                '  name: kubeadm:cluster-admins',
                'roleRef:',
                '  apiGroup: rbac.authorization.k8s.io',
                '  kind: ClusterRole',
                '  name: cluster-admin',
                'subjects:',
                '- apiGroup: rbac.authorization.k8s.io',
                '  kind: User',
                '  name: kubernetes-admin',
            ].join('\n'),
            check: true,
            env: bootstrapKubeconfigEnv(),
        });
        info('RBAC binding kubeadm:cluster-admins repaired');
    }

    // Remove node objects from the previous instance incarnation that were
    // restored into etcd by dr-restore. Without cleanup, stale nodes linger
    // as NotReady and can mislead labelControlPlaneNode into labelling the
    // wrong node on the next boot.
    const currentHostname = imds('hostname') ?? '';
    if (currentHostname) {
        const staleResult = run(
            ['kubectl', 'get', 'nodes', '-l', 'node-role.kubernetes.io/control-plane=',
                '--no-headers', '-o', 'custom-columns=NAME:.metadata.name'],
            { check: false, env: KUBECONFIG },
        );
        for (const nodeName of staleResult.stdout.trim().split('\n').filter(Boolean)) {
            if (nodeName !== currentHostname) {
                warn(`Removing stale control-plane node from previous incarnation: ${nodeName}`);
                run(['kubectl', 'delete', 'node', nodeName, '--ignore-not-found'],
                    { check: false, env: KUBECONFIG });
            }
        }
    }

    patchProviderID('/root/.kube/config');
    info('Second-run maintenance complete');
    labelControlPlaneNode(cfg);
};

const initCluster = async (cfg: BootConfig): Promise<void> => {
    info(`Initialising kubeadm cluster (v${cfg.k8sVersion})`);
    mkdirSync(cfg.dataDir, { recursive: true });
    run(['systemctl', 'start', 'containerd']);
    ensureEcrCredentialProvider();

    const privateIp  = imds('local-ipv4');
    if (!privateIp) throw new Error('Failed to retrieve private IP from IMDS');
    const publicIp   = imds('public-ipv4');
    const instanceId = imds('instance-id');

    mkdirSync('/etc/sysconfig', { recursive: true });
    writeFileSync('/etc/sysconfig/kubelet',
        `KUBELET_EXTRA_ARGS=--cloud-provider=external --node-ip=${privateIp}` +
        ` --image-credential-provider-config=${ECR_PROVIDER_CONFIG}` +
        ' --image-credential-provider-bin-dir=/usr/local/bin\n',
    );

    await updateDns(privateIp, cfg);

    // Remove stale apiserver certs — they embed the old instance IP
    for (const p of ['/etc/kubernetes/pki/apiserver.crt', '/etc/kubernetes/pki/apiserver.key']) {
        if (existsSync(p)) { unlinkSync(p); info(`Removed stale cert for regeneration: ${p}`); }
    }

    const apiEndpoint = `${cfg.apiDnsName}:6443`;
    const sans = ['127.0.0.1', privateIp, cfg.apiDnsName, ...(publicIp ? [publicIp] : [])].join(',');
    run([
        'kubeadm', 'init',
        `--kubernetes-version=${cfg.k8sVersion}`,
        `--pod-network-cidr=${cfg.podCidr}`,
        `--service-cidr=${cfg.serviceCidr}`,
        `--control-plane-endpoint=${apiEndpoint}`,
        `--apiserver-cert-extra-sans=${sans}`,
        '--upload-certs',
    ], { capture: false, timeout: 300_000 });

    setupKubeconfigForUser('root', '/root');
    const ssmUserCheck = run(['id', 'ssm-user'], { check: false, quiet: true });
    if (ssmUserCheck.ok) setupKubeconfigForUser('ssm-user', '/home/ssm-user');

    await waitUntil(
        () => run(['kubectl', 'get', 'nodes'], { check: false, env: KUBECONFIG }).ok,
        { timeoutMs: 90_000, label: 'control plane nodes ready' },
    );

    labelControlPlaneNode(cfg);
    patchProviderID('/root/.kube/config');
    patchApiserverResources();
    await publishSsmParams(privateIp, publicIp, instanceId, cfg);
    await publishKubeconfigToSsm(cfg);
    await backupCertificates(cfg);
    info(`kubeadm init complete: v${cfg.k8sVersion}, pod-cidr=${cfg.podCidr}`);
};

// init-kubeadm step has no marker — initOrReconstruct branches internally
// based on whether admin.conf exists (fresh init vs. second-run maintenance)
const initOrReconstruct = async (cfg: BootConfig): Promise<void> => {
    if (existsSync(ADMIN_CONF)) {
        await handleSecondRun(cfg);
    } else {
        await initCluster(cfg);
    }
};

// =============================================================================
// Step 3: Install Calico CNI via Tigera operator
// =============================================================================

const CACHED_CALICO_OPERATOR = '/opt/calico/tigera-operator.yaml';
const CALICO_PDB_MANIFEST    = '/opt/k8s-bootstrap/gitops/calico-pdbs.yaml';

const calicoInstallationYaml = (podCidr: string): string => `\
apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  calicoNetwork:
    bgp: Disabled
    ipPools:
      - cidr: ${podCidr}
        encapsulation: VXLAN
        natOutgoing: Enabled
        nodeSelector: all()
    linuxDataplane: Iptables
  calicoNodeDaemonSet:
    spec:
      template:
        spec:
          containers:
            - name: calico-node
              resources:
                requests:
                  cpu: "25m"
                  memory: "160Mi"
`;

const installCalico = async (cfg: BootConfig): Promise<void> => {
    // On a second-run/dr-restore the kubelet re-registers after the API server
    // restarts, which can take 60–120 s. tigera-operator can only schedule once
    // a node is available, so we must wait before applying Calico resources.
    const hostname = imds('hostname');
    if (hostname) {
        await waitUntil(
            () => run(['kubectl', 'get', 'node', hostname],
                { check: false, quiet: true, env: KUBECONFIG }).ok,
            { timeoutMs: 180_000, label: `node ${hostname} registered` },
        );
    }

    // On a second-run/dr-restore the calico-system namespace contains pods
    // tied to the previous instance (old node refs, old IPs) — these get
    // stuck Terminating and block the operator from rebuilding. Force-clean
    // the existing Installation CR + any stuck pods so the operator starts
    // from a clean slate. Idempotent: no-op on a true fresh install.
    const installationExists = run(
        ['kubectl', 'get', 'installation', 'default'],
        { check: false, quiet: true, env: KUBECONFIG },
    ).ok;
    if (installationExists) {
        warn('Existing Calico Installation CR found — force-cleaning calico-system for clean rebuild (likely DR stale state)');
        run(['kubectl', 'delete', 'installation', 'default',
            '--ignore-not-found', '--timeout=30s'],
            { check: false, env: KUBECONFIG });
        run(['kubectl', 'delete', 'pods', '--all', '-n', 'calico-system',
            '--grace-period=0', '--force', '--ignore-not-found'],
            { check: false, env: KUBECONFIG });
        // Restart the operator pod itself. The tigera-operator may have been
        // running from the previous incarnation and is holding stale internal
        // reconciliation state — without restarting it, the freshly-applied
        // Installation CR below is acknowledged but no calico-system pods
        // ever get created.
        run(['kubectl', 'rollout', 'restart', 'deployment/tigera-operator',
            '-n', 'tigera-operator'], { check: false, env: KUBECONFIG });
        run(['kubectl', 'rollout', 'status', 'deployment/tigera-operator',
            '-n', 'tigera-operator', '--timeout=120s'],
            { check: false, env: KUBECONFIG });
        // Brief pause so the freshly-restarted operator finishes initial reconcile
        await new Promise<void>(r => setTimeout(r, 5_000));
    }

    const source = existsSync(CACHED_CALICO_OPERATOR)
        ? CACHED_CALICO_OPERATOR
        : `https://raw.githubusercontent.com/projectcalico/calico/${cfg.calicoVersion}/manifests/tigera-operator.yaml`;
    if (!existsSync(CACHED_CALICO_OPERATOR)) warn('Pre-cached operator not found — downloading from GitHub');

    run(['kubectl', 'apply', '--server-side', '--force-conflicts', '-f', source], { env: KUBECONFIG });

    // Tigera operator uses ClusterIP (10.96.0.1) by default to reach the API server.
    // On a fresh node the pod network doesn't exist yet — tell it to use the node IP directly.
    const privateIp = imds('local-ipv4');
    if (privateIp) {
        run(['kubectl', 'apply', '-f', '-'], {
            input: [
                'apiVersion: v1',
                'kind: ConfigMap',
                'metadata:',
                '  name: kubernetes-services-endpoint',
                '  namespace: tigera-operator',
                'data:',
                `  KUBERNETES_SERVICE_HOST: "${privateIp}"`,
                '  KUBERNETES_SERVICE_PORT: "6443"',
            ].join('\n'),
            env: KUBECONFIG,
        });
    }

    run(['kubectl', 'wait', '--for=condition=Available', 'deployment/tigera-operator',
        '-n', 'tigera-operator', '--timeout=180s'], { check: false, env: KUBECONFIG });

    run(['kubectl', 'apply', '-f', '-'], {
        input: calicoInstallationYaml(cfg.podCidr),
        env: KUBECONFIG,
    });

    // Wait only for the calico-node DaemonSet to be Ready (numberReady ==
    // desiredNumberScheduled). calico-node is what provides CNI and makes
    // the node Ready, which then lets calico-kube-controllers and
    // csi-node-driver schedule. Waiting for those secondary pods would
    // create a circular wait — they can't reach Running phase until
    // calico-node is up, but waiting on `everything Running` means we
    // block on them.
    let lastDsState = '';
    let lastDiagnosticAt = 0;
    const calicoWaitStart = Date.now();
    await waitUntil(
        () => {
            const r = run(
                ['kubectl', 'get', 'ds', 'calico-node', '-n', 'calico-system',
                    '-o', 'jsonpath={.status.desiredNumberScheduled} {.status.numberReady} {.status.numberAvailable}'],
                { check: false, quiet: true, env: KUBECONFIG },
            );
            const parts = r.ok ? r.stdout.trim().split(/\s+/) : [];
            const [desired, ready, available] = [parts[0] ?? '0', parts[1] ?? '0', parts[2] ?? '0'];
            const state = `desired=${desired} ready=${ready} available=${available}`;
            if (state !== lastDsState) {
                info(`calico-node DaemonSet: ${state}`);
                lastDsState = state;
            }

            // Every 60 s without progress, dump the operator's logs + a
            // snapshot of pod states so CloudWatch shows what's stuck.
            const elapsed = Date.now() - calicoWaitStart;
            const stuck = parseInt(desired) === 0 || ready !== desired;
            if (stuck && elapsed > 60_000 && elapsed - lastDiagnosticAt > 60_000) {
                lastDiagnosticAt = elapsed;
                warn(`calico-node not Ready after ${Math.round(elapsed / 1000)}s — dumping diagnostics`);
                const pods = run(['kubectl', 'get', 'pods', '-n', 'calico-system',
                    '-o', 'wide', '--no-headers'], { check: false, quiet: true, env: KUBECONFIG });
                if (pods.stdout) info(`calico-system pods:\n${pods.stdout.slice(0, 2000)}`);
                const opLogs = run(['kubectl', 'logs', 'deployment/tigera-operator',
                    '-n', 'tigera-operator', '--tail=30'],
                    { check: false, quiet: true, env: KUBECONFIG });
                if (opLogs.stdout) info(`tigera-operator logs:\n${opLogs.stdout.slice(0, 3000)}`);
                const nodeLogs = run(['kubectl', 'logs', '-n', 'calico-system',
                    '-l', 'k8s-app=calico-node', '-c', 'calico-node', '--tail=30'],
                    { check: false, quiet: true, env: KUBECONFIG });
                if (nodeLogs.stdout) info(`calico-node logs:\n${nodeLogs.stdout.slice(0, 3000)}`);
            }

            return parseInt(desired) > 0 && desired === ready && desired === available;
        },
        { timeoutMs: 360_000, label: 'calico-node DaemonSet Ready' },
    );

    if (existsSync(CALICO_PDB_MANIFEST)) {
        run(['kubectl', 'apply', '--server-side', '-f', CALICO_PDB_MANIFEST], { env: KUBECONFIG });
        info('Calico kube-controllers PodDisruptionBudget applied');
    } else {
        warn(`Calico PDB manifest not found at ${CALICO_PDB_MANIFEST}`);
    }

    info(`Calico CNI installed (${cfg.calicoVersion})`);
};

// =============================================================================
// Step 4: Install AWS Cloud Controller Manager via Helm
// =============================================================================

const CCM_HELM_VALUES =
    'args:\n' +
    '  - --v=2\n' +
    '  - --cloud-provider=aws\n' +
    '  - --configure-cloud-routes=false\n' +
    'nodeSelector:\n' +
    '  node-role.kubernetes.io/control-plane: ""\n' +
    'tolerations:\n' +
    '  - key: node-role.kubernetes.io/control-plane\n' +
    '    effect: NoSchedule\n' +
    '  - key: node.cloudprovider.kubernetes.io/uninitialized\n' +
    '    value: "true"\n' +
    '    effect: NoSchedule\n' +
    'hostNetworking: true\n';

const installCcm = async (_cfg: BootConfig): Promise<void> => {
    const valuesPath = '/tmp/ccm-values.yaml';
    writeFileSync(valuesPath, CCM_HELM_VALUES);
    try {
        run(['helm', 'repo', 'add', 'aws-cloud-controller-manager',
            'https://kubernetes.github.io/cloud-provider-aws', '--force-update'], { env: KUBECONFIG });
        run(['helm', 'repo', 'update'], { env: KUBECONFIG });
        run(['helm', 'upgrade', '--install', 'aws-cloud-controller-manager',
            'aws-cloud-controller-manager/aws-cloud-controller-manager',
            '--namespace', 'kube-system', '--values', valuesPath, '--wait', '--timeout', '120s'],
        { env: KUBECONFIG });
        info('AWS CCM Helm release installed');

        await waitUntil(
            () => !run(['kubectl', 'get', 'nodes', '-o', 'jsonpath={.items[*].spec.taints}'],
                { check: false, env: KUBECONFIG }).stdout
                .includes('node.cloudprovider.kubernetes.io/uninitialized'),
            { timeoutMs: 120_000, label: 'uninitialised taint removed' },
        );
        info('AWS Cloud Controller Manager installed successfully');
    } finally {
        if (existsSync(valuesPath)) unlinkSync(valuesPath);
    }
};

// =============================================================================
// Step 5: Configure kubectl access for root, ec2-user, ssm-user
// =============================================================================

const SSM_KUBECONFIG_SCRIPT =
    '#!/bin/bash\n' +
    'if [ "$(whoami)" = "ssm-user" ] && [ ! -f "$HOME/.kube/config" ]; then\n' +
    '  mkdir -p "$HOME/.kube"\n' +
    '  sudo cp -f /etc/kubernetes/admin.conf "$HOME/.kube/config"\n' +
    '  sudo chown "$(id -u):$(id -g)" "$HOME/.kube/config"\n' +
    '  chmod 600 "$HOME/.kube/config"\n' +
    'fi\n';

const configureKubectl = async (cfg: BootConfig): Promise<void> => {
    info('Configuring kubectl access...');

    for (const [user, home] of [['root', '/root'], ['ec2-user', '/home/ec2-user']] as const) {
        setupKubeconfigForUser(user, home);
    }

    const ssmUserCheck = run(['id', 'ssm-user'], { check: false, quiet: true });
    if (ssmUserCheck.code !== 0) {
        run(['useradd', '--system', '--shell', '/bin/bash', '--create-home',
            '--home-dir', '/home/ssm-user', 'ssm-user'], { check: false });
    }
    setupKubeconfigForUser('ssm-user', '/home/ssm-user');

    writeFileSync('/usr/local/bin/setup-ssm-kubeconfig.sh', SSM_KUBECONFIG_SCRIPT);
    run(['chmod', '755', '/usr/local/bin/setup-ssm-kubeconfig.sh']);

    const bashrcPath = '/etc/bashrc';
    if (existsSync(bashrcPath)) {
        const bashrc = readFileSync(bashrcPath, 'utf8');
        if (!bashrc.includes('setup-ssm-kubeconfig')) {
            appendFileSync(bashrcPath, '[ -x /usr/local/bin/setup-ssm-kubeconfig.sh ] && /usr/local/bin/setup-ssm-kubeconfig.sh\n');
        }
        if (!bashrc.includes('KUBECONFIG=')) {
            appendFileSync(bashrcPath, `\nexport KUBECONFIG=${ADMIN_CONF}\n`);
        }
    }

    writeFileSync('/etc/profile.d/kubernetes.sh', `export KUBECONFIG=${ADMIN_CONF}\n`);
    run(['chmod', '644', '/etc/profile.d/kubernetes.sh']);

    const argoPlugin = '/usr/local/bin/kubectl-argo-rollouts';
    if (!existsSync(argoPlugin)) {
        run(['curl', '-sLO',
            'https://github.com/argoproj/argo-rollouts/releases/latest/download/kubectl-argo-rollouts-linux-amd64'],
        { timeout: 120_000 });
        run(['mv', 'kubectl-argo-rollouts-linux-amd64', argoPlugin]);
        run(['chmod', '+x', argoPlugin]);
        info('kubectl argo rollouts CLI plugin installed');
    }

    process.env.KUBECONFIG = ADMIN_CONF;
    run(['kubectl', 'cluster-info'], { check: false });

    // On second runs patchProviderID and labelControlPlaneNode are called
    // inside handleSecondRun but the node isn't registered yet (Calico
    // installs afterward). Retry here — this step runs after Calico+CCM so
    // the node should now exist.
    const hostname = imds('hostname');
    if (hostname) {
        const nodeCheck = run(['kubectl', 'get', 'node', hostname],
            { check: false, quiet: true, env: KUBECONFIG });
        if (nodeCheck.ok) {
            patchProviderID(ADMIN_CONF);
            labelControlPlaneNode(cfg);
        } else {
            warn(`Node ${hostname} still not registered after Calico/CCM — providerID and labels skipped`);
        }
    }

    info('kubectl access configured');
};

// =============================================================================
// Step 6: Bootstrap ArgoCD
// =============================================================================

const bootstrapArgocd = async (_cfg: BootConfig): Promise<void> => {
    const bootstrapTs = '/opt/k8s-bootstrap/sm-a/argocd/bootstrap_argocd.ts';
    if (!existsSync(bootstrapTs)) {
        throw new Error(`ArgoCD bootstrap script not found at ${bootstrapTs} — AMI bake may be missing sm-a/ manifests`);
    }
    run(['npx', 'tsx', bootstrapTs], {
        env: { KUBECONFIG: ADMIN_CONF, ARGOCD_DIR: '/opt/k8s-bootstrap/sm-a/argocd' },
        capture: false,
        timeout: 800_000,
    });
    info('ArgoCD bootstrap complete');
};

// =============================================================================
// Step 7: Verify cluster (pool-aware node readiness + ArgoCD + NLB connectivity)
// =============================================================================

const countReadyNodesInPool = (pool: string): number => {
    const r = run(
        ['kubectl', 'get', 'nodes', '-l', `node-pool=${pool}`, '--no-headers'],
        { check: false, env: KUBECONFIG },
    );
    if (!r.ok || !r.stdout.trim()) return 0;
    return r.stdout.trim().split('\n')
        .filter(l => l.includes('Ready') && !l.includes('NotReady')).length;
};

const verifyCluster = async (cfg: BootConfig): Promise<void> => {
    const results: Record<string, boolean> = {};

    // Pool-aware node readiness — control-plane is the only hard gate
    for (const pool of ['control-plane', 'general', 'monitoring']) {
        const count = countReadyNodesInPool(pool);
        count > 0
            ? info(`node-pool=${pool}: ${count} Ready`)
            : warn(`node-pool=${pool}: 0 Ready nodes (non-blocking for worker pools at init time)`);
        if (pool === 'control-plane') results.node_ready = count > 0;
    }
    if (!results.node_ready) error('Control plane node is not in Ready state');

    for (const ns of ['kube-system', 'calico-system', 'tigera-operator']) {
        const r = run(['kubectl', 'get', 'pods', '-n', ns, '--no-headers'], { check: false, env: KUBECONFIG });
        if (!r.ok || !r.stdout.trim()) { results[`ns_${ns}`] = true; continue; }
        const lines   = r.stdout.trim().split('\n');
        const healthy = lines.filter(l => l.includes('Running') || l.includes('Completed')).length;
        results[`ns_${ns}`] = healthy === lines.length;
        healthy === lines.length
            ? info(`${ns}: ${healthy}/${lines.length} pods healthy`)
            : warn(`${ns}: ${healthy}/${lines.length} pods healthy`);
    }

    const argoR = run(['kubectl', 'get', 'pods', '-n', 'argocd', '--no-headers'], { check: false, env: KUBECONFIG });
    if (!argoR.ok || !argoR.stdout.trim()) {
        warn('ArgoCD namespace not found or empty (may not be bootstrapped yet)');
        results.argocd = true;
    } else {
        const lines = argoR.stdout.trim().split('\n');
        results.argocd = lines.filter(l => l.includes('Running')).length > 0;
    }

    const apiDns = await ssmGet(`${cfg.ssmPrefix}/api-server-dns`, cfg.awsRegion);
    if (apiDns) {
        const curlResult = run(
            ['curl', '-sSk', '--connect-timeout', '10', '--max-time', '15',
                '-o', '/dev/null', '-w', '%{http_code}', `https://${apiDns}:6443/healthz`],
            { check: false },
        );
        results.api_connectivity = curlResult.ok && ['200', '401'].includes(curlResult.stdout.trim());
        results.api_connectivity
            ? info(`API Server reachable via NLB (HTTP ${curlResult.stdout.trim()})`)
            : warn(`API Server not reachable via NLB (HTTP ${curlResult.stdout.trim()})`);
    }

    const failures = Object.entries(results).filter(([, v]) => !v).map(([k]) => k);
    failures.length > 0
        ? warn(`Verification completed with warnings: ${failures.join(', ')}`)
        : info('All post-boot checks passed');
};

// =============================================================================
// Step 8: Install etcd backup systemd timer
// =============================================================================

const installEtcdBackup = async (_cfg: BootConfig): Promise<void> => {
    const installer = '/opt/k8s-bootstrap/gitops/dr/install-etcd-backup-timer.sh';
    if (!existsSync(installer)) {
        warn(`etcd backup installer not found at ${installer} — AMI bake may be missing gitops/dr/ scripts`);
        return;
    }
    run([installer], { capture: false, timeout: 120_000 });
    info('etcd backup timer installed');
};

// =============================================================================
// Step 9: Install kubeadm token rotator systemd timer (12 h rotation)
// =============================================================================

const installTokenRotator = async (cfg: BootConfig): Promise<void> => {
    const scriptPath = '/usr/local/bin/rotate-join-token.sh';
    writeFileSync(scriptPath, [
        '#!/bin/bash',
        'set -euo pipefail',
        '',
        'export KUBECONFIG=/etc/kubernetes/admin.conf',
        'TOKEN=$(kubeadm token create --ttl 24h)',
        '',
        // Token format validation before writing to SSM — guards against corruption at source
        "if ! echo \"$TOKEN\" | grep -qE '^[a-z0-9]{6}\\.[a-z0-9]{16}$'; then",
        '  echo "ERROR: kubeadm token create returned invalid token: $TOKEN" >&2',
        '  exit 1',
        'fi',
        '',
        'aws ssm put-parameter \\',
        `  --name "${cfg.ssmPrefix}/join-token" \\`,
        '  --value "$TOKEN" \\',
        '  --type "SecureString" \\',
        '  --overwrite \\',
        `  --region "${cfg.awsRegion}"`,
        '',
        'echo "Successfully rotated and validated join token in SSM."',
        '',
    ].join('\n'));
    run(['chmod', '755', scriptPath]);

    writeFileSync('/etc/systemd/system/kubeadm-token-rotator.service', [
        '[Unit]',
        'Description=Rotate kubeadm join token and update SSM',
        'After=network-online.target',
        '',
        '[Service]',
        'Type=oneshot',
        'ExecStart=/usr/local/bin/rotate-join-token.sh',
        '',
    ].join('\n'));

    // TOKEN_ROTATOR_MARKER = this timer file — written last so runStep doesn't overwrite it
    writeFileSync(TOKEN_ROTATOR_MARKER, [
        '[Unit]',
        'Description=Run kubeadm token rotator every 12 hours',
        '',
        '[Timer]',
        // Fire early after boot so a fresh 24 h rolling token is in SSM quickly
        'OnBootSec=10min',
        'OnUnitActiveSec=12h',
        'RandomizedDelaySec=5m',
        '',
        '[Install]',
        'WantedBy=timers.target',
        '',
    ].join('\n'));

    run(['systemctl', 'daemon-reload']);
    run(['systemctl', 'enable', '--now', 'kubeadm-token-rotator.timer']);
    info('kubeadm token rotator timer installed (12h rotation, OnBootSec=10min)');
};

// =============================================================================
// main
// =============================================================================

/**
 * Control-plane bootstrap entry point — runs ten idempotent steps in sequence.
 *
 * @remarks
 * Each step is wrapped by {@link makeRunStep} / `runStep`, which:
 * - Checks a filesystem marker before running (skips if already done).
 * - Writes the marker on success so the step is not re-executed on reboot.
 * - Emits structured JSON log lines compatible with CloudWatch Logs Insights.
 *
 * Steps without a marker argument (`init-kubeadm`, `configure-kubectl`,
 * `bootstrap-argocd`, `verify-cluster`) run unconditionally on every boot
 * because they perform idempotent checks internally.
 *
 * @throws {Error} On any unrecovered step failure (process exits with code 1).
 *
 * @example
 * ```typescript
 * // Called by orchestrator.ts when --mode control-plane (default)
 * const { main } = await import('./control_plane.js');
 * await main();
 * ```
 */
export const main = async (): Promise<void> => {
    const cfg = fromEnv();
    info('Control plane bootstrap starting', { ssmPrefix: cfg.ssmPrefix, awsRegion: cfg.awsRegion });

    await runStep('mount-data-volume',     () => mountDataVolume(cfg),     cfg, DATA_MOUNT_MARKER);
    await runStep('dr-restore',            () => drRestore(cfg),            cfg, DR_RESTORE_MARKER);
    await runStep('init-kubeadm',          () => initOrReconstruct(cfg),   cfg);
    await runStep('install-calico',        () => installCalico(cfg),        cfg, CALICO_MARKER);
    await runStep('install-ccm',           () => installCcm(cfg),           cfg, CCM_MARKER);
    await runStep('configure-kubectl',     () => configureKubectl(cfg),    cfg);
    await runStep('bootstrap-argocd',      () => bootstrapArgocd(cfg),     cfg);
    await runStep('verify-cluster',        () => verifyCluster(cfg),       cfg);
    await runStep('install-etcd-backup',   () => installEtcdBackup(cfg),   cfg, '/etc/systemd/system/etcd-backup.timer');
    await runStep('install-token-rotator', () => installTokenRotator(cfg), cfg, TOKEN_ROTATOR_MARKER);

    info('Control plane bootstrap complete');
};

if (fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch(err => {
        error('Control plane bootstrap FAILED', { error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
    });
}
