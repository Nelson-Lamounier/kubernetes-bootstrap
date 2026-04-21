#!/usr/bin/env tsx
/**
 * @format
 * Worker Node Bootstrap — all 6 steps, single file.
 *
 * Migrated from boot/steps/wk/ (5 Python files, ~600 lines).
 * AWS SDK v3 (SSM) replaces boto3 subprocess calls.
 * Arrow functions throughout for consistency.
 *
 * Run: npx tsx boot/steps/worker.ts
 * Entry: orchestrator.py calls `npx tsx worker.ts`
 */

import {
    existsSync,
    mkdirSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';

import { PutParameterCommand } from '@aws-sdk/client-ssm';

import {
    ECR_PROVIDER_CONFIG,
    ensureEcrCredentialProvider, error, imds, info, makeRunStep, run,
    sleep, ssmClient, ssmGet, ssmPut, validateKubeadmToken, warn,
} from './common.js';

const runStep = makeRunStep('worker');

// =============================================================================
// Types
// =============================================================================

export interface WorkerConfig {
    readonly ssmPrefix: string;
    readonly awsRegion: string;
    readonly environment: string;
    readonly logGroupName: string;
    readonly nodeLabel: string;
    readonly nodePool: string;
    readonly joinMaxRetries: number;
    readonly joinRetryInterval: number;
}

// =============================================================================
// Constants
// =============================================================================

const KUBELET_CONF          = '/etc/kubernetes/kubelet.conf';
const CA_CERT_PATH          = '/etc/kubernetes/pki/ca.crt';
const KUBELET_CONFIG_FILE   = '/var/lib/kubelet/config.yaml';
const STALE_PV_CLEANUP_MARKER = '/tmp/.stale-pv-cleanup-done';
const CW_AGENT_MARKER       = '/tmp/.cw-agent-installed';
const CW_AGENT_CTL          = '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl';
const CW_AGENT_CONFIG_PATH  = '/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json';
const K8S_ENV_FILE          = '/etc/profile.d/k8s-env.sh';
const ADMIN_KUBECONFIG_TMP  = '/tmp/worker-admin.conf';

const CP_MAX_WAIT_MS            = 300_000;
const API_REACHABLE_TIMEOUT_MS  = 300_000;
const API_REACHABLE_POLL_MS     = 10_000;

const REQUIRED_BINARIES        = ['containerd', 'kubeadm', 'kubelet', 'kubectl', 'helm'];
const REQUIRED_KERNEL_MODULES  = ['overlay', 'br_netfilter'];
const REQUIRED_SYSCTL: Record<string, string> = {
    'net.bridge.bridge-nf-call-iptables': '1',
    'net.bridge.bridge-nf-call-ip6tables': '1',
    'net.ipv4.ip_forward': '1',
};
const MONITORING_LABELS = new Set(['workload=monitoring', 'node-pool=monitoring']);

const CW_LOG_FILES = [
    { filePath: '/var/log/messages',          logStreamName: '{instance_id}/messages'  },
    { filePath: '/var/log/user-data.log',     logStreamName: '{instance_id}/user-data' },
    { filePath: '/var/log/cloud-init-output.log', logStreamName: '{instance_id}/cloud-init' },
];

// =============================================================================
// Config
// =============================================================================

export const fromEnv = (): WorkerConfig => ({
    ssmPrefix:         process.env.SSM_PREFIX          ?? '/k8s/development',
    awsRegion:         process.env.AWS_REGION          ?? 'eu-west-1',
    environment:       process.env.ENVIRONMENT         ?? 'development',
    logGroupName:      process.env.LOG_GROUP_NAME      ?? '',
    nodeLabel:         process.env.NODE_LABEL          ?? 'role=worker',
    nodePool:          process.env.NODE_POOL           ?? '',
    joinMaxRetries:    parseInt(process.env.JOIN_MAX_RETRIES    ?? '5', 10),
    joinRetryInterval: parseInt(process.env.JOIN_RETRY_INTERVAL ?? '30', 10),
});


// =============================================================================
// Hostname resolution
// =============================================================================

const resolveHostname = (): string => {
    const r = run(['hostname', '-f'], { check: false });
    if (r.ok && r.stdout.trim() && r.stdout.trim() !== 'localhost') return r.stdout.trim();
    return imds('local-hostname');
};

// =============================================================================
// providerID patch (worker uses kubelet.conf, not admin.conf)
// =============================================================================

const patchProviderId = (): void => {
    const instanceId = imds('instance-id');
    const az         = imds('placement/availability-zone');
    const hostname   = imds('hostname');

    if (!instanceId || !az) {
        warn('Could not retrieve instance-id or AZ from IMDS — providerID will not be set');
        return;
    }
    if (!hostname) {
        warn('Could not determine hostname from IMDS — skipping providerID patch');
        return;
    }

    const providerId = `aws:///${az}/${instanceId}`;
    info(`Setting providerID: ${providerId}`);

    const patch = JSON.stringify({ spec: { providerID: providerId } });
    const res = run(
        ['kubectl', '--kubeconfig', KUBELET_CONF,
            'patch', 'node', hostname, '--type', 'merge', '-p', patch],
        { check: false, env: { KUBECONFIG: KUBELET_CONF } },
    );
    if (res.ok) info(`providerID set on node ${hostname}: ${providerId}`);
    else warn(`Failed to patch providerID on ${hostname} — AWS CCM will set it during node initialisation`);
};

// =============================================================================
// CA mismatch detection
// =============================================================================

export const computeLocalCaHash = (): string => {
    // Shell pipe is unavoidable: openssl x509 | openssl rsa | openssl dgst | awk
    // Binary is /bin/sh, args are string constants — not user input.
    const res = run(
        ['/bin/sh', '-c',
            `openssl x509 -pubkey -in ${CA_CERT_PATH} | openssl rsa -pubin -outform der 2>/dev/null | openssl dgst -sha256 -hex | awk '{print $2}'`],
        { check: false },
    );
    if (!res.ok || !res.stdout.trim()) return '';
    return `sha256:${res.stdout.trim()}`;
};

export const checkCaMismatch = async (cfg: WorkerConfig): Promise<boolean> => {
    if (!existsSync(CA_CERT_PATH)) {
        info('No local CA cert found — fresh worker, proceeding normally');
        return false;
    }
    if (!existsSync(KUBELET_CONF)) {
        info('No kubelet.conf — worker not previously joined, proceeding normally');
        return false;
    }

    const localHash = computeLocalCaHash();
    if (!localHash) { warn('Could not compute local CA hash — skipping mismatch check'); return false; }

    const ssmHash = await ssmGet(`${cfg.ssmPrefix}/ca-hash`, cfg.awsRegion);
    if (!ssmHash) { warn('CA hash not available in SSM — skipping mismatch check'); return false; }

    if (localHash === ssmHash) {
        info(`CA certificate valid — local hash matches SSM (${localHash.slice(0, 20)}...)`);
        return false;
    }

    warn('='.repeat(60));
    warn('CA MISMATCH DETECTED');
    warn(`  Local CA hash:  ${localHash}`);
    warn(`  SSM CA hash:    ${ssmHash}`);
    warn('  The control plane was replaced with a new CA certificate.');
    warn('  Running kubeadm reset to prepare for re-join...');
    warn('='.repeat(60));

    run(['kubeadm', 'reset', '-f'], { check: false });
    if (existsSync(KUBELET_CONF)) { unlinkSync(KUBELET_CONF); info('Removed stale kubelet.conf'); }
    if (existsSync(CA_CERT_PATH)) { unlinkSync(CA_CERT_PATH); info('Removed stale CA certificate'); }
    info('Worker reset complete — ready to re-join with new CA');
    return true;
};

// =============================================================================
// Control plane endpoint resolution
// =============================================================================

export const resolveControlPlaneEndpoint = async (cfg: WorkerConfig): Promise<string> => {
    info('Resolving control plane endpoint from SSM...');
    const paramName = `${cfg.ssmPrefix}/control-plane-endpoint`;
    const deadline  = Date.now() + CP_MAX_WAIT_MS;

    while (Date.now() < deadline) {
        const endpoint = await ssmGet(paramName, cfg.awsRegion);
        if (endpoint && endpoint !== 'None') {
            info(`Control plane endpoint: ${endpoint}`);
            return endpoint;
        }
        const waited = Math.round((Date.now() - (deadline - CP_MAX_WAIT_MS)) / 1000);
        info(`Waiting for control plane endpoint... (${waited}s / ${CP_MAX_WAIT_MS / 1000}s)`);
        await sleep(10_000);
    }

    throw new Error(
        `Control plane endpoint not found in SSM after ${CP_MAX_WAIT_MS / 1000}s. ` +
        `The control plane must be running and published its endpoint to ${paramName}.`,
    );
};

const parseHostPort = (endpoint: string): [string, number] => {
    const idx = endpoint.lastIndexOf(':');
    if (idx > 0) return [endpoint.slice(0, idx), parseInt(endpoint.slice(idx + 1), 10)];
    return [endpoint, 6443];
};

// =============================================================================
// TCP probe (uses node:net — no subprocess overhead)
// =============================================================================

const tcpProbe = (host: string, port: number): Promise<boolean> =>
    new Promise(resolve => {
        const socket = net.createConnection({ host, port });
        socket.setTimeout(5000);
        socket.on('connect', () => { socket.destroy(); resolve(true);  });
        socket.on('error',   () => resolve(false));
        socket.on('timeout', () => { socket.destroy(); resolve(false); });
    });

const waitForApiServerReachable = async (endpoint: string): Promise<void> => {
    const [host, port] = parseHostPort(endpoint);
    info(`Waiting for API server TCP connectivity: ${host}:${port} (timeout=${API_REACHABLE_TIMEOUT_MS / 1000}s)`);
    const deadline = Date.now() + API_REACHABLE_TIMEOUT_MS;

    while (Date.now() < deadline) {
        if (await tcpProbe(host, port)) {
            const waited = Math.round((Date.now() - (deadline - API_REACHABLE_TIMEOUT_MS)) / 1000);
            info(`API server is reachable at ${host}:${port} (waited ${waited}s)`);
            return;
        }
        const waited = Math.round((Date.now() - (deadline - API_REACHABLE_TIMEOUT_MS)) / 1000);
        info(`API server not yet reachable (${waited}s / ${API_REACHABLE_TIMEOUT_MS / 1000}s) — retrying in ${API_REACHABLE_POLL_MS / 1000}s`);
        await sleep(API_REACHABLE_POLL_MS);
    }

    throw new Error(
        `API server at ${host}:${port} not reachable after ${API_REACHABLE_TIMEOUT_MS / 1000}s. ` +
        `Check the control plane is running, DNS has propagated, and security groups allow TCP ${port}.`,
    );
};

// =============================================================================
// Node label helpers
// =============================================================================

export const buildNodeLabels = (cfg: WorkerConfig): string => {
    let labels = cfg.nodeLabel;
    if (cfg.nodePool && !labels.includes('node-pool')) {
        labels = labels ? `${labels},node-pool=${cfg.nodePool}` : `node-pool=${cfg.nodePool}`;
        info(`NODE_POOL=${cfg.nodePool} set — appended 'node-pool=${cfg.nodePool}' to node labels (scheduling gate for Helm nodeSelectors)`);
    }
    return labels;
};

export const parseLabelString = (labelStr: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const pair of labelStr.split(',')) {
        const idx = pair.trim().indexOf('=');
        if (idx > 0) out[pair.trim().slice(0, idx).trim()] = pair.trim().slice(idx + 1).trim();
    }
    return out;
};

// =============================================================================
// Wait for kubelet post-join
// =============================================================================

export const waitForKubelet = async (): Promise<void> => {
    info('Waiting for kubelet to become active...');

    for (let i = 1; i <= 60; i++) {
        // Fail fast: if kubelet has been running >10s but config still absent,
        // kubeadm join did not complete — log and bail rather than spinning.
        if (i > 10 && !existsSync(KUBELET_CONFIG_FILE)) {
            warn('kubelet config not found after >10s — kubeadm join likely did not complete');
            run(['journalctl', '-u', 'kubelet', '--no-pager', '-n', '20'], { check: false });
            return;
        }

        const active = run(['systemctl', 'is-active', '--quiet', 'kubelet'], { check: false });
        if (active.ok && existsSync(KUBELET_CONFIG_FILE)) {
            info(`kubelet is active (waited ${i}s)`);
            return;
        }

        if (i === 60) {
            warn('kubelet did not become active in 60s');
            run(['journalctl', '-u', 'kubelet', '--no-pager', '-n', '20'], { check: false });
        }

        await sleep(1_000);
    }
};

// =============================================================================
// Admin kubeconfig resolution (workers don't have admin.conf)
// =============================================================================

const resolveWorkerKubeconfig = async (cfg: WorkerConfig): Promise<Record<string, string>> => {
    const base = { ...process.env } as Record<string, string>;

    const b64 = await ssmGet(`${cfg.ssmPrefix}/admin-kubeconfig-b64`, cfg.awsRegion, true);
    if (b64) {
        try {
            writeFileSync(ADMIN_KUBECONFIG_TMP, Buffer.from(b64, 'base64').toString('utf8'), { mode: 0o600 });
            info('Using admin kubeconfig from SSM for membership verification');
            return { ...base, KUBECONFIG: ADMIN_KUBECONFIG_TMP };
        } catch (e) { warn(`Failed to write admin kubeconfig from SSM: ${e}`); }
    }

    if (existsSync(KUBELET_CONF)) {
        warn('Admin kubeconfig not in SSM — falling back to kubelet.conf (read-only; label correction will be skipped)');
        return { ...base, KUBECONFIG: KUBELET_CONF };
    }

    warn('No kubeconfig available for membership verification');
    return base;
};

// =============================================================================
// CloudWatch log group resolution
// =============================================================================

const resolveLogGroupName = (cfg: WorkerConfig): string => {
    if (cfg.logGroupName) return cfg.logGroupName;
    if (existsSync(K8S_ENV_FILE)) {
        for (const line of readFileSync(K8S_ENV_FILE, 'utf8').split('\n')) {
            const t = line.trim();
            if (t.startsWith('export LOG_GROUP_NAME=')) {
                const val = t.split('=', 2)[1]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
                if (val) return val;
            }
        }
    }
    return '';
};

// =============================================================================
// Step 1 — Validate Golden AMI
// =============================================================================

const validateAmi = async (): Promise<void> => {
    info('Checking required binaries...');
    const missingBins: string[] = [];
    for (const bin of REQUIRED_BINARIES) {
        const r = run(['which', bin], { check: false });
        if (r.ok) info(`  ✓ ${bin} -> ${r.stdout.trim()}`);
        else      missingBins.push(bin);
    }

    info('Checking kernel modules...');
    const missingMods: string[] = [];
    if (existsSync('/proc/modules')) {
        const loaded = readFileSync('/proc/modules', 'utf8');
        for (const mod of REQUIRED_KERNEL_MODULES) {
            if (loaded.includes(mod)) info(`  ✓ Kernel module: ${mod}`);
            else missingMods.push(mod);
        }
    } else {
        error('/proc/modules not found — cannot validate kernel modules');
        missingMods.push(...REQUIRED_KERNEL_MODULES);
    }

    info('Checking sysctl settings...');
    const sysctlErrors: string[] = [];
    for (const [key, expected] of Object.entries(REQUIRED_SYSCTL)) {
        const path = `/proc/sys/${key.replace(/\./g, '/')}`;
        if (existsSync(path)) {
            const actual = readFileSync(path, 'utf8').trim();
            if (actual === expected) info(`  ✓ sysctl ${key} = ${actual}`);
            else sysctlErrors.push(`${key}: expected=${expected}, actual=${actual}`);
        } else {
            sysctlErrors.push(`${key}: not found at ${path}`);
        }
    }

    const allErrors: string[] = [
        ...(missingBins.length  ? [`Missing binaries: ${missingBins.join(', ')}`]             : []),
        ...(missingMods.length  ? [`Missing kernel modules: ${missingMods.join(', ')}`]        : []),
        ...(sysctlErrors.length ? [`Sysctl errors: ${sysctlErrors.join('; ')}`]               : []),
    ];

    if (allErrors.length) {
        throw new Error(
            `Golden AMI validation FAILED.\n` +
            `  The bootstrap script does NOT install packages at boot time.\n` +
            `  All binaries must be pre-baked into the Golden AMI.\n\n` +
            `  Errors:\n${allErrors.map(e => `    - ${e}`).join('\n')}\n\n` +
            `  Resolution: Rebuild the Golden AMI with the missing components.`,
        );
    }

    info('✓ Golden AMI validated — all required binaries and settings present');
};

// =============================================================================
// Step 2 — Join cluster (inner retry loop, called by joinCluster and self-healing)
// =============================================================================

const doJoin = async (endpoint: string, cfg: WorkerConfig): Promise<void> => {
    run(['systemctl', 'start', 'containerd']);
    info('containerd started');

    ensureEcrCredentialProvider();

    const privateIp = imds('local-ipv4');
    if (!privateIp) throw new Error('Failed to retrieve private IP from IMDS — cannot configure kubelet --node-ip');

    const nodeLabels = buildNodeLabels(cfg);
    info(`Configuring kubelet: node-labels=${nodeLabels}, node-ip=${privateIp}`);
    mkdirSync('/etc/sysconfig', { recursive: true });
    writeFileSync('/etc/sysconfig/kubelet',
        `KUBELET_EXTRA_ARGS=--cloud-provider=external` +
        ` --node-ip=${privateIp}` +
        ` --node-labels=${nodeLabels}` +
        ` --image-credential-provider-config=${ECR_PROVIDER_CONFIG}` +
        ` --image-credential-provider-bin-dir=/usr/local/bin\n`,
    );

    const tokenSsm  = `${cfg.ssmPrefix}/join-token`;
    const caHashSsm = `${cfg.ssmPrefix}/ca-hash`;
    const [host, port] = parseHostPort(endpoint);

    for (let attempt = 1; attempt <= cfg.joinMaxRetries; attempt++) {
        info(`=== kubeadm join attempt ${attempt}/${cfg.joinMaxRetries} ===`);

        // Token resolution: env var (user-data at launch) → SSM fallback
        const envToken = (process.env.KUBEADM_JOIN_TOKEN ?? '').trim();
        const rawToken = envToken
            ? (info(`Join token sourced from KUBEADM_JOIN_TOKEN env var (attempt ${attempt})`), envToken)
            : (info(`Join token sourced from SSM (${tokenSsm}, attempt ${attempt})`),
               await ssmGet(tokenSsm, cfg.awsRegion, true));

        if (!rawToken) {
            warn(`Join token not available (attempt ${attempt}/${cfg.joinMaxRetries})`);
            if (attempt < cfg.joinMaxRetries) { await sleep(cfg.joinRetryInterval * 1000); continue; }
            throw new Error(`Join token never became available after ${cfg.joinMaxRetries} attempts`);
        }

        const joinToken = validateKubeadmToken(rawToken, 'SSM');
        info(`Join token validated (length=${joinToken.length})`);

        const caHash = await ssmGet(caHashSsm, cfg.awsRegion);
        if (!caHash) {
            warn(`CA hash not available (attempt ${attempt}/${cfg.joinMaxRetries})`);
            if (attempt < cfg.joinMaxRetries) { await sleep(cfg.joinRetryInterval * 1000); continue; }
            throw new Error(`CA hash never became available after ${cfg.joinMaxRetries} attempts`);
        }

        const reachable = await tcpProbe(host, port);
        info(`Pre-join TCP probe: ${host}:${port} → ${reachable ? 'reachable' : 'UNREACHABLE'}`);
        if (!reachable) {
            warn(`API server not reachable on attempt ${attempt} — waiting ${cfg.joinRetryInterval}s`);
            if (attempt < cfg.joinMaxRetries) { await sleep(cfg.joinRetryInterval * 1000); continue; }
            throw new Error(`API server at ${endpoint} unreachable on all ${cfg.joinMaxRetries} attempts`);
        }

        const healthz = run(
            ['curl', '-sk', '--max-time', '10', `https://${host}:${port}/healthz`],
            { check: false },
        );
        if (!healthz.ok || !healthz.stdout.toLowerCase().includes('ok')) {
            warn(`API server /healthz not OK on attempt ${attempt} — waiting ${cfg.joinRetryInterval}s`);
            if (attempt < cfg.joinMaxRetries) { await sleep(cfg.joinRetryInterval * 1000); continue; }
            throw new Error(`API server at ${endpoint} not healthy after ${cfg.joinMaxRetries} attempts`);
        }

        info('Running kubeadm join...');
        const joinRes = run(
            ['kubeadm', 'join', endpoint,
                '--token', joinToken,
                '--discovery-token-ca-cert-hash', caHash],
            { check: false, timeout: 300_000 },
        );

        if (joinRes.ok) {
            info(`kubeadm join succeeded on attempt ${attempt}`);
            return;
        }

        // Token expiry: returncode 1 with "token has expired" / "unknown bootstrap token" in output.
        // Without detection, retry loop burns all attempts against a permanently-invalid token.
        const combined     = (joinRes.stderr + joinRes.stdout).toLowerCase();
        const tokenExpired = combined.includes('token') && (
            combined.includes('expired') ||
            combined.includes('not found') ||
            combined.includes('unknown bootstrap token')
        );

        if (tokenExpired) {
            warn(
                `Join token EXPIRED on attempt ${attempt}/${cfg.joinMaxRetries}. ` +
                `Control plane token rotator refreshes SSM every 12h. ` +
                `Waiting ${cfg.joinRetryInterval}s for a fresh token...`,
            );
            run(['kubeadm', 'reset', '-f'], { check: false });
            if (attempt < cfg.joinMaxRetries) { await sleep(cfg.joinRetryInterval * 1000); continue; }
            throw new Error(
                `Join token expired and no fresh token appeared in SSM after ${cfg.joinMaxRetries} attempts. ` +
                `Verify token rotator: systemctl status kubeadm-token-rotator.timer`,
            );
        }

        if (attempt < cfg.joinMaxRetries) {
            info('Running kubeadm reset before retry...');
            run(['kubeadm', 'reset', '-f'], { check: false });
            await sleep(cfg.joinRetryInterval * 1000);
        } else {
            throw new Error(`kubeadm join failed after ${cfg.joinMaxRetries} attempts`);
        }
    }
};

// Outer join step: CA mismatch guard + idempotency check + resolve endpoint + doJoin
const joinCluster = async (cfg: WorkerConfig): Promise<void> => {
    const caReset = await checkCaMismatch(cfg);
    if (caReset) info('CA mismatch handled — proceeding to re-join cluster');

    // Idempotency: kubelet.conf written by kubeadm join on success
    if (existsSync(KUBELET_CONF)) {
        info('[join-cluster] skip — kubelet.conf exists (already joined)');
        return;
    }

    const endpoint = await resolveControlPlaneEndpoint(cfg);
    await waitForApiServerReachable(endpoint);
    await doJoin(endpoint, cfg);
    await waitForKubelet();
    patchProviderId();

    const kubeletVersion = run(['kubelet', '--version'], { check: false }).stdout.trim();
    info(`Worker node joined cluster successfully: ${kubeletVersion}`);
};

// =============================================================================
// Step 3b — Register ASG instance in SSM
// =============================================================================

const registerInstance = async (cfg: WorkerConfig): Promise<void> => {
    if (!cfg.nodePool) {
        info('NODE_POOL not set — skipping SSM instance registration (legacy statically-provisioned worker)');
        return;
    }

    const instanceId = imds('instance-id');
    if (!instanceId) { warn('Could not retrieve instance-id from IMDS — skipping SSM registration'); return; }

    const hostname = resolveHostname();
    if (!hostname) { warn('Could not resolve hostname — skipping SSM registration'); return; }

    const ssmPath = `${cfg.ssmPrefix}/nodes/${cfg.nodePool}/${instanceId}`;
    info(`Registering instance in SSM: ${ssmPath} = ${hostname}`);

    try {
        await ssmClient(cfg.awsRegion).send(new PutParameterCommand({
            Name:      ssmPath,
            Value:     hostname,
            Type:      'String',
            Overwrite: true,
            Tags: [
                { Key: 'node-pool',    Value: cfg.nodePool    },
                { Key: 'environment',  Value: cfg.environment },
            ],
        }));
        info(`✓ Instance registered: ${instanceId} → ${hostname} (pool=${cfg.nodePool})`);
    } catch (e) {
        // Non-fatal: node is already in the cluster; registration is for pool discovery only.
        warn(`SSM instance registration failed (non-fatal): ${e}`);
    }
};

// =============================================================================
// Step 3 — Install CloudWatch Agent
// =============================================================================

const installCloudwatchAgent = async (cfg: WorkerConfig): Promise<void> => {
    const logGroupName = resolveLogGroupName(cfg);
    if (!logGroupName) {
        warn('LOG_GROUP_NAME not found in environment or k8s-env.sh — skipping CloudWatch Agent installation');
        return;
    }

    info(`Target log group: ${logGroupName}`);
    info('Installing amazon-cloudwatch-agent...');
    run(
        ['/bin/sh', '-c', 'dnf install -y amazon-cloudwatch-agent 2>/dev/null || yum install -y amazon-cloudwatch-agent'],
        { check: true, timeout: 120_000 },
    );

    const collectList = CW_LOG_FILES.map(lf => ({
        file_path:        lf.filePath,
        log_group_name:   logGroupName,
        log_stream_name:  lf.logStreamName,
        retention_in_days: 30,
    }));

    const agentConfig = {
        agent: {
            metrics_collection_interval: 60,
            logfile: '/opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log',
        },
        logs: { logs_collected: { files: { collect_list: collectList } } },
    };

    mkdirSync('/opt/aws/amazon-cloudwatch-agent/etc', { recursive: true });
    writeFileSync(CW_AGENT_CONFIG_PATH, JSON.stringify(agentConfig, null, 2));
    info(`Agent config written to ${CW_AGENT_CONFIG_PATH}`);

    info('Starting CloudWatch Agent...');
    run([CW_AGENT_CTL, '-a', 'fetch-config', '-m', 'ec2', '-c', `file:${CW_AGENT_CONFIG_PATH}`, '-s'], { timeout: 60_000 });

    const status = run([CW_AGENT_CTL, '-a', 'status'], { check: false });
    if (status.ok && status.stdout.toLowerCase().includes('running')) info('CloudWatch Agent is running');
    else warn('CloudWatch Agent may not be running — check agent logs');
};

// =============================================================================
// Step 4 — Clean stale PVs / PVCs (monitoring workers only)
// =============================================================================

export interface StalePvEntry {
    pvName: string;
    pvcName: string;
    pvcNamespace: string;
    deadNode: string;
}

export const findStalePvs = (pvListJson: string, liveNodes: Set<string>): StalePvEntry[] => {
    const stale: StalePvEntry[] = [];
    let pvList: { items: unknown[] };
    try { pvList = JSON.parse(pvListJson) as { items: unknown[] }; }
    catch { warn('Failed to parse PV list JSON — skipping stale PV cleanup'); return stale; }

    for (const pv of pvList.items as Record<string, unknown>[]) {
        const meta      = pv.metadata as Record<string, string> | undefined;
        const pvName    = meta?.name ?? '';
        const spec      = (pv.spec ?? {}) as Record<string, unknown>;
        const claimRef  = (spec.claimRef ?? {}) as Record<string, string>;
        const pvcNs     = claimRef.namespace ?? '';
        const pvcName   = claimRef.name ?? '';
        if (pvcNs !== 'monitoring') continue;

        const terms = (
            ((spec.nodeAffinity as Record<string, unknown> | undefined)
                ?.required as Record<string, unknown> | undefined)
            ?.nodeSelectorTerms as unknown[]
        ) ?? [];

        for (const term of terms as Record<string, unknown>[]) {
            for (const expr of (term.matchExpressions as Record<string, unknown>[]) ?? []) {
                if (expr.key === 'kubernetes.io/hostname') {
                    for (const hn of (expr.values as string[]) ?? []) {
                        if (!liveNodes.has(hn)) {
                            stale.push({ pvName, pvcName, pvcNamespace: pvcNs, deadNode: hn });
                        }
                    }
                }
            }
        }
    }
    return stale;
};

const cleanStalePvs = async (cfg: WorkerConfig): Promise<void> => {
    if (!MONITORING_LABELS.has(cfg.nodeLabel)) {
        info(`Skipping stale PV cleanup — NODE_LABEL=${cfg.nodeLabel} (only monitoring workers trigger PV cleanup: ${[...MONITORING_LABELS].sort().join(', ')})`);
        return;
    }

    info('Waiting 10s for node registration before PV cleanup...');
    await sleep(10_000);

    // Admin kubeconfig required for PV/PVC delete RBAC
    const adminB64 = await ssmGet(`${cfg.ssmPrefix}/admin-kubeconfig-b64`, cfg.awsRegion, true);
    const kcEnv = { ...process.env } as Record<string, string>;
    if (adminB64) {
        const kcPath = '/tmp/admin-kubeconfig';
        writeFileSync(kcPath, Buffer.from(adminB64, 'base64').toString('utf8'), { mode: 0o600 });
        kcEnv.KUBECONFIG = kcPath;
        info('Using admin kubeconfig from SSM for PV cleanup');
    } else {
        info('Admin kubeconfig not in SSM — attempting PV cleanup with default credentials');
    }

    const nodesRes = run(
        ['kubectl', 'get', 'nodes', '-o', 'jsonpath={.items[*].metadata.name}'],
        { check: false, env: kcEnv },
    );
    if (!nodesRes.ok) { warn('Failed to list cluster nodes — skipping stale PV cleanup'); return; }
    const liveNodes = new Set(nodesRes.stdout.trim().split(/\s+/).filter(Boolean));
    info(`Live cluster nodes: ${[...liveNodes].sort().join(', ')}`);

    const pvsRes = run(['kubectl', 'get', 'pv', '-o', 'json'], { check: false, env: kcEnv });
    if (!pvsRes.ok) { warn('Failed to list PVs — skipping stale PV cleanup'); return; }

    const stale = findStalePvs(pvsRes.stdout, liveNodes);
    if (stale.length === 0) { info('✓ No stale PVs found — monitoring storage is healthy'); return; }

    warn(`Found ${stale.length} stale PV(s) pinned to dead node(s)`);

    for (const entry of stale) {
        warn(`  Stale PV: ${entry.pvName} → PVC: ${entry.pvcName} (pinned to dead node: ${entry.deadNode})`);

        if (entry.pvcName) {
            const r = run(
                ['kubectl', 'delete', 'pvc', entry.pvcName, '-n', entry.pvcNamespace,
                    '--ignore-not-found=true', '--wait=false'],
                { check: false, env: kcEnv },
            );
            if (r.ok) info(`  ✓ Deleted PVC: ${entry.pvcName}`);
            else      warn(`  ✗ Failed to delete PVC: ${entry.pvcName}`);
        }

        const r = run(
            ['kubectl', 'delete', 'pv', entry.pvName, '--ignore-not-found=true', '--wait=false'],
            { check: false, env: kcEnv },
        );
        if (r.ok) info(`  ✓ Deleted PV: ${entry.pvName}`);
        else      warn(`  ✗ Failed to delete PV: ${entry.pvName}`);
    }

    info('Stale PV cleanup complete. ArgoCD will recreate them on the next sync.');
};

// =============================================================================
// Step 5 — Verify cluster membership and correct label drift
// =============================================================================

const verifyClusterMembership = async (cfg: WorkerConfig): Promise<void> => {
    const hostname = resolveHostname();
    if (!hostname) { warn('Could not resolve hostname — skipping membership verification'); return; }

    info(`Verifying cluster membership for node: ${hostname}`);
    const kcEnv = await resolveWorkerKubeconfig(cfg);

    const nodeRes = run(
        ['kubectl', 'get', 'node', hostname, '--no-headers'],
        { check: false, timeout: 30_000, env: kcEnv },
    );
    const isRegistered = nodeRes.ok && nodeRes.stdout.includes(hostname);

    if (isRegistered) {
        info(`✓ Node ${hostname} is registered in the cluster`);

        const expectedLabels = parseLabelString(buildNodeLabels(cfg));
        const labelsRes = run(
            ['kubectl', 'get', 'node', hostname, '-o', 'jsonpath={.metadata.labels}'],
            { check: false, timeout: 30_000, env: kcEnv },
        );
        let actualLabels: Record<string, string> = {};
        if (labelsRes.ok && labelsRes.stdout.trim()) {
            try { actualLabels = JSON.parse(labelsRes.stdout.trim()) as Record<string, string>; } catch { /* ignore */ }
        }

        const mismatched = Object.entries(expectedLabels).filter(([k, v]) => actualLabels[k] !== v);
        if (mismatched.length === 0) {
            info(`✓ All labels correct: ${cfg.nodeLabel}`);
            return;
        }

        warn(`Label drift detected on ${hostname}: ${mismatched.length} label(s) need correction`);
        for (const [key, value] of mismatched) {
            warn(`Label mismatch: ${key}=${actualLabels[key] ?? '<missing>'} → ${key}=${value}`);
            const r = run(
                ['kubectl', 'label', 'node', hostname, `${key}=${value}`, '--overwrite'],
                { check: false, timeout: 30_000, env: kcEnv },
            );
            if (r.ok) info(`✓ Corrected label: ${key}=${value}`);
            else      warn(`✗ Failed to correct label: ${key}=${value} (RBAC may require admin kubeconfig in SSM)`);
        }
        return;
    }

    // Node NOT registered — self-healing re-join
    warn(`Node ${hostname} is NOT registered in the cluster — triggering self-healing re-join`);

    await checkCaMismatch(cfg);

    if (existsSync(KUBELET_CONF)) {
        warn('kubelet.conf exists but node not registered — removing to allow re-join');
        run(['kubeadm', 'reset', '-f'], { check: false });
        try { unlinkSync(KUBELET_CONF); } catch { /* ignore */ }
    }

    try {
        const endpoint = await resolveControlPlaneEndpoint(cfg);
        await waitForApiServerReachable(endpoint);
        await doJoin(endpoint, cfg);
        await waitForKubelet();
        info('✓ Self-healing re-join completed successfully');
    } catch (e) {
        warn(`Self-healing re-join failed: ${e}`);
    }
};

// =============================================================================
// main
// =============================================================================

export const main = async (): Promise<void> => {
    const cfg = fromEnv();

    await runStep('validate-ami',              () => validateAmi(),                     cfg);
    await runStep('join-cluster',              () => joinCluster(cfg),                  cfg);
    await runStep('register-instance',         () => registerInstance(cfg),             cfg);
    await runStep('install-cloudwatch-agent',  () => installCloudwatchAgent(cfg),       cfg, CW_AGENT_MARKER);
    await runStep('clean-stale-pvs',           () => cleanStalePvs(cfg),               cfg, STALE_PV_CLEANUP_MARKER);
    await runStep('verify-cluster-membership', () => verifyClusterMembership(cfg),      cfg);
};

if (fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch(err => {
        error('Worker bootstrap FAILED', { error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
    });
}
