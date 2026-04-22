// @format

/**
 * @module tls-cert
 * Back up and restore Kubernetes TLS/Opaque Secrets via SSM Parameter Store.
 *
 * Prevents Let's Encrypt rate-limit exhaustion on instance replacement by
 * persisting cert-manager Secrets to SSM `SecureString` after issuance and
 * restoring them before cert-manager starts on the next bootstrap run.
 *
 * **SSM path:** `{ssmPrefix}/tls/{secretName}`
 *
 * **Stored payload:**
 * ```json
 * { "data": { "tls.crt": "<base64>", "tls.key": "<base64>" }, "type": "kubernetes.io/tls" }
 * ```
 *
 * The `data` values are stored exactly as `kubectl` returns them — already
 * base64-encoded — so restore can write the `data:` block of a Secret manifest
 * directly without a decode/re-encode round-trip.
 *
 * **Supported Secret types:**
 * - `kubernetes.io/tls` — cert + key (e.g. `ops-tls-cert`)
 * - `Opaque` — arbitrary fields (e.g. `letsencrypt-account-key`)
 */

import type { Config } from './config.js';
import { kubectlApplyStdin, log, run, ssmGet, ssmPut } from './runner.js';

// =============================================================================
// Internal types
// =============================================================================

/** Shape of the JSON payload stored in SSM. */
interface SsmPayload {
    data: Record<string, string>;
    type: string;
}

// =============================================================================
// Backup: K8s Secret → SSM
// =============================================================================

/**
 * Reads a Kubernetes Secret and stores its data in SSM Parameter Store.
 *
 * @remarks
 * The Secret's `.data` map (already base64-encoded) and `.type` field are
 * JSON-serialised and written as an `Advanced` `SecureString` parameter.
 * Advanced tier supports up to 8 KB, which comfortably fits any TLS chain.
 *
 * In dry-run mode (`cfg.dryRun === true`) the function logs what it *would*
 * do and returns `true` without contacting SSM.
 *
 * @param cfg        - Bootstrap config (supplies `ssmPrefix`, `awsRegion`, `kubeconfig`, `dryRun`).
 * @param secretName - Name of the Kubernetes Secret to back up.
 * @param namespace  - Namespace containing the Secret.
 * @returns `true` on success; `false` when the Secret is missing or SSM write fails.
 *
 * @example
 * ```typescript
 * const ok = await backupCert(cfg, 'ops-tls-cert', 'kube-system');
 * if (!ok) log('  ⚠ TLS backup skipped (non-fatal)');
 * ```
 */
export const backupCert = async (
    cfg: Config,
    secretName: string,
    namespace: string,
): Promise<boolean> => {
    log(`=== Backup: ${namespace}/${secretName} → SSM ===`);

    const result = run(
        ['kubectl', 'get', 'secret', secretName, '-n', namespace, '-o', 'jsonpath={.data},{.type}'],
        cfg,
        { check: false, capture: true },
    );

    if (!result.ok || !result.stdout) {
        log(`  ⚠ Secret ${namespace}/${secretName} not found — nothing to back up`);
        return false;
    }

    // Output format: "{...data json...},{type string}"
    // data JSON may contain commas, so split at the last '}'
    const raw = result.stdout.trim();
    const lastBrace = raw.lastIndexOf('}');
    if (lastBrace === -1) {
        log(`  ⚠ Unexpected Secret output format: ${raw.slice(0, 200)}`);
        return false;
    }

    const dataJson   = raw.slice(0, lastBrace + 1);
    const secretType = raw.slice(lastBrace + 2); // skip '},'

    let secretData: Record<string, string>;
    try {
        secretData = JSON.parse(dataJson) as Record<string, string>;
    } catch {
        log(`  ⚠ Failed to parse Secret data JSON: ${dataJson.slice(0, 200)}`);
        return false;
    }

    if (Object.keys(secretData).length === 0) {
        log('  ⚠ Secret has no data fields — skipping backup');
        return false;
    }

    const summary = Object.entries(secretData).map(([k, v]) => `${k}=${v.length}ch`).join(', ');
    log(`  ✓ Secret read (type=${secretType}, ${summary})`);

    if (cfg.dryRun) {
        log(`  [DRY-RUN] Would write to SSM: ${cfg.ssmPrefix}/tls/${secretName}`);
        return true;
    }

    const paramName = `${cfg.ssmPrefix}/tls/${secretName}`;
    const payload: SsmPayload = { data: secretData, type: secretType };

    await ssmPut(cfg, paramName, JSON.stringify(payload), {
        type: 'SecureString',
        overwrite: true,
        description: `K8s Secret backup: ${namespace}/${secretName} (type=${secretType})`,
        tier: 'Advanced',
    });
    log(`  ✓ Stored in SSM: ${paramName}`);
    return true;
};

// =============================================================================
// Restore: SSM → K8s Secret
// =============================================================================

/**
 * Reads Secret data from SSM Parameter Store and creates the Kubernetes Secret.
 *
 * @remarks
 * If the Secret already exists in the cluster it is left untouched — cert-manager
 * will manage it from that point.
 *
 * The restore avoids temp files by building a Secret manifest directly from the
 * stored base64 values and piping it through `kubectlApplyStdin`.  This works
 * for both `kubernetes.io/tls` and `Opaque` Secret types.
 *
 * A legacy SSM payload format (flat `{ "tls.crt": "...", "tls.key": "..." }`
 * without the `data`/`type` envelope) is recognised and handled automatically
 * by defaulting to `type: kubernetes.io/tls`.
 *
 * In dry-run mode the function logs its intent and returns `true` immediately.
 *
 * @param cfg        - Bootstrap config (supplies `ssmPrefix`, `awsRegion`, `kubeconfig`, `dryRun`).
 * @param secretName - Name of the Kubernetes Secret to restore.
 * @param namespace  - Namespace to create the Secret in (created if absent).
 * @returns `true` when the Secret exists or was successfully restored; `false` on failure.
 *
 * @example
 * ```typescript
 * const ok = await restoreCert(cfg, 'letsencrypt-account-key', 'cert-manager');
 * if (!ok) log('  ⚠ No backup found — cert-manager will request a new certificate');
 * ```
 */
export const restoreCert = async (
    cfg: Config,
    secretName: string,
    namespace: string,
): Promise<boolean> => {
    log(`=== Restore: SSM → ${namespace}/${secretName} ===`);

    // Secret already present — nothing to do
    const existing = run(
        ['kubectl', 'get', 'secret', secretName, '-n', namespace],
        cfg,
        { check: false, capture: true },
    );
    if (existing.ok) {
        log(`  ✓ Secret ${namespace}/${secretName} already exists — skipping restore`);
        return true;
    }

    if (cfg.dryRun) {
        log('  [DRY-RUN] Would read SSM and apply Secret manifest');
        return true;
    }

    const paramName = `${cfg.ssmPrefix}/tls/${secretName}`;
    log(`  → Reading from SSM: ${paramName}`);

    const raw = await ssmGet(cfg, paramName, true);
    if (!raw) {
        log(`  ⚠ SSM parameter not found: ${paramName}`);
        log('    cert-manager will request a new certificate');
        return false;
    }

    let secretData: Record<string, string>;
    let secretType: string;
    try {
        const parsed = JSON.parse(raw) as SsmPayload | Record<string, string>;
        // New format: { data: {...}, type: "..." }
        // Legacy format (pre-envelope): flat { "tls.crt": "...", "tls.key": "..." }
        if ('data' in parsed && 'type' in parsed) {
            secretData = (parsed as SsmPayload).data;
            secretType = (parsed as SsmPayload).type;
        } else {
            secretData = parsed as Record<string, string>;
            secretType = 'kubernetes.io/tls';
        }
    } catch {
        log('  ⚠ Failed to parse SSM payload JSON');
        return false;
    }

    log(`  ✓ SSM payload read (type=${secretType}, fields=${Object.keys(secretData).join(', ')})`);

    // Ensure namespace exists (idempotent via server-side dry-run + apply)
    const nsYaml = run(
        ['kubectl', 'create', 'namespace', namespace, '--dry-run=client', '-o', 'yaml'],
        cfg,
        { check: false, capture: true },
    );
    if (nsYaml.ok && nsYaml.stdout) {
        kubectlApplyStdin(nsYaml.stdout, cfg, { check: false });
    }

    // Build Secret manifest — data values are already base64-encoded by kubectl
    const dataBlock = Object.entries(secretData)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join('\n');

    const manifest = `apiVersion: v1
kind: Secret
metadata:
  name: ${secretName}
  namespace: ${namespace}
type: ${secretType}
data:
${dataBlock}
`;

    const applyResult = kubectlApplyStdin(manifest, cfg, { check: false });
    if (applyResult.ok) {
        log(`  ✓ Secret ${namespace}/${secretName} restored from SSM`);
        return true;
    }
    log(`  ⚠ Failed to apply Secret manifest: ${applyResult.stderr}`);
    return false;
};
