/**
 * @format
 * K8s SSM Parameter Path Patterns
 *
 * Single source of truth for all SSM parameter paths used by the
 * kubernetes-bootstrap SSM Automation stack.
 */

import { Environment, shortEnv } from './environments.js';

// =============================================================================
// K8S (kubeadm) SSM PATHS
// =============================================================================

/** k8s SSM prefix: /k8s/{environment} */
export function k8sSsmPrefix(environment: Environment): string {
    return `/k8s/${environment}`;
}

/**
 * Complete set of paths published by KubernetesBaseStack.
 * Consumer stacks use these for cross-stack discovery without
 * CloudFormation exports.
 */
export interface K8sSsmPaths {
    /** The prefix itself: /k8s/{environment} */
    readonly prefix: string;

    // --- Networking ---
    /** Shared VPC ID */
    readonly vpcId: string;
    /** Elastic IP address (CloudFront origin) */
    readonly elasticIp: string;
    /** EIP allocation ID (for automatic association during bootstrap) */
    readonly elasticIpAllocationId: string;

    // --- Security Groups ---
    /** Cluster base security group ID (intra-cluster communication) */
    readonly securityGroupId: string;
    /** Control plane security group ID (API server access) */
    readonly controlPlaneSgId: string;
    /** Ingress security group ID (Traefik HTTP/HTTPS) */
    readonly ingressSgId: string;
    /** Monitoring security group ID (Prometheus/Loki/Tempo) */
    readonly monitoringSgId: string;

    // --- Storage ---
    /** S3 bucket name for k8s scripts and manifests */
    readonly scriptsBucket: string;

    // --- DNS ---
    /** Route 53 private hosted zone ID */
    readonly hostedZoneId: string;
    /** Stable DNS name for the K8s API server */
    readonly apiDnsName: string;

    // --- Encryption ---
    /** KMS key ARN for CloudWatch log group encryption */
    readonly kmsKeyArn: string;

    // --- NLB (Network Load Balancer) ---
    /** NLB full name (for CloudWatch metrics) */
    readonly nlbFullName: string;
    /** NLB HTTP (port 80) target group ARN */
    readonly nlbHttpTargetGroupArn: string;
    /** NLB HTTPS (port 443) target group ARN */
    readonly nlbHttpsTargetGroupArn: string;

    // --- Golden AMI ---
    /**
     * AMI ID produced by the EC2 Image Builder pipeline (GoldenAmiStack).
     * Written by CloudFormation at deploy time — read by Compute Launch Templates
     * via `ec2.MachineImage.fromSsmParameter()`.
     * Path: /k8s/{env}/golden-ami/latest
     */
    readonly goldenAmiId: string;

    // --- Compute (published by ControlPlane stack at runtime) ---
    /** Kubernetes node EC2 instance ID */
    readonly instanceId: string;

    // --- Security / Edge Validation ---
    /** CloudFront Origin Secret (for authenticating edge traffic) */
    readonly cloudfrontOriginSecret: string;
    /** Prometheus basic auth secret (htpasswd hash) */
    readonly prometheusBasicAuth: string;

    /** Wildcard path for IAM: /k8s/{environment}/* */
    readonly wildcard: string;
}

/**
 * Get k8s SSM parameter paths for a given environment.
 */
export function k8sSsmPaths(environment: Environment): K8sSsmPaths {
    const prefix = k8sSsmPrefix(environment);

    return {
        prefix,

        // Networking
        vpcId: `${prefix}/vpc-id`,
        elasticIp: `${prefix}/elastic-ip`,
        elasticIpAllocationId: `${prefix}/elastic-ip-allocation-id`,

        // Security Groups
        securityGroupId: `${prefix}/security-group-id`,
        controlPlaneSgId: `${prefix}/control-plane-sg-id`,
        ingressSgId: `${prefix}/ingress-sg-id`,
        monitoringSgId: `${prefix}/monitoring-sg-id`,

        // Storage
        scriptsBucket: `${prefix}/scripts-bucket`,

        // DNS
        hostedZoneId: `${prefix}/hosted-zone-id`,
        apiDnsName: `${prefix}/api-dns-name`,

        // Encryption
        kmsKeyArn: `${prefix}/kms-key-arn`,

        // NLB
        nlbFullName: `${prefix}/nlb-full-name`,
        nlbHttpTargetGroupArn: `${prefix}/nlb-http-target-group-arn`,
        nlbHttpsTargetGroupArn: `${prefix}/nlb-https-target-group-arn`,

        // Golden AMI (written by GoldenAmiStack, read by Compute Launch Templates)
        goldenAmiId: `${prefix}/golden-ami/latest`,

        // Compute (published by ControlPlane stack)
        instanceId: `${prefix}/instance-id`,

        // Security / Edge Validation
        cloudfrontOriginSecret: `${prefix}/cloudfront-origin-secret`,
        prometheusBasicAuth: `${prefix}/prometheus-basic-auth`,

        // IAM
        wildcard: `${prefix}/*`,
    };
}

// Re-export shortEnv so callers can use it without a separate import
export { shortEnv };
