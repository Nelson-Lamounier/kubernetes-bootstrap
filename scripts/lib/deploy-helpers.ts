import { execFileSync } from 'node:child_process';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import logger from './logger.js';

// =============================================================================
// SSM — secret resolution (deploy_helpers/ssm.py)
// =============================================================================

export type SecretMap = Record<string, string>; // ssmSuffix → envVarName

const isPlaceholder = (v: string, envVar: string): boolean =>
    v === `\${${envVar}}` || v === `__${envVar}__`;

export async function resolveSecrets(
    client: SSMClient,
    ssmPrefix: string,
    secretMap: SecretMap,
): Promise<Record<string, string>> {
    const secrets: Record<string, string> = {};

    for (const [paramName, envVar] of Object.entries(secretMap)) {
        const existing = process.env[envVar] ?? '';
        if (existing && !isPlaceholder(existing, envVar)) {
            logger.info(`Using environment override: ${envVar}`);
            secrets[envVar] = existing;
            continue;
        }

        const ssmPath = `${ssmPrefix}/${paramName}`;
        try {
            const resp = await client.send(
                new GetParameterCommand({ Name: ssmPath, WithDecryption: true }),
            );
            const value = resp.Parameter?.Value;
            if (value) secrets[envVar] = value;
        } catch (err: unknown) {
            const name = (err as { name?: string }).name;
            if (name === 'ParameterNotFound') {
                logger.warn(`Not found in SSM: ${envVar} (${ssmPath})`);
            } else {
                logger.warn(`SSM resolution failed: ${envVar}: ${String(err)}`);
            }
        }
    }

    return secrets;
}

// =============================================================================
// BFF — edge URL resolution (deploy_helpers/bff.py)
//
// KubernetesEdgeStack is ALWAYS deployed to us-east-1 (CloudFront WAF
// requirement). /bedrock-*/admin-api-url and /bedrock-*/public-api-url live
// there regardless of the cluster's primary region.
// =============================================================================

export const EDGE_REGION         = 'us-east-1';
export const FALLBACK_ADMIN_API  = 'http://admin-api.admin-api:3002';
export const FALLBACK_PUBLIC_API = 'http://public-api.public-api:3001';

const BFF_SSM_MAP: SecretMap = {
    'admin-api-url':  'ADMIN_API_URL',
    'public-api-url': 'PUBLIC_API_URL',
};

export interface BffUrls {
    readonly adminApiUrl:  string;
    readonly publicApiUrl: string;
}

export function makeEdgeSsmClient(): SSMClient {
    return new SSMClient({ region: EDGE_REGION });
}

export async function resolveBffUrls(
    shortEnv: string,
    edgeClient: SSMClient = makeEdgeSsmClient(),
): Promise<BffUrls> {
    const bedrockPrefix = `/bedrock-${shortEnv}`;
    const resolved = await resolveSecrets(edgeClient, bedrockPrefix, BFF_SSM_MAP);

    const adminApiUrl = resolved['ADMIN_API_URL'] || (
        logger.warn('ADMIN_API_URL not in SSM — using in-cluster fallback'),
        FALLBACK_ADMIN_API
    );
    const publicApiUrl = resolved['PUBLIC_API_URL'] || (
        logger.warn('PUBLIC_API_URL not in SSM — using in-cluster fallback'),
        FALLBACK_PUBLIC_API
    );

    return { adminApiUrl, publicApiUrl };
}

// =============================================================================
// Kubernetes — namespace / secret / configmap upserts (deploy_helpers/k8s.py)
//
// Uses execFileSync (no shell) — arguments are passed directly to kubectl so
// secret values with shell-special characters are safe.
// The dry-run/apply upsert pattern replaces SDK create+409-replace logic.
// =============================================================================

function kubectl(kubeconfig: string, args: string[], input?: string): string {
    return execFileSync('kubectl', ['--kubeconfig', kubeconfig, ...args], {
        encoding: 'utf-8',
        stdio:    input !== undefined ? 'pipe' : ['pipe', 'pipe', 'pipe'],
        input,
    }).trim();
}

export function ensureNamespace(kubeconfig: string, namespace: string): void {
    const found = kubectl(kubeconfig, ['get', 'namespace', namespace, '--ignore-not-found']);
    if (found) return;
    kubectl(kubeconfig, ['create', 'namespace', namespace]);
    logger.success(`Namespace created: ${namespace}`);
}

export function upsertSecret(
    kubeconfig: string,
    name: string,
    namespace: string,
    data: Record<string, string>,
): void {
    const fromLiterals = Object.entries(data).map(([k, v]) => `--from-literal=${k}=${v}`);
    const yaml = kubectl(kubeconfig, [
        'create', 'secret', 'generic', name, '-n', namespace,
        ...fromLiterals, '--dry-run=client', '-o', 'yaml',
    ]);
    kubectl(kubeconfig, ['apply', '-f', '-'], yaml);
    logger.success(`Secret upserted: ${name} in ${namespace}`);
}

export function upsertConfigmap(
    kubeconfig: string,
    name: string,
    namespace: string,
    data: Record<string, string>,
): void {
    const fromLiterals = Object.entries(data).map(([k, v]) => `--from-literal=${k}=${v}`);
    const yaml = kubectl(kubeconfig, [
        'create', 'configmap', name, '-n', namespace,
        ...fromLiterals, '--dry-run=client', '-o', 'yaml',
    ]);
    kubectl(kubeconfig, ['apply', '-f', '-'], yaml);
    logger.success(`ConfigMap upserted: ${name} in ${namespace}`);
}

// =============================================================================
// S3 — manifest pull (deploy_helpers/s3.py)
// =============================================================================

export function syncFromS3(
    bucket: string,
    keyPrefix: string,
    targetDir: string,
    region: string,
): void {
    const src = `s3://${bucket}/${keyPrefix}/`;
    logger.info(`Syncing from S3: ${src} → ${targetDir}`);
    execFileSync('aws', ['s3', 'sync', src, `${targetDir}/`, '--region', region], {
        encoding: 'utf-8',
        stdio: 'inherit',
    });
    execFileSync('find', [targetDir, '-name', '*.sh', '-exec', 'chmod', '+x', '{}', ';'], {
        encoding: 'utf-8',
        stdio: 'pipe',
    });
    logger.success(`S3 sync complete: ${src}`);
}
