/**
 * @format
 * Node Drift Enforcement — SSM State Manager Association
 *
 * Continuously enforces critical OS-level Kubernetes prerequisites
 * across all K8s compute nodes. Runs every 30 minutes via State Manager,
 * providing automatic drift remediation for settings that the Golden AMI
 * bakes in but that can be lost after kernel upgrades, reboots, or
 * accidental configuration changes.
 *
 * Enforced settings:
 *   - Kernel modules: overlay, br_netfilter
 *   - Sysctl: net.bridge.bridge-nf-call-iptables, ip6tables, ip_forward
 *   - Services: containerd, kubelet
 *
 * Architecture (Layer 3b of hybrid bootstrap):
 *   - Layer 1: Golden AMI (pre-baked software)
 *   - Layer 2: User Data (EBS attach, cfn-signal — slim trigger)
 *   - Layer 3: SSM Automation (kubeadm bootstrap — one-shot)
 *   - Layer 3b: SSM Association (THIS) — continuous drift enforcement
 *   - Layer 4: Self-Healing Agent (application-level remediation)
 *
 * Design Decision: Targets all K8s nodes by the `project` tag applied
 * by the TaggingAspect (value: 'k8s-platform'). This captures control
 * plane + all worker roles without maintaining a per-stack tag list.
 *
 * Cost: SSM State Manager Associations and Run Command are free-tier.
 */

import * as ssm from 'aws-cdk-lib/aws-ssm';

import { Construct } from 'constructs';

import type { Environment } from '../../config/environments.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const REQUIRED_KERNEL_MODULES = ['overlay', 'br_netfilter'] as const;

const REQUIRED_SYSCTL: Record<string, string> = {
    'net.bridge.bridge-nf-call-iptables': '1',
    'net.bridge.bridge-nf-call-ip6tables': '1',
    'net.ipv4.ip_forward': '1',
};

const REQUIRED_SERVICES = ['containerd', 'kubelet'] as const;

const DRIFT_CHECK_SCHEDULE = 'rate(30 minutes)';

const K8S_PROJECT_TAG_KEY = 'project';

const K8S_PROJECT_TAG_VALUE = 'k8s-platform';

// =============================================================================
// PROPS
// =============================================================================

export interface NodeDriftEnforcementProps {
    readonly prefix: string;
    readonly targetEnvironment: Environment;
    readonly ssmPrefix: string;
    readonly schedule?: string;
}

// =============================================================================
// CONSTRUCT
// =============================================================================

export class NodeDriftEnforcementConstruct extends Construct {
    /** The SSM Command Document for drift enforcement */
    public readonly document: ssm.CfnDocument;

    /** The State Manager Association */
    public readonly association: ssm.CfnAssociation;

    constructor(scope: Construct, id: string, props: NodeDriftEnforcementProps) {
        super(scope, id);

        const { prefix, targetEnvironment, schedule } = props;

        this.document = new ssm.CfnDocument(this, 'EnforcementDoc', {
            documentType: 'Command',
            documentFormat: 'YAML',
            targetType: '/AWS::EC2::Instance',
            content: {
                schemaVersion: '2.2',
                description: `Node drift enforcement for ${prefix}-${targetEnvironment}. Validates and remediates kernel modules, sysctl parameters, and critical services (containerd, kubelet).`,
                mainSteps: [
                    {
                        action: 'aws:runShellScript',
                        name: 'EnforceNodeConfig',
                        precondition: {
                            StringEquals: ['platformType', 'Linux'],
                        },
                        inputs: {
                            runCommand: this.buildEnforcementScript(),
                            timeoutSeconds: '120',
                            cloudWatchOutputConfig: {
                                CloudWatchOutputEnabled: 'true',
                                CloudWatchLogGroupName: `/ssm${props.ssmPrefix}/drift`,
                            },
                        },
                    },
                ],
            },
            updateMethod: 'NewVersion',
        });

        this.association = new ssm.CfnAssociation(this, 'DriftAssoc', {
            name: this.document.ref,
            targets: [
                {
                    key: `tag:${K8S_PROJECT_TAG_KEY}`,
                    values: [K8S_PROJECT_TAG_VALUE],
                },
            ],
            scheduleExpression: schedule ?? DRIFT_CHECK_SCHEDULE,
            maxConcurrency: '4',
            maxErrors: '0',
            complianceSeverity: 'HIGH',
            applyOnlyAtCronInterval: false,
        });

        this.association.addDependency(this.document);
    }

    private buildEnforcementScript(): string[] {
        const sysctlEntries = Object.entries(REQUIRED_SYSCTL);

        return [
            '#!/bin/bash',
            'set -euo pipefail',
            '',
            'DRIFT_DETECTED=0',
            'REMEDIATION_FAILED=0',
            'echo "=== K8s Node Drift Enforcement — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="',
            '',
            '# -----------------------------------------------------------------',
            '# 1. Kernel Modules',
            '# -----------------------------------------------------------------',
            ...REQUIRED_KERNEL_MODULES.flatMap((mod) => [
                `if ! lsmod | grep -q "^${mod} "; then`,
                `  echo "DRIFT: kernel module '${mod}' not loaded — loading"`,
                `  modprobe ${mod}`,
                '  DRIFT_DETECTED=1',
                'else',
                `  echo "✓ kernel module: ${mod}"`,
                'fi',
                '',
            ]),
            '# -----------------------------------------------------------------',
            '# 2. Sysctl Parameters',
            '# -----------------------------------------------------------------',
            ...sysctlEntries.flatMap(([key, expected]) => {
                const procPath = `/proc/sys/${key.replace(/\./g, '/')}`;
                return [
                    `ACTUAL=$(cat ${procPath} 2>/dev/null || echo "MISSING")`,
                    `if [ "$ACTUAL" != "${expected}" ]; then`,
                    `  echo "DRIFT: ${key} = $ACTUAL (expected ${expected}) — enforcing"`,
                    `  sysctl -w ${key}=${expected} > /dev/null`,
                    '  DRIFT_DETECTED=1',
                    'else',
                    `  echo "✓ sysctl: ${key} = ${expected}"`,
                    'fi',
                    '',
                ];
            }),
            '# -----------------------------------------------------------------',
            '# 3. Critical Services',
            '# -----------------------------------------------------------------',
            ...REQUIRED_SERVICES.flatMap((svc) => [
                `if ! systemctl is-active --quiet ${svc}; then`,
                `  echo "DRIFT: ${svc} is not running — restarting"`,
                `  if systemctl restart ${svc}; then`,
                `    echo "  ✓ ${svc} restarted successfully"`,
                '  else',
                `    echo "  ✗ FAILED to restart ${svc}"`,
                '    REMEDIATION_FAILED=1',
                '  fi',
                '  DRIFT_DETECTED=1',
                'else',
                `  echo "✓ service: ${svc} (active)"`,
                'fi',
                '',
            ]),
            '# -----------------------------------------------------------------',
            '# 4. Summary',
            '# -----------------------------------------------------------------',
            'if [ "$REMEDIATION_FAILED" -eq 1 ]; then',
            '  echo "=== RESULT: NON-COMPLIANT — remediation failed ==="',
            '  exit 1',
            'elif [ "$DRIFT_DETECTED" -eq 1 ]; then',
            '  echo "=== RESULT: COMPLIANT — drift detected and remediated ==="',
            '  exit 0',
            'else',
            '  echo "=== RESULT: COMPLIANT — no drift detected ==="',
            '  exit 0',
            'fi',
        ];
    }
}
