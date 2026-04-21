/**
 * @format
 * Kubernetes (kubeadm) Project - Resource Configurations
 *
 * Centralized resource configurations (policies, retention, instance sizing) by environment.
 * Configurations are "how it behaves" - policies, limits, settings.
 *
 * Usage:
 * ```typescript
 * import { getK8sConfigs } from '../config/kubernetes';
 * const configs = getK8sConfigs(Environment.DEVELOPMENT);
 * const instanceType = configs.instanceType; // 't3.medium'
 * ```
 */

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cdk from 'aws-cdk-lib/core';

import { type DeployableEnvironment, Environment } from '../environments.js';

// =============================================================================
// KUBERNETES CONSTANTS
// =============================================================================

/** Kubernetes API server port (standard for kubeadm) */
export const K8S_API_PORT = 6443;

/** Kubernetes version for kubeadm installation */
export const KUBERNETES_VERSION = '1.35.1';

/** Traefik HTTP port (deployed via manifests) */
export const TRAEFIK_HTTP_PORT = 80;

/** Traefik HTTPS port (deployed via manifests) */
export const TRAEFIK_HTTPS_PORT = 443;

/**
 * Tag used by DLM, EBS volumes, and EC2 instances for consistent identification.
 */
export const MONITORING_APP_TAG = {
    key: 'Application',
    value: 'Prometheus-Grafana',
} as const;

// =============================================================================
// ENVIRONMENT VARIABLE HELPER
// =============================================================================

function fromEnv(key: string): string | undefined {
    return process.env[key] || undefined;
}

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

export interface KubernetesClusterConfig {
    readonly kubernetesVersion: string;
    readonly podNetworkCidr: string;
    readonly serviceSubnet: string;
    readonly dataDir: string;
    readonly workerCount: number;
}

export interface K8sComputeConfig {
    readonly instanceType: ec2.InstanceType;
    readonly rootVolumeSizeGb: number;
    readonly detailedMonitoring: boolean;
    readonly useSignals: boolean;
    readonly signalsTimeoutMinutes: number;
}

export interface K8sStorageConfig {
    readonly volumeSizeGb: number;
    readonly mountPoint: string;
}

export interface K8sNetworkingConfig {
    readonly useElasticIp: boolean;
    readonly ssmOnlyAccess: boolean;
}

export interface K8sImageConfig {
    readonly amiSsmPath: string;
    readonly enableImageBuilder: boolean;
    readonly parentImageSsmPath: string;
    readonly bakedVersions: {
        readonly dockerCompose: string;
        readonly awsCli: string;
        readonly kubeadm: string;
        readonly containerd: string;
        readonly runc: string;
        readonly cniPlugins: string;
        readonly crictl: string;
        readonly calico: string;
        readonly ecrCredentialProvider: string;
        readonly k8sgpt: string;
        readonly argoCdCli: string;
        readonly kubectlArgoRollouts: string;
    };
}

export interface K8sSsmConfig {
    readonly enableStateManager: boolean;
    readonly associationSchedule: string;
    readonly maxConcurrency: string;
    readonly maxErrors: string;
}

export interface MonitoringWorkerConfig {
    readonly instanceType: ec2.InstanceType;
    readonly nodeLabel: string;
    readonly detailedMonitoring: boolean;
    readonly useSignals: boolean;
    readonly signalsTimeoutMinutes: number;
    readonly rootVolumeSizeGb: number;
    readonly useSpotInstances: boolean;
}

/** @deprecated Will be removed after K8s-native worker migration. */
export interface ArgocdWorkerConfig {
    readonly instanceType: ec2.InstanceType;
    readonly nodeLabel: string;
    readonly useSpotInstances: boolean;
    readonly detailedMonitoring: boolean;
    readonly useSignals: boolean;
    readonly signalsTimeoutMinutes: number;
    readonly rootVolumeSizeGb: number;
}

export interface KubernetesWorkerPoolConfig {
    readonly instanceType: ec2.InstanceType;
    readonly minCapacity: number;
    readonly maxCapacity: number;
    readonly useSpotInstances: boolean;
    readonly rootVolumeSizeGb: number;
    readonly detailedMonitoring: boolean;
    readonly useSignals: boolean;
    readonly signalsTimeoutMinutes: number;
}

export interface KubernetesWorkerPoolsConfig {
    readonly general: KubernetesWorkerPoolConfig;
    readonly monitoring: KubernetesWorkerPoolConfig;
}

// =============================================================================
// SECURITY GROUP CONFIGURATION (Data-Driven Port Rules)
// =============================================================================

export interface K8sPortRule {
    readonly port: number;
    readonly endPort?: number;
    readonly protocol: 'tcp' | 'udp';
    readonly source: 'self' | 'vpcCidr' | 'podCidr' | 'anyIpv4';
    readonly description: string;
}

export interface K8sSecurityGroupRoleConfig {
    readonly allowAllOutbound: boolean;
    readonly rules: K8sPortRule[];
}

export interface K8sSecurityGroupConfig {
    readonly clusterBase: K8sSecurityGroupRoleConfig;
    readonly controlPlane: K8sSecurityGroupRoleConfig;
    readonly ingress: K8sSecurityGroupRoleConfig;
    readonly monitoring: K8sSecurityGroupRoleConfig;
}

export interface K8sEdgeConfig {
    readonly domainName?: string;
    readonly hostedZoneId?: string;
    readonly crossAccountRoleArn?: string;
    readonly rateLimitPerIp: number;
    readonly enableRateLimiting: boolean;
    readonly enableIpReputationList: boolean;
    readonly opsSubdomain?: string;
    readonly baseDomain?: string;
    readonly runnersSubdomain?: string;
}

export interface K8sConfigs {
    readonly cluster: KubernetesClusterConfig;
    readonly compute: K8sComputeConfig;
    readonly storage: K8sStorageConfig;
    readonly networking: K8sNetworkingConfig;
    readonly securityGroups: K8sSecurityGroupConfig;
    readonly image: K8sImageConfig;
    readonly ssm: K8sSsmConfig;
    readonly edge: K8sEdgeConfig;
    /** @deprecated Legacy single-node worker config — kept during migration window. */
    readonly monitoringWorker: MonitoringWorkerConfig;
    /** @deprecated Legacy single-node worker config — kept during migration window. */
    readonly argocdWorker: ArgocdWorkerConfig;
    readonly workerPools: KubernetesWorkerPoolsConfig;
    readonly logRetention: logs.RetentionDays;
    readonly isProduction: boolean;
    readonly removalPolicy: cdk.RemovalPolicy;
    readonly createKmsKeys: boolean;
}

// =============================================================================
// DEFAULT SECURITY GROUP RULES
// =============================================================================

const DEFAULT_K8S_SECURITY_GROUPS: K8sSecurityGroupConfig = {
    clusterBase: {
        allowAllOutbound: true,
        rules: [
            { port: 2379, endPort: 2380, protocol: 'tcp', source: 'self', description: 'etcd client and peer (intra-cluster)' },
            { port: 6443, protocol: 'tcp', source: 'vpcCidr', description: 'K8s API server (intra-cluster / VPC)' },
            { port: 10250, protocol: 'tcp', source: 'self', description: 'kubelet API (intra-cluster)' },
            { port: 10257, protocol: 'tcp', source: 'self', description: 'kube-controller-manager (intra-cluster)' },
            { port: 10259, protocol: 'tcp', source: 'self', description: 'kube-scheduler (intra-cluster)' },
            { port: 4789, protocol: 'udp', source: 'self', description: 'VXLAN overlay networking (intra-cluster)' },
            { port: 179, protocol: 'tcp', source: 'self', description: 'Calico BGP peering (intra-cluster)' },
            { port: 30000, endPort: 32767, protocol: 'tcp', source: 'self', description: 'NodePort services (intra-cluster)' },
            { port: 53, protocol: 'tcp', source: 'self', description: 'CoreDNS TCP (intra-cluster)' },
            { port: 53, protocol: 'udp', source: 'self', description: 'CoreDNS UDP (intra-cluster)' },
            { port: 5473, protocol: 'tcp', source: 'self', description: 'Calico Typha (intra-cluster)' },
            { port: 9100, protocol: 'tcp', source: 'self', description: 'Traefik metrics (intra-cluster)' },
            { port: 9101, protocol: 'tcp', source: 'self', description: 'Node Exporter metrics (intra-cluster)' },
            { port: 6443, protocol: 'tcp', source: 'podCidr', description: 'K8s API server (from pods)' },
            { port: 10250, protocol: 'tcp', source: 'podCidr', description: 'kubelet API (from pods)' },
            { port: 53, protocol: 'udp', source: 'podCidr', description: 'CoreDNS UDP (from pods)' },
            { port: 53, protocol: 'tcp', source: 'podCidr', description: 'CoreDNS TCP (from pods)' },
            { port: 9100, protocol: 'tcp', source: 'podCidr', description: 'Traefik metrics (from pods)' },
            { port: 9101, protocol: 'tcp', source: 'podCidr', description: 'Node Exporter metrics (from pods)' },
        ],
    },
    controlPlane: {
        allowAllOutbound: false,
        rules: [
            { port: 6443, protocol: 'tcp', source: 'vpcCidr', description: 'K8s API from VPC (SSM port-forwarding)' },
        ],
    },
    monitoring: {
        allowAllOutbound: false,
        rules: [
            { port: 9090, protocol: 'tcp', source: 'vpcCidr', description: 'Prometheus metrics from VPC' },
            { port: 9100, protocol: 'tcp', source: 'vpcCidr', description: 'Node Exporter metrics from VPC' },
            { port: 9100, protocol: 'tcp', source: 'podCidr', description: 'Node Exporter metrics from pods (Prometheus scraping)' },
            { port: 30100, protocol: 'tcp', source: 'vpcCidr', description: 'Loki push API from VPC (cross-stack log shipping)' },
            { port: 30417, protocol: 'tcp', source: 'vpcCidr', description: 'Tempo OTLP gRPC from VPC (cross-stack trace shipping)' },
        ],
    },
    ingress: {
        allowAllOutbound: false,
        rules: [
             { port: 80, protocol: 'tcp', source: 'vpcCidr', description: 'HTTP health checks from NLB' },
        ],
    },
};

// =============================================================================
// CONFIGURATIONS BY ENVIRONMENT
// =============================================================================

export const K8S_CONFIGS: Record<DeployableEnvironment, K8sConfigs> = {
    [Environment.DEVELOPMENT]: {
        cluster: {
            kubernetesVersion: KUBERNETES_VERSION,
            podNetworkCidr: '192.168.0.0/16',
            serviceSubnet: '10.96.0.0/12',
            dataDir: '/data/kubernetes',
            workerCount: 2,
        },
        compute: {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
            rootVolumeSizeGb: 30,
            detailedMonitoring: false,
            useSignals: true,
            signalsTimeoutMinutes: 40,
        },
        storage: {
            volumeSizeGb: 30,
            mountPoint: '/data',
        },
        networking: {
            useElasticIp: true,
            ssmOnlyAccess: true,
        },
        securityGroups: DEFAULT_K8S_SECURITY_GROUPS,
        image: {
            amiSsmPath: '/k8s/development/golden-ami/latest',
            enableImageBuilder: true,
            parentImageSsmPath: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64',
            bakedVersions: {
                dockerCompose: 'v2.24.0',
                awsCli: '2.x',
                kubeadm: KUBERNETES_VERSION,
                containerd: '1.7.24',
                runc: '1.2.4',
                cniPlugins: '1.6.1',
                crictl: '1.32.0',
                calico: 'v3.29.3',
                ecrCredentialProvider: 'v1.31.0',
                k8sgpt: '0.4.31',
                argoCdCli: 'v2.14.11',
                kubectlArgoRollouts: 'v1.8.3',
            },
        },
        ssm: {
            enableStateManager: true,
            associationSchedule: 'rate(30 minutes)',
            maxConcurrency: '1',
            maxErrors: '0',
        },
        edge: {
            domainName: fromEnv('MONITOR_DOMAIN_NAME') ?? 'monitoring.dev.nelsonlamounier.com',
            hostedZoneId: fromEnv('HOSTED_ZONE_ID'),
            crossAccountRoleArn: fromEnv('CROSS_ACCOUNT_ROLE_ARN'),
            rateLimitPerIp: 2000,
            enableRateLimiting: true,
            enableIpReputationList: true,
            opsSubdomain: 'ops',
            baseDomain: 'nelsonlamounier.com',
            runnersSubdomain: 'runners',
        },
        monitoringWorker: {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
            nodeLabel: 'workload=monitoring,environment=development',
            detailedMonitoring: false,
            useSignals: true,
            signalsTimeoutMinutes: 40,
            rootVolumeSizeGb: 30,
            useSpotInstances: true,
        },
        argocdWorker: {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
            nodeLabel: 'workload=argocd,environment=development',
            useSpotInstances: true,
            detailedMonitoring: false,
            useSignals: true,
            signalsTimeoutMinutes: 40,
            rootVolumeSizeGb: 30,
        },
        workerPools: {
            general: {
                instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
                minCapacity: 2,
                maxCapacity: 4,
                useSpotInstances: true,
                rootVolumeSizeGb: 30,
                detailedMonitoring: false,
                useSignals: true,
                signalsTimeoutMinutes: 40,
            },
            monitoring: {
                instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
                minCapacity: 1,
                maxCapacity: 2,
                useSpotInstances: true,
                rootVolumeSizeGb: 30,
                detailedMonitoring: false,
                useSignals: true,
                signalsTimeoutMinutes: 40,
            },
        },
        logRetention: logs.RetentionDays.ONE_WEEK,
        isProduction: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        createKmsKeys: false,
    },

    [Environment.STAGING]: {
        cluster: {
            kubernetesVersion: KUBERNETES_VERSION,
            podNetworkCidr: '192.168.0.0/16',
            serviceSubnet: '10.96.0.0/12',
            dataDir: '/data/kubernetes',
            workerCount: 2,
        },
        compute: {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
            rootVolumeSizeGb: 30,
            detailedMonitoring: true,
            useSignals: true,
            signalsTimeoutMinutes: 40,
        },
        storage: {
            volumeSizeGb: 40,
            mountPoint: '/data',
        },
        networking: {
            useElasticIp: true,
            ssmOnlyAccess: true,
        },
        securityGroups: DEFAULT_K8S_SECURITY_GROUPS,
        image: {
            amiSsmPath: '/k8s/staging/golden-ami/latest',
            enableImageBuilder: true,
            parentImageSsmPath: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64',
            bakedVersions: {
                dockerCompose: 'v2.24.0',
                awsCli: '2.x',
                kubeadm: KUBERNETES_VERSION,
                containerd: '1.7.24',
                runc: '1.2.4',
                cniPlugins: '1.6.1',
                crictl: '1.32.0',
                calico: 'v3.29.3',
                ecrCredentialProvider: 'v1.31.0',
                k8sgpt: '0.4.31',
                argoCdCli: 'v2.14.11',
                kubectlArgoRollouts: 'v1.8.3',
            },
        },
        ssm: {
            enableStateManager: true,
            associationSchedule: 'rate(30 minutes)',
            maxConcurrency: '1',
            maxErrors: '0',
        },
        edge: {
            domainName: fromEnv('MONITOR_DOMAIN_NAME') ?? 'monitoring.staging.nelsonlamounier.com',
            hostedZoneId: fromEnv('HOSTED_ZONE_ID'),
            crossAccountRoleArn: fromEnv('CROSS_ACCOUNT_ROLE_ARN'),
            rateLimitPerIp: 2000,
            enableRateLimiting: true,
            enableIpReputationList: true,
            opsSubdomain: 'ops',
            baseDomain: 'nelsonlamounier.com',
            runnersSubdomain: 'runners',
        },
        monitoringWorker: {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
            nodeLabel: 'workload=monitoring,environment=staging',
            detailedMonitoring: true,
            useSignals: true,
            signalsTimeoutMinutes: 40,
            rootVolumeSizeGb: 30,
            useSpotInstances: true,
        },
        argocdWorker: {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
            nodeLabel: 'workload=argocd,environment=staging',
            useSpotInstances: true,
            detailedMonitoring: true,
            useSignals: true,
            signalsTimeoutMinutes: 40,
            rootVolumeSizeGb: 30,
        },
        workerPools: {
            general: {
                instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
                minCapacity: 1,
                maxCapacity: 4,
                useSpotInstances: true,
                rootVolumeSizeGb: 30,
                detailedMonitoring: true,
                useSignals: true,
                signalsTimeoutMinutes: 40,
            },
            monitoring: {
                instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
                minCapacity: 1,
                maxCapacity: 2,
                useSpotInstances: true,
                rootVolumeSizeGb: 30,
                detailedMonitoring: true,
                useSignals: true,
                signalsTimeoutMinutes: 40,
            },
        },
        logRetention: logs.RetentionDays.ONE_MONTH,
        isProduction: false,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        createKmsKeys: false,
    },

    [Environment.PRODUCTION]: {
        cluster: {
            kubernetesVersion: KUBERNETES_VERSION,
            podNetworkCidr: '192.168.0.0/16',
            serviceSubnet: '10.96.0.0/12',
            dataDir: '/data/kubernetes',
            workerCount: 2,
        },
        compute: {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
            rootVolumeSizeGb: 30,
            detailedMonitoring: true,
            useSignals: true,
            signalsTimeoutMinutes: 40,
        },
        storage: {
            volumeSizeGb: 50,
            mountPoint: '/data',
        },
        networking: {
            useElasticIp: true,
            ssmOnlyAccess: true,
        },
        securityGroups: DEFAULT_K8S_SECURITY_GROUPS,
        image: {
            amiSsmPath: '/k8s/production/golden-ami/latest',
            enableImageBuilder: true,
            parentImageSsmPath: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64',
            bakedVersions: {
                dockerCompose: 'v2.24.0',
                awsCli: '2.x',
                kubeadm: KUBERNETES_VERSION,
                containerd: '1.7.24',
                runc: '1.2.4',
                cniPlugins: '1.6.1',
                crictl: '1.32.0',
                calico: 'v3.29.3',
                ecrCredentialProvider: 'v1.31.0',
                k8sgpt: '0.4.31',
                argoCdCli: 'v2.14.11',
                kubectlArgoRollouts: 'v1.8.3',
            },
        },
        ssm: {
            enableStateManager: true,
            associationSchedule: 'rate(30 minutes)',
            maxConcurrency: '1',
            maxErrors: '0',
        },
        edge: {
            domainName: fromEnv('MONITOR_DOMAIN_NAME') ?? 'monitoring.nelsonlamounier.com',
            hostedZoneId: fromEnv('HOSTED_ZONE_ID'),
            crossAccountRoleArn: fromEnv('CROSS_ACCOUNT_ROLE_ARN'),
            rateLimitPerIp: 2000,
            enableRateLimiting: true,
            enableIpReputationList: true,
            opsSubdomain: 'ops',
            baseDomain: 'nelsonlamounier.com',
            runnersSubdomain: 'runners',
        },
        monitoringWorker: {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
            nodeLabel: 'workload=monitoring,environment=production',
            detailedMonitoring: true,
            useSignals: true,
            signalsTimeoutMinutes: 40,
            rootVolumeSizeGb: 30,
            useSpotInstances: true,
        },
        argocdWorker: {
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
            nodeLabel: 'workload=argocd,environment=production',
            useSpotInstances: true,
            detailedMonitoring: true,
            useSignals: true,
            signalsTimeoutMinutes: 40,
            rootVolumeSizeGb: 30,
        },
        workerPools: {
            general: {
                instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
                minCapacity: 1,
                maxCapacity: 4,
                useSpotInstances: true,
                rootVolumeSizeGb: 30,
                detailedMonitoring: true,
                useSignals: true,
                signalsTimeoutMinutes: 40,
            },
            monitoring: {
                instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
                minCapacity: 1,
                maxCapacity: 2,
                useSpotInstances: true,
                rootVolumeSizeGb: 30,
                detailedMonitoring: true,
                useSignals: true,
                signalsTimeoutMinutes: 40,
            },
        },
        logRetention: logs.RetentionDays.THREE_MONTHS,
        isProduction: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        createKmsKeys: true,
    },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

export function getK8sConfigs(env: Environment): K8sConfigs {
    return K8S_CONFIGS[env as DeployableEnvironment];
}
