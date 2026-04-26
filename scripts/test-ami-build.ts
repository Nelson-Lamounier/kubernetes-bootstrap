#!/usr/bin/env tsx
/**
 * Static analysis of the generated EC2 Image Builder component YAML.
 * Catches anti-patterns and missing checks before triggering a pipeline bake.
 * No AWS calls — runs entirely offline.
 *
 * Usage:
 *   npx tsx scripts/test-ami-build.ts
 *   just test-ami-build
 */

import * as jsYaml from 'js-yaml';

import { buildGoldenAmiComponent } from '../infra/lib/constructs/compute/build-golden-ami-component.js';
import { getK8sConfigs } from '../infra/lib/config/kubernetes/index.js';
import { Environment } from '../infra/lib/config/environments.js';

// ---------------------------------------------------------------------------
// Render YAML using development config (representative of all envs)
// ---------------------------------------------------------------------------
const configs = getK8sConfigs(Environment.DEVELOPMENT);
const yaml = buildGoldenAmiComponent({
    imageConfig: configs.image,
    clusterConfig: configs.cluster,
    scriptsBucketSsmPath: '/k8s/development/scripts-bucket',
});

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
type Result = { name: string; pass: boolean; reason?: string };
const results: Result[] = [];

function test(name: string, fn: () => boolean | string): void {
    try {
        const result = fn();
        if (result === true || result === '') {
            results.push({ name, pass: true });
        } else {
            results.push({ name, pass: false, reason: typeof result === 'string' ? result : undefined });
        }
    } catch (e) {
        results.push({ name, pass: false, reason: String(e) });
    }
}

function contains(pattern: string | RegExp): boolean {
    return typeof pattern === 'string' ? yaml.includes(pattern) : pattern.test(yaml);
}

function absent(pattern: string | RegExp): boolean {
    return !contains(pattern);
}

// ---------------------------------------------------------------------------
// Anti-pattern checks (must NOT appear)
// ---------------------------------------------------------------------------
test('no alternatives --set python3 as command (breaks cloud-init)', () =>
    // Allow in comments (# ... alternatives) but not as an executable command
    absent(/^\s+alternatives --set python3/m));

test('no pip install without venv (pollutes system python)', () =>
    absent(/^pip install/m));

test('no curl | bash without version pin (except helm installer and nodesource setup)', () => {
    const matches = yaml.match(/curl[^|]+\| *bash/g) ?? [];
    const violations = matches.filter(m =>
        !m.includes('get-helm-3') &&
        !m.includes('nodesource.com/setup_'),
    );
    return violations.length === 0 || `Found: ${violations.join(', ')}`;
});

test('no yum command (AL2023 uses dnf; /etc/yum.repos.d paths are fine)', () =>
    // Exclude file paths (/etc/yum.repos.d) and repo format references (yum.repos)
    absent(/(?<![/\w.])yum\b/m));

// ---------------------------------------------------------------------------
// Required software checks
// ---------------------------------------------------------------------------
test('docker installed', () =>
    contains('dnf install -y docker'));

test('containerd installed', () =>
    contains('containerd/releases/download'));

test('runc installed', () =>
    contains('opencontainers/runc/releases/download'));

test('CNI plugins installed', () =>
    contains('containernetworking/plugins/releases/download'));

test('crictl installed', () =>
    contains('cri-tools/releases/download'));

test('kubeadm/kubelet/kubectl installed via dnf', () =>
    contains('dnf install -y kubelet') && contains('kubeadm') && contains('kubectl'));

test('ecr-credential-provider installed', () =>
    contains('ecr-credential-provider'));

test('ecr credential provider config written', () =>
    contains('image-credential-provider-config.yaml'));

test('Calico manifests pre-cached to /opt/calico', () =>
    contains('/opt/calico/tigera-operator.yaml') && contains('/opt/calico/calico.yaml'));

test('cfn-signal installed', () =>
    contains('aws-cfn-bootstrap'));

test('helm installed', () =>
    contains('get-helm-3'));

test('k8sgpt installed', () =>
    contains('k8sgpt'));

test('CloudWatch Agent installed', () =>
    contains('amazon-cloudwatch-agent'));

// ---------------------------------------------------------------------------
// Python isolation checks
// ---------------------------------------------------------------------------
test('python3.11 venv at /opt/k8s-venv (not system)', () =>
    contains('/opt/k8s-venv'));

test('system python3 preservation assertion in validate phase', () =>
    contains("System python3 must remain 3.9") || contains("system python3 is $SYS_PY_VERSION"));

// ---------------------------------------------------------------------------
// Kernel / sysctl / containerd config
// ---------------------------------------------------------------------------
test('overlay + br_netfilter kernel modules loaded', () =>
    contains('overlay') && contains('br_netfilter'));

test('sysctl ip_forward enabled', () =>
    contains('net.ipv4.ip_forward'));

test('containerd SystemdCgroup = true', () =>
    contains("SystemdCgroup = false/SystemdCgroup = true") ||
    contains("s/SystemdCgroup = false/SystemdCgroup = true/"));

// ---------------------------------------------------------------------------
// Build structure checks
// ---------------------------------------------------------------------------
test('AWSTOE schemaVersion 1.0', () =>
    contains('schemaVersion: 1.0'));

test('validate phase present', () =>
    contains('- name: validate'));

test('bootstrap scripts baked from S3', () =>
    contains('/opt/k8s-bootstrap') && contains('aws s3 sync'));

test('validate phase checks sm-a/boot/ layout (fails if S3 not synced via sync-s3)', () =>
    contains('/opt/k8s-bootstrap/sm-a/boot'));

test('validate phase checks gitops/ layout (fails if S3 not synced via sync-s3)', () =>
    contains('/opt/k8s-bootstrap/gitops'));

test('orchestrator.ts presence validated', () =>
    contains('orchestrator.ts'));

test('/data directories created', () =>
    contains('/data/kubernetes'));

// ---------------------------------------------------------------------------
// Node.js / tsx checks
// ---------------------------------------------------------------------------
test('Node.js 22 LTS installed via NodeSource (required for tsx bootstrap runner)', () =>
    contains('nodesource.com/setup_22.x') && contains('dnf install -y nodejs'));

test('tsx installed globally via npm install -g during Node.js setup', () =>
    contains('npm install -g tsx'));

// ---------------------------------------------------------------------------
// ArgoCD / Argo Rollouts CLI checks (baked to avoid GitHub downloads at boot)
// ---------------------------------------------------------------------------
test('ArgoCD CLI baked from argoproj/argo-cd releases (auth.py skips download when present)', () =>
    contains('argoproj/argo-cd/releases/download') && contains('/usr/local/bin/argocd'));

test('kubectl-argo-rollouts baked from argoproj/argo-rollouts releases (control_plane.ts skips download when present)', () =>
    contains('argoproj/argo-rollouts/releases/download') && contains('/usr/local/bin/kubectl-argo-rollouts'));

// ---------------------------------------------------------------------------
// YAML parse + Image Builder structural checks
// Catches "cannot unmarshal map into string" before CDK deploy.
// ---------------------------------------------------------------------------
test('component YAML parses without errors', () => {
    jsYaml.load(yaml);
    return true;
});

test('all commands in every phase are strings, not maps', () => {
    const doc = jsYaml.load(yaml) as {
        phases?: Array<{
            name: string;
            steps?: Array<{
                name: string;
                inputs?: { commands?: unknown[] };
            }>;
        }>;
    };
    const violations: string[] = [];
    for (const phase of doc.phases ?? []) {
        for (const step of phase.steps ?? []) {
            for (const [i, cmd] of (step.inputs?.commands ?? []).entries()) {
                if (typeof cmd !== 'string') {
                    violations.push(
                        `phase=${phase.name} step=${step.name} commands[${i}] is ${typeof cmd}: ${JSON.stringify(cmd)}`,
                    );
                }
            }
        }
    }
    return violations.length === 0 || violations.join('\n');
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass);

console.log('\nAMI Component YAML — Static Analysis\n');
for (const r of results) {
    const icon = r.pass ? '✅' : '❌';
    const detail = r.reason ? `  → ${r.reason}` : '';
    console.log(`  ${icon}  ${r.name}${detail}`);
}

console.log(`\n${passed}/${results.length} checks passed`);

if (failed.length > 0) {
    console.log('\nFailed:');
    for (const r of failed) {
        console.log(`  • ${r.name}${r.reason ? `: ${r.reason}` : ''}`);
    }
    process.exit(1);
}

console.log('\nAll checks passed — safe to trigger AMI pipeline.\n');
