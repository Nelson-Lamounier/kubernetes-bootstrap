// @format
// Shared runtime helpers: logging, subprocess runner, AWS client factories.

import { spawnSync } from 'node:child_process';
import {
    GetParameterCommand,
    PutParameterCommand,
    SSMClient,
} from '@aws-sdk/client-ssm';
import {
    CreateSecretCommand,
    GetSecretValueCommand,
    SecretsManagerClient,
    UpdateSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import type { Config } from './config.js';

export interface RunResult {
    readonly ok: boolean;
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number;
}

export const log = (msg: string): void => {
    process.stdout.write(msg + '\n');
};

// Run a subprocess with KUBECONFIG + HOME set.
// capture=false (default): output flows to parent stdout/stderr.
// capture=true: output is captured and returned.
export const run = (
    cmd: string[],
    cfg: Config,
    opts: { check?: boolean; capture?: boolean } = {},
): RunResult => {
    const { check = true, capture = false } = opts;

    if (cfg.dryRun) {
        log(`  [DRY-RUN] ${cmd.join(' ')}`);
        return { ok: true, stdout: '', stderr: '', code: 0 };
    }

    const runEnv: Record<string, string> = {
        ...process.env as Record<string, string>,
        KUBECONFIG: cfg.kubeconfig,
        HOME: process.env['HOME'] ?? '/root',
    };

    const result = spawnSync(cmd[0]!, cmd.slice(1), {
        env: runEnv,
        encoding: 'utf-8',
        stdio: capture ? 'pipe' : 'inherit',
    });

    const ok = result.status === 0 && result.error == null;

    if (check && !ok) {
        const detail = result.error?.message ?? result.stderr ?? '';
        throw new Error(`Command failed: ${cmd.join(' ')}\n${detail}`);
    }

    return {
        ok,
        stdout: ((result.stdout as string | null) ?? '').trim(),
        stderr: ((result.stderr as string | null) ?? '').trim(),
        code: result.status ?? 1,
    };
};

// Run kubectl apply with YAML piped on stdin.
export const kubectlApplyStdin = (
    yaml: string,
    cfg: Config,
    opts: { check?: boolean } = {},
): RunResult => {
    const { check = true } = opts;

    if (cfg.dryRun) {
        log(`  [DRY-RUN] kubectl apply -f - (${yaml.split('\n').length} lines)`);
        return { ok: true, stdout: '', stderr: '', code: 0 };
    }

    const runEnv: Record<string, string> = {
        ...process.env as Record<string, string>,
        KUBECONFIG: cfg.kubeconfig,
        HOME: process.env['HOME'] ?? '/root',
    };

    const result = spawnSync('kubectl', ['apply', '-f', '-'], {
        env: runEnv,
        encoding: 'utf-8',
        input: yaml,
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    const ok = result.status === 0 && result.error == null;
    if (check && !ok) {
        throw new Error(`kubectl apply failed:\n${result.stderr ?? ''}`);
    }
    return {
        ok,
        stdout: ((result.stdout as string | null) ?? '').trim(),
        stderr: ((result.stderr as string | null) ?? '').trim(),
        code: result.status ?? 1,
    };
};

export const getSsmClient = (cfg: Config): SSMClient =>
    new SSMClient({ region: cfg.awsRegion });

export const getSecretsClient = (cfg: Config): SecretsManagerClient =>
    new SecretsManagerClient({ region: cfg.awsRegion });

export const ssmGet = async (
    cfg: Config,
    name: string,
    decrypt = false,
): Promise<string | null> => {
    try {
        const res = await getSsmClient(cfg).send(
            new GetParameterCommand({ Name: name, WithDecryption: decrypt }),
        );
        return res.Parameter?.Value ?? null;
    } catch {
        return null;
    }
};

export const ssmPut = async (
    cfg: Config,
    name: string,
    value: string,
    opts: {
        type?: 'String' | 'SecureString';
        overwrite?: boolean;
        description?: string;
        tier?: 'Standard' | 'Advanced';
    } = {},
): Promise<void> => {
    const { type = 'String', overwrite = true, description, tier } = opts;
    await getSsmClient(cfg).send(new PutParameterCommand({
        Name: name,
        Value: value,
        Type: type,
        Overwrite: overwrite,
        Description: description,
        Tier: tier,
    }));
};

export const secretsManagerGet = async (
    cfg: Config,
    secretId: string,
): Promise<string | null> => {
    try {
        const res = await getSecretsClient(cfg).send(
            new GetSecretValueCommand({ SecretId: secretId }),
        );
        return res.SecretString ?? null;
    } catch {
        return null;
    }
};

export const secretsManagerPut = async (
    cfg: Config,
    name: string,
    value: string,
    description?: string,
): Promise<'created' | 'updated'> => {
    const client = getSecretsClient(cfg);
    try {
        await client.send(new CreateSecretCommand({
            Name: name,
            SecretString: value,
            Description: description,
        }));
        return 'created';
    } catch (err: unknown) {
        const code = (err as { name?: string }).name;
        if (code === 'ResourceExistsException') {
            await client.send(new UpdateSecretCommand({ SecretId: name, SecretString: value }));
            return 'updated';
        }
        throw err;
    }
};

export const sleep = (ms: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, ms));
