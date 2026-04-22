#!/usr/bin/env tsx
/**
 * @format
 * @module worker
 * Worker Node Bootstrap — all 6 steps, single file.
 *
 * Migrated from boot/steps/wk/ (5 Python files, ~600 lines).
 * AWS SDK v3 (SSM) replaces boto3 subprocess calls.
 *
 * **Step sequence**
 * 1. `validate-ami`              — assert required binaries, kernel modules, sysctl.
 * 2. `join-cluster`              — CA mismatch check, kubeadm join with retry, kubelet wait.
 * 3. `register-instance`         — write instance-id → hostname mapping to SSM.
 * 4. `install-cloudwatch-agent`  — configure and start CW agent for log shipping.
 * 5. `clean-stale-pvs`           — delete PVs pinned to dead monitoring nodes.
 * 6. `verify-cluster-membership` — confirm registration and correct label drift.
 *
 * Run: `npx tsx boot/steps/worker.ts`
 * Entry: orchestrator dispatches here when `--mode worker` is passed.
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
    ensureEcrCredentialProvider,
    error,
    imds,
    info,
    makeRunStep,
    poll,
    run,
    sleep,
    ssmClient,
    ssmGet,
    ssmPut,
    validateKubeadmToken,
    warn,
} from './common.js';

const runStep = makeRunStep('worker');

// =============================================================================
// Types
// =============================================================================

/**
 * Immutable runtime configuration for the worker bootstrap.
 * Populated by {@link fromEnv} from environment variables.
 */
export interface WorkerConfig {
    /** SSM key prefix, e.g. `/k8s/development`. */
    readonly ssmPrefix: string;
    /** AWS region for all SDK calls. */
    readonly awsRegion: string;
    /** Short environment name (e.g. `"development"`). */
    readonly environment: string;
    /** CloudWatch log group name for worker log shipping. */
    readonly logGroupName: string;
    /**
     * Comma-separated `key=value` node label string applied via `kubelet --node-labels`.
     * Example: `"role=worker,workload=frontend"`.
     */
    readonly nodeLabel: string;
    /**
     * Node pool identifier appended to {@link nodeLabel} when set.
     * Used by Helm `nodeSelector` rules to schedule pods on the correct pool.
     * Example: `"general"`, `"monitoring"`.
     */
    readonly nodePool: string;
    /** Maximum number of `kubeadm join` attempts before the step fails. */
    readonly joinMaxRetries: number;
    /** Seconds to wait between `kubeadm join` retry attempts. */
    readonly joinRetryInterval: number;
}

/**
 * A stale PersistentVolume entry — a PV bound to a monitoring PVC whose
 * node affinity points to a node that no longer exists in the cluster.
 */
export interface StalePvEntry {
    /** Name of the PersistentVolume resource. */
    pvName: string;
    /** Name of the bound PersistentVolumeClaim. */
    pvcName: string;
    /** Namespace containing the PVC (always `"monitoring"`). */
    pvcNamespace: string;
    /** Hostname of the dead node the PV is pinned to. */
    deadNode: string;
}

// =============================================================================
// Constants
// =============================================================================

/** Path written by `kubeadm join` on success; used for idempotency checks. */
const KUBELET_CONF            = '/etc/kubernetes/kubelet.conf';
/** Path to the cluster CA certificate (used for hash comparison). */
const CA_CERT_PATH            = '/etc/kubernetes/pki/ca.crt';
/** Path written by kubelet after a successful join. */
const KUBELET_CONFIG_FILE     = '/var/lib/kubelet/config.yaml';
/** Marker path for the stale PV cleanup step. */
const STALE_PV_CLEANUP_MARKER = '/tmp/.stale-pv-cleanup-done';
/** Marker path for the CloudWatch agent installation step. */
const CW_AGENT_MARKER         = '/tmp/.cw-agent-installed';
/** CloudWatch agent control binary path. */
const CW_AGENT_CTL            = '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl';
/** CloudWatch agent JSON config file path. */
const CW_AGENT_CONFIG_PATH    = '/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json';
/** Profile script that exports `LOG_GROUP_NAME` and other env vars. */
const K8S_ENV_FILE            = '/etc/profile.d/k8s-env.sh';
/** Temporary path for the admin kubeconfig fetched from SSM. */
const ADMIN_KUBECONFIG_TMP    = '/tmp/worker-admin.conf';

/** Total deadline for resolving the control-plane endpoint from SSM. */
const CP_MAX_WAIT_MS           = 300_000;
/** Total deadline for establishing TCP connectivity to the API server. */
const API_REACHABLE_TIMEOUT_MS = 300_000;
/** Poll interval for TCP reachability probes. */
const API_REACHABLE_POLL_MS    = 10_000;

/** Binaries that must be pre-baked into the Golden AMI. */
const REQUIRED_BINARIES       = ['containerd', 'kubeadm', 'kubelet', 'kubectl', 'helm'];
/** Kernel modules required for pod networking. */
const REQUIRED_KERNEL_MODULES = ['overlay', 'br_netfilter'];
/** Sysctl settings required for pod networking. */
const REQUIRED_SYSCTL: Record<string, string> = {
    'net.bridge.bridge-nf-call-iptables':  '1',
    'net.bridge.bridge-nf-call-ip6tables': '1',
    'net.ipv4.ip_forward':                 '1',
};

/**
 * Node label values that identify a monitoring worker.
 * Only monitoring workers trigger stale PV cleanup.
 */
const MONITORING_LABELS = new Set(['workload=monitoring', 'node-pool=monitoring']);

/** Log files to ship to CloudWatch for each worker instance. */
const CW_LOG_FILES = [
    { filePath: '/var/log/messages',              logStreamName: '{instance_id}/messages'   },
    { filePath: '/var/log/user-data.log',         logStreamName: '{instance_id}/user-data'  },
    { filePath: '/var/log/cloud-init-output.log', logStreamName: '{instance_id}/cloud-init' },
];

// =============================================================================
// Config
// =============================================================================

/**
 * Builds a {@link WorkerConfig} from environment variables.
 *
 * @remarks
 * All fields have defaults so the bootstrap can be tested locally without
 * a full SSM/EC2 environment:
 * - `SSM_PREFIX` → `/k8s/development`
 * - `AWS_REGION` → `eu-west-1`
 * - `ENVIRONMENT` → `development`
 * - `NODE_LABEL` → `role=worker`
 * - `JOIN_MAX_RETRIES` → `5`
 * - `JOIN_RETRY_INTERVAL` → `30` (seconds)
 *
 * @returns Populated, immutable {@link WorkerConfig}.
 */
export const fromEnv = (): WorkerConfig => ({
    ssmPrefix:         process.env.SSM_PREFIX          ?? '/k8s/development',
    awsRegion:         process.env.AWS_REGION          ?? 'eu-west-1',
    environment:       process.env.ENVIRONMENT         ?? 'development',
    logGroupName:      process.env.LOG_GROUP_NAME      ?? '',
    nodeLabel:         process.env.NODE_LABEL          ?? 'role=worker',
    nodePool:          process.env.NODE_POOL           ?? '',
    joinMaxRetries:    parseInt(process.env.JOIN_MAX_RETRIES    ?? '5',  10),
    joinRetryInterval: parseInt(process.env.JOIN_RETRY_INTERVAL ?? '30', 10),
});

// =============================================================================
// Hostname resolution
// =============================================================================

/**
 * Resolves the fully-qualified hostname for this worker node.
 *
 * @remarks
 * Prefers `hostname -f` so the FQDN is used (consistent with what kubeadm
 * registers in the cluster).  Falls back to the IMDS `local-hostname` when
 * `hostname -f` returns `localhost` or fails.
 *
 * @returns FQDN string, or `""` when neither source is available.
 */
const resolveHostname = (): string => {
    const r = run(['hostname', '-f'], { check: false });
    if (r.ok && r.stdout.trim() && r.stdout.trim() !== 'localhost') return r.stdout.trim();
    return imds('local-hostname');
};

// =============================================================================
// providerID patch (worker uses kubelet.conf, not admin.conf)
// =============================================================================

/**
 * Patches the Kubernetes `Node` object's `spec.providerID` field with the
 * AWS provider ID for this EC2 instance.
 *
 * @remarks
 * The provider ID format is `aws:///{availability-zone}/{instance-id}`.
 * This field is required by the AWS Cloud Controller Manager to associate the
 * Kubernetes node with the corresponding EC2 instance.
 *
 * Workers use `kubelet.conf` (not `admin.conf`) because they are not cluster
 * admins.  Patch failures are non-fatal — the AWS CCM will set the field
 * during node initialisation if it is absent.
 */
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

/**
 * Computes the SHA-256 hash of the local cluster CA public key.
 *
 * @remarks
 * The hash is computed using a shell pipe (`openssl x509 | openssl rsa |
 * openssl dgst | awk`) — there is no single-binary alternative for this
 * specific computation.  The shell string contains only static file paths,
 * not user input.
 *
 * @returns Hash string in the form `sha256:<hex>`, or `""` on failure.
 */
export const computeLocalCaHash = (): string => {
    const res = run(
        ['/bin/sh', '-c',
            `openssl x509 -pubkey -in ${CA_CERT_PATH} | openssl rsa -pubin -outform der 2>/dev/null | openssl dgst -sha256 -hex | awk '{print $2}'`],
        { check: false },
    );
    if (!res.ok || !res.stdout.trim()) return '';
    return `sha256:${res.stdout.trim()}`;
};

/**
 * Detects a CA certificate mismatch between the local node and the current
 * control plane, then resets the node if a mismatch is found.
 *
 * @remarks
 * A CA mismatch occurs when the control plane was replaced with a new
 * certificate authority (e.g. after a DR restore from a different cluster).
 * In this case the worker's existing PKI files are stale and `kubeadm join`
 * will fail with a TLS error — reset clears them so a clean re-join can proceed.
 *
 * Returns `false` (no mismatch) in three early-exit cases:
 * - No local CA cert found (fresh worker, first join).
 * - No `kubelet.conf` (never previously joined).
 * - CA hash not available in SSM (graceful degradation).
 *
 * @param cfg - Worker config supplying `ssmPrefix` and `awsRegion`.
 * @returns `true` when a mismatch was detected and the node was reset;
 *          `false` otherwise.
 */
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

/**
 * Waits for the control plane endpoint to appear in SSM Parameter Store,
 * then returns it.
 *
 * @remarks
 * Uses {@link poll} with a 10-second interval and a {@link CP_MAX_WAIT_MS}
 * deadline.  The worker may start before the control plane has finished
 * publishing its endpoint, so polling is necessary.
 *
 * @param cfg - Worker config supplying `ssmPrefix` and `awsRegion`.
 * @returns The resolved endpoint string (e.g. `"k8s-api.k8s.internal:6443"`).
 * @throws {Error} When the endpoint is not found within the deadline.
 */
export const resolveControlPlaneEndpoint = async (cfg: WorkerConfig): Promise<string> => {
    info('Resolving control plane endpoint from SSM...');
    const paramName = `${cfg.ssmPrefix}/control-plane-endpoint`;

    const endpoint = await poll(
        async () => {
            const v = await ssmGet(paramName, cfg.awsRegion);
            return (v && v !== 'None') ? v : null;
        },
        {
            timeoutMs:      CP_MAX_WAIT_MS,
            intervalMs:     10_000,
            label:          `control-plane-endpoint in SSM (${paramName})`,
            throwOnTimeout: true,
        },
    );

    // poll throws when throwOnTimeout=true, so endpoint is never null here.
    info(`Control plane endpoint: ${endpoint!}`);
    return endpoint!;
};

/**
 * Splits a `host:port` endpoint string into its components.
 *
 * @param endpoint - Endpoint string (e.g. `"k8s-api.k8s.internal:6443"`).
 * @returns Tuple of `[host, port]`. Port defaults to `6443` when absent.
 */
const parseHostPort = (endpoint: string): [string, number] => {
    const idx = endpoint.lastIndexOf(':');
    if (idx > 0) return [endpoint.slice(0, idx), parseInt(endpoint.slice(idx + 1), 10)];
    return [endpoint, 6443];
};

// =============================================================================
// TCP probe — uses node:net to avoid subprocess overhead
// =============================================================================

/**
 * Probes TCP connectivity to `host:port` with a 5-second timeout.
 *
 * @remarks
 * Uses `node:net` directly rather than spawning `nc` or `curl` — no subprocess
 * overhead and no dependency on external binaries being present.
 *
 * @param host - Target hostname or IP address.
 * @param port - Target TCP port.
 * @returns `true` when the connection succeeds; `false` on error or timeout.
 */
const tcpProbe = (host: string, port: number): Promise<boolean> =>
    new Promise(resolve => {
        const socket = net.createConnection({ host, port });
        socket.setTimeout(5_000);
        socket.on('connect', () => { socket.destroy(); resolve(true);  });
        socket.on('error',   () => resolve(false));
        socket.on('timeout', () => { socket.destroy(); resolve(false); });
    });

/**
 * Waits for TCP connectivity to the API server, polling with
 * {@link API_REACHABLE_POLL_MS} intervals up to {@link API_REACHABLE_TIMEOUT_MS}.
 *
 * @param endpoint - API server endpoint string (e.g. `"k8s-api.k8s.internal:6443"`).
 * @throws {Error} When the server is not reachable within the deadline.
 */
const waitForApiServerReachable = async (endpoint: string): Promise<void> => {
    const [host, port] = parseHostPort(endpoint);
    info(`Waiting for API server TCP connectivity: ${host}:${port} (timeout=${API_REACHABLE_TIMEOUT_MS / 1000}s)`);

    await poll(
        async () => (await tcpProbe(host, port)) ? true as const : null,
        {
            timeoutMs:      API_REACHABLE_TIMEOUT_MS,
            intervalMs:     API_REACHABLE_POLL_MS,
            label:          `API server TCP ${host}:${port}`,
            throwOnTimeout: true,
        },
    );

    info(`API server is reachable at ${host}:${port}`);
};

// =============================================================================
// Node label helpers
// =============================================================================

/**
 * Builds the complete node label string for the `--node-labels` kubelet flag.
 *
 * @remarks
 * When `NODE_POOL` is set and `node-pool` is not already present in
 * {@link WorkerConfig.nodeLabel}, `node-pool={nodePool}` is appended.
 * This gate ensures Helm `nodeSelector` rules can schedule pods on the
 * correct worker pool.
 *
 * @param cfg - Worker config supplying `nodeLabel` and `nodePool`.
 * @returns Combined label string (e.g. `"role=worker,node-pool=monitoring"`).
 *
 * @example
 * ```typescript
 * // NODE_LABEL=role=worker, NODE_POOL=monitoring
 * buildNodeLabels(cfg); // "role=worker,node-pool=monitoring"
 * ```
 */
export const buildNodeLabels = (cfg: WorkerConfig): string => {
    let labels = cfg.nodeLabel;
    if (cfg.nodePool && !labels.includes('node-pool')) {
        labels = labels ? `${labels},node-pool=${cfg.nodePool}` : `node-pool=${cfg.nodePool}`;
        info(`NODE_POOL=${cfg.nodePool} set — appended 'node-pool=${cfg.nodePool}' to node labels`);
    }
    return labels;
};

/**
 * Parses a comma-separated `key=value` label string into a plain object.
 *
 * @param labelStr - Label string (e.g. `"role=worker,node-pool=general"`).
 * @returns Record mapping label keys to values.
 *
 * @example
 * ```typescript
 * parseLabelString('role=worker,node-pool=monitoring');
 * // → { role: 'worker', 'node-pool': 'monitoring' }
 * ```
 */
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

/**
 * Waits for the kubelet service to become active and for `kubelet.conf` to
 * appear on disk after a `kubeadm join`.
 *
 * @remarks
 * Uses {@link poll} with a 1-second interval and a 60-second deadline.
 *
 * **Early-exit heuristic**: if 10 seconds have elapsed and `kubelet.conf` is
 * still absent, `kubeadm join` likely did not complete successfully.  In that
 * case polling is halted and the last 20 kubelet journal lines are logged to
 * aid diagnosis — but the function does not throw so the outer step can still
 * report the failure via the run summary.
 *
 * @returns Resolves when the kubelet is active, or after a timeout/early exit.
 */
export const waitForKubelet = async (): Promise<void> => {
    info('Waiting for kubelet to become active...');
    const startedAt = Date.now();
    let earlyExit = false;

    const reached = await poll(
        async () => {
            // Fail fast: if kubelet config is still absent after 10s, kubeadm join
            // did not write its output files — stop spinning and diagnose below.
            if (Date.now() - startedAt > 10_000 && !existsSync(KUBELET_CONFIG_FILE)) {
                earlyExit = true;
                return true as const; // truthy → stops poll; earlyExit flag carries intent
            }
            const active = run(['systemctl', 'is-active', '--quiet', 'kubelet'], { check: false });
            return (active.ok && existsSync(KUBELET_CONFIG_FILE)) ? true as const : null;
        },
        { timeoutMs: 60_000, intervalMs: 1_000, label: 'kubelet active', throwOnTimeout: false },
    );

    if (earlyExit) {
        warn('kubelet config absent after >10s — kubeadm join likely did not complete');
        run(['journalctl', '-u', 'kubelet', '--no-pager', '-n', '20'], { check: false });
    } else if (!reached) {
        warn('kubelet did not become active in 60s');
        run(['journalctl', '-u', 'kubelet', '--no-pager', '-n', '20'], { check: false });
    } else {
        info('kubelet is active');
    }
};

// =============================================================================
// Admin kubeconfig resolution (workers don't have admin.conf)
// =============================================================================

/**
 * Resolves an env record containing a kubeconfig path for admin-level kubectl
 * operations on a worker node.
 *
 * @remarks
 * Workers do not have `/etc/kubernetes/admin.conf`.  This function fetches a
 * base64-encoded admin kubeconfig from SSM, writes it to a temp file, and
 * returns an env record pointing to it.
 *
 * Fall-back chain:
 * 1. SSM `{ssmPrefix}/admin-kubeconfig-b64` (decrypted, base64-decoded).
 * 2. `kubelet.conf` (read-only; label corrections will be skipped by the caller).
 * 3. No kubeconfig (bare `process.env`; admin operations will fail).
 *
 * @param cfg - Worker config supplying `ssmPrefix` and `awsRegion`.
 * @returns An env record with `KUBECONFIG` set, or bare `process.env` as fallback.
 */
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

/**
 * Resolves the CloudWatch log group name for this worker.
 *
 * @remarks
 * Prefers `cfg.logGroupName` (set from `LOG_GROUP_NAME` env var).  When empty,
 * parses {@link K8S_ENV_FILE} for an `export LOG_GROUP_NAME=...` line.
 * This fallback handles the case where the env file is written by the cloud-init
 * user-data script but not exported into the bootstrap process environment.
 *
 * @param cfg - Worker config.
 * @returns Log group name string, or `""` when not found.
 */
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

/**
 * Asserts that all required binaries, kernel modules, and sysctl settings are
 * present on this EC2 instance.
 *
 * @remarks
 * The bootstrap script does **not** install packages — everything must be
 * pre-baked into the Golden AMI.  Validation runs first so an AMI that is
 * missing components fails fast with a descriptive error rather than failing
 * later with an opaque `command not found`.
 *
 * Checks:
 * - {@link REQUIRED_BINARIES} via `which`.
 * - {@link REQUIRED_KERNEL_MODULES} via `/proc/modules`.
 * - {@link REQUIRED_SYSCTL} via `/proc/sys/{key}`.
 *
 * @throws {Error} When any check fails, listing all missing items.
 */
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
        ...(missingBins.length  ? [`Missing binaries: ${missingBins.join(', ')}`]      : []),
        ...(missingMods.length  ? [`Missing kernel modules: ${missingMods.join(', ')}`] : []),
        ...(sysctlErrors.length ? [`Sysctl errors: ${sysctlErrors.join('; ')}`]        : []),
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
// Step 2 — Join cluster (inner retry loop)
// =============================================================================

/**
 * Performs the core `kubeadm join` sequence with retry logic.
 *
 * @remarks
 * **Parameter resolution strategy**
 * - `caHash` — stable for the cluster lifetime; resolved **once before the
 *   retry loop** (via a short {@link poll}) rather than re-fetched on every
 *   attempt.  This avoids 5× redundant SSM calls and makes the loop body smaller.
 * - `joinToken` — fetched **inside** every attempt because the token rotator
 *   refreshes SSM every 12 h.  On token expiry the loop discards the old token
 *   and the next attempt picks up the fresh one.
 *
 * **Error classification**
 * - Token not available → warn and retry (token may not be in SSM yet).
 * - Token expired → reset node and retry (token rotator will refresh SSM).
 * - API not reachable → retry after interval.
 * - All other failures → reset node and retry; throw after final attempt.
 *
 * @param endpoint - Control plane endpoint (e.g. `"k8s-api.k8s.internal:6443"`).
 * @param cfg      - Worker config.
 * @throws {Error} After {@link WorkerConfig.joinMaxRetries} failed attempts.
 */
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

    // CA hash is stable for the cluster lifetime — resolve once with a short
    // poll to handle transient SSM propagation delays, then reuse across all
    // join attempts.
    const caHash = await poll(
        () => ssmGet(caHashSsm, cfg.awsRegion).then(v => v || null),
        {
            timeoutMs:      30_000,
            intervalMs:     5_000,
            label:          `CA hash in SSM (${caHashSsm})`,
            throwOnTimeout: true,
        },
    );

    for (let attempt = 1; attempt <= cfg.joinMaxRetries; attempt++) {
        info(`=== kubeadm join attempt ${attempt}/${cfg.joinMaxRetries} ===`);

        // Join token is resolved per attempt: the token rotator refreshes SSM
        // every 12 h, so re-fetching here picks up a rotated token automatically.
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
                '--discovery-token-ca-cert-hash', caHash!],
            { check: false, timeout: 300_000 },
        );

        if (joinRes.ok) {
            info(`kubeadm join succeeded on attempt ${attempt}`);
            return;
        }

        // Token expiry detection: `kubeadm join` exits 1 with "token has expired"
        // or "unknown bootstrap token" in stderr/stdout.  Without this check the
        // loop would burn all remaining attempts against a permanently-invalid token.
        const combined     = (joinRes.stderr + joinRes.stdout).toLowerCase();
        const tokenExpired = combined.includes('token') && (
            combined.includes('expired') ||
            combined.includes('not found') ||
            combined.includes('unknown bootstrap token')
        );

        if (tokenExpired) {
            warn(
                `Join token EXPIRED on attempt ${attempt}/${cfg.joinMaxRetries}. ` +
                `Token rotator refreshes SSM every 12h. ` +
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

/**
 * Outer join step: CA mismatch guard + idempotency check + endpoint resolution
 * + {@link doJoin} inner retry loop.
 *
 * @remarks
 * Idempotency: `kubelet.conf` is written by `kubeadm join` on success.  When
 * it already exists the node is already joined and the step is skipped.
 *
 * @param cfg - Worker config.
 * @throws {Error} When `doJoin` exhausts all retry attempts.
 */
const joinCluster = async (cfg: WorkerConfig): Promise<void> => {
    const caReset = await checkCaMismatch(cfg);
    if (caReset) info('CA mismatch handled — proceeding to re-join cluster');

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

/**
 * Registers this worker's `instance-id → hostname` mapping in SSM Parameter Store.
 *
 * @remarks
 * Only runs when `NODE_POOL` is set — statically-provisioned workers (no ASG)
 * do not need pool-level discovery.
 *
 * The SSM path follows the convention:
 * `{ssmPrefix}/nodes/{nodePool}/{instanceId}` = `hostname`.
 *
 * This record is used by the pool discovery script to find all live nodes in a
 * pool without querying the Kubernetes API.  Failures are non-fatal.
 *
 * @param cfg - Worker config.
 */
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
                { Key: 'node-pool',   Value: cfg.nodePool    },
                { Key: 'environment', Value: cfg.environment },
            ],
        }));
        info(`✓ Instance registered: ${instanceId} → ${hostname} (pool=${cfg.nodePool})`);
    } catch (e) {
        warn(`SSM instance registration failed (non-fatal): ${e}`);
    }
};

// =============================================================================
// Step 3 — Install CloudWatch Agent
// =============================================================================

/**
 * Installs, configures, and starts the Amazon CloudWatch Agent on this worker.
 *
 * @remarks
 * Skipped when the log group name cannot be resolved (see {@link resolveLogGroupName}).
 *
 * Agent config ships the following log streams per instance:
 * - `{instance_id}/messages` — system messages
 * - `{instance_id}/user-data` — user-data script output
 * - `{instance_id}/cloud-init` — cloud-init output
 *
 * @param cfg - Worker config.
 */
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
        file_path:         lf.filePath,
        log_group_name:    logGroupName,
        log_stream_name:   lf.logStreamName,
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

/**
 * Scans the cluster's PersistentVolume list and returns entries whose node
 * affinity references a hostname that is no longer in `liveNodes`.
 *
 * @remarks
 * Only PVs bound to the `monitoring` namespace are considered — other namespaces
 * use storage classes that do not pin to specific nodes.
 *
 * The PV object traversal uses typed casts (`as`) because the `kubectl get pv -o json`
 * output is untyped.  Each cast is guarded with a null-coalescing default.
 *
 * @param pvListJson - Raw JSON string from `kubectl get pv -o json`.
 * @param liveNodes  - Set of currently registered node hostnames.
 * @returns Array of {@link StalePvEntry} objects (may be empty).
 */
export const findStalePvs = (pvListJson: string, liveNodes: Set<string>): StalePvEntry[] => {
    const stale: StalePvEntry[] = [];
    let pvList: { items: unknown[] };
    try { pvList = JSON.parse(pvListJson) as { items: unknown[] }; }
    catch { warn('Failed to parse PV list JSON — skipping stale PV cleanup'); return stale; }

    for (const pv of pvList.items as Record<string, unknown>[]) {
        const meta     = pv.metadata as Record<string, string> | undefined;
        const pvName   = meta?.name ?? '';
        const spec     = (pv.spec ?? {}) as Record<string, unknown>;
        const claimRef = (spec.claimRef ?? {}) as Record<string, string>;
        const pvcNs    = claimRef.namespace ?? '';
        const pvcName  = claimRef.name ?? '';
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

/**
 * Deletes PersistentVolumes and their bound PVCs that are pinned to dead nodes.
 *
 * @remarks
 * Only runs on monitoring workers (checked via {@link MONITORING_LABELS}).
 * Requires an admin kubeconfig for PV/PVC delete RBAC.
 *
 * After cleanup, ArgoCD will recreate the PVs on the next sync cycle.
 *
 * @param cfg - Worker config.
 */
const cleanStalePvs = async (cfg: WorkerConfig): Promise<void> => {
    if (!MONITORING_LABELS.has(cfg.nodeLabel)) {
        info(`Skipping stale PV cleanup — NODE_LABEL=${cfg.nodeLabel} (only monitoring workers trigger PV cleanup: ${[...MONITORING_LABELS].sort().join(', ')})`);
        return;
    }

    info('Waiting 10s for node registration before PV cleanup...');
    await sleep(10_000);

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

/**
 * Verifies this worker is registered in the cluster and corrects any label
 * drift from the expected values.
 *
 * @remarks
 * **Happy path** — node registered with correct labels → logs and returns.
 *
 * **Label drift** — node registered but labels differ from expected:
 * applies corrections via `kubectl label node --overwrite`.  Requires an admin
 * kubeconfig with write access to the `nodes` resource.
 *
 * **Node not registered** — triggers a self-healing re-join:
 * 1. Checks for CA mismatch and resets if needed.
 * 2. Removes stale `kubelet.conf`.
 * 3. Resolves endpoint and calls {@link doJoin}.
 * Failures in re-join are non-fatal (warns and returns).
 *
 * @param cfg - Worker config.
 */
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

/**
 * Entry point for the worker node bootstrap.
 *
 * @remarks
 * Runs the six steps in sequence using the {@link makeRunStep} step runner,
 * which provides SSM status tracking, idempotency via marker files, and
 * structured logging for every step.
 *
 * @throws {Error} When a non-idempotent step fails (e.g. `validate-ami`,
 *                 `join-cluster`).  The SSM Automation state machine will
 *                 catch this and mark the execution as failed.
 */
export const main = async (): Promise<void> => {
    const cfg = fromEnv();

    await runStep('validate-ami',              () => validateAmi(),                    cfg);
    await runStep('join-cluster',              () => joinCluster(cfg),                 cfg);
    await runStep('register-instance',         () => registerInstance(cfg),            cfg);
    await runStep('install-cloudwatch-agent',  () => installCloudwatchAgent(cfg),      cfg, CW_AGENT_MARKER);
    await runStep('clean-stale-pvs',           () => cleanStalePvs(cfg),              cfg, STALE_PV_CLEANUP_MARKER);
    await runStep('verify-cluster-membership', () => verifyClusterMembership(cfg),     cfg);
};

if (fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch(err => {
        error('Worker bootstrap FAILED', { error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
    });
}
