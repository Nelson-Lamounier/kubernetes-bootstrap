// @format
// Structured JSON logger for CloudWatch Logs Insights with SSM step-status markers.

import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

const ts = (): string => new Date().toISOString();

const emit = (
    step: string,
    level: string,
    status: string,
    extra?: Record<string, unknown>,
): void => {
    const event: Record<string, unknown> = { ts: ts(), step, level, status, ...extra };
    process.stdout.write(JSON.stringify(event) + '\n');
};

const writeStatus = async (
    ssmPrefix: string | null,
    awsRegion: string | null,
    step: string,
    status: string,
    extra?: { elapsed_s?: number; error?: string },
): Promise<void> => {
    if (!ssmPrefix || !awsRegion) return;

    const paramName = `${ssmPrefix}/bootstrap/status/argocd/${step}`;
    const payload: Record<string, unknown> = {
        script: 'bootstrap_argocd',
        step,
        status,
        updated_at: ts(),
        ...extra,
    };
    if (extra?.error) payload['error'] = extra.error.slice(0, 3000);

    try {
        const client = new SSMClient({ region: awsRegion });
        await client.send(new PutParameterCommand({
            Name: paramName,
            Value: JSON.stringify(payload),
            Type: 'String',
            Overwrite: true,
        }));
    } catch (err) {
        process.stdout.write(JSON.stringify({
            ts: ts(), level: 'warn', step,
            msg: `SSM step-status write failed (non-fatal): ${err}`,
        }) + '\n');
    }
};

export class BootstrapLogger {
    constructor(
        private readonly ssmPrefix: string | null,
        private readonly awsRegion: string | null,
    ) {}

    async step<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
        const start = Date.now();
        emit(name, 'info', 'start');
        await writeStatus(this.ssmPrefix, this.awsRegion, name, 'running');
        try {
            const result = await fn();
            const elapsedMs = Date.now() - start;
            emit(name, 'info', 'success', { duration_ms: elapsedMs });
            await writeStatus(this.ssmPrefix, this.awsRegion, name, 'success', {
                elapsed_s: elapsedMs / 1000,
            });
            return result;
        } catch (err) {
            const elapsedMs = Date.now() - start;
            const msg = err instanceof Error ? err.message : String(err);
            emit(name, 'error', 'fail', { msg, duration_ms: elapsedMs });
            await writeStatus(this.ssmPrefix, this.awsRegion, name, 'failed', {
                elapsed_s: elapsedMs / 1000,
                error: msg,
            });
            throw err;
        }
    }

    skip(name: string, msg: string): void {
        emit(name, 'info', 'skip', { msg });
        writeStatus(this.ssmPrefix, this.awsRegion, name, 'skipped').catch(() => {});
    }
}
