// @format
// Bootstrap configuration — populated from environment variables.

export interface Config {
    readonly ssmPrefix: string;
    readonly awsRegion: string;
    readonly kubeconfig: string;
    readonly argocdDir: string;
    readonly argocdCliVersion: string;
    readonly argoTimeout: number;
    readonly dryRun: boolean;
    readonly env: string;
}

export const parseArgs = (): Config => {
    const ssmPrefix  = process.env['SSM_PREFIX']        ?? '/k8s/development';
    const awsRegion  = process.env['AWS_REGION']        ?? 'eu-west-1';
    const kubeconfig = process.env['KUBECONFIG']        ?? '/etc/kubernetes/admin.conf';
    const argocdDir  = process.env['ARGOCD_DIR']        ?? '/data/k8s-bootstrap/system/argocd';
    const cliVersion = process.env['ARGOCD_CLI_VERSION']?? 'v2.14.11';
    const argoTimeout = parseInt(process.env['ARGO_TIMEOUT'] ?? '300', 10);
    const dryRun = process.argv.includes('--dry-run');

    return {
        ssmPrefix,
        awsRegion,
        kubeconfig,
        argocdDir,
        argocdCliVersion: cliVersion,
        argoTimeout,
        dryRun,
        env: ssmPrefix.replace(/\/$/, '').split('/').at(-1) ?? 'development',
    };
};
