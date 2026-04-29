---
title: Golden AMI Pipeline
type: project
tags: [aws-ec2-image-builder, aws-cdk, aws-ssm, kubernetes, golden-ami, content-hash, typescript]
sources:
  - infra/lib/stacks/golden-ami-stack.ts
  - infra/lib/constructs/compute/golden-ami-image.ts
  - infra/lib/constructs/compute/build-golden-ami-component.ts
  - infra/lib/config/kubernetes/configurations.ts
created: 2026-04-28
updated: 2026-04-28
---

# Golden AMI Pipeline

A CDK-managed EC2 Image Builder pipeline that bakes the full Kubernetes 1.35.1 toolchain into a versioned AMI — with a content-hash mechanism that automatically triggers a new build whenever any bootstrap source file changes.

## Architecture

```mermaid
flowchart TD
    SRC["sm-a/ source tree\n.ts .yaml .yml .sh .json"] -->|SHA-256 of all files| HASH[stepsHash\n12-char hex]
    HASH --> COMP_YAML["buildGoldenAmiComponent()\nK8s install steps YAML\n+ extraHash embedded"]
    COMP_YAML -->|SHA-256 of YAML| VER["componentVersion\nbytes[0].bytes[1].bytes[2]"]
    VER --> COMP[CfnComponent\nimmutable, auto-versioned]
    COMP --> RECIPE[CfnImageRecipe]
    INFRA[InfraConfig\nt3.medium, VPC, SG] --> IMAGE
    RECIPE --> IMAGE[CfnImage\nCFN-managed AMI build\n15-25 min]
    IMAGE -->|attrImageId| SSM_AMI[SSM\n/k8s/{env}/golden-ami/latest]
    IMAGE -->|FAILED/CANCELLED| SNS[SNS Alert\nGoldenAmiAlertConstruct]
    SSM_AMI --> LT[Launch Template\nec2.MachineImage.fromSsmParameter]
```

## L3 construct vs domain stack — the separation

The pipeline is split across two layers deliberately:

**`GoldenAmiImageConstruct`** ([`infra/lib/constructs/compute/golden-ami-image.ts`](../../infra/lib/constructs/compute/golden-ami-image.ts)) — a domain-agnostic L3 blueprint. It wires the six Image Builder resources (Component, Recipe, InfraConfig, DistributionConfig, CfnImage, SSM parameter) and knows nothing about Kubernetes, Docker, or any specific software. Any project can reuse it by injecting a pre-built component YAML document.

**`GoldenAmiStack`** ([`infra/lib/stacks/golden-ami-stack.ts`](../../infra/lib/stacks/golden-ami-stack.ts)) — the K8s-specific domain stack. It generates the component YAML via `buildGoldenAmiComponent()`, computes the source hash, provides K8s-specific AMI tags, and instantiates the construct.

**`buildGoldenAmiComponent()`** ([`infra/lib/constructs/compute/build-golden-ami-component.ts`](../../infra/lib/constructs/compute/build-golden-ami-component.ts)) — a pure utility function that generates the Image Builder component YAML. Software installed at bake time:

| Component | Version | Notes |
|-----------|---------|-------|
| Kubernetes (kubeadm, kubelet, kubectl) | 1.35.1 | From configs.cluster.kubernetesVersion |
| containerd | 1.7.24 | CRI for Kubernetes |
| Calico manifests | v3.29.3 | Pre-downloaded to `/opt/calico` |
| ECR credential provider | v1.31.0 | Kubelet ECR auth |
| k8sgpt | v0.4.31 | AI-assisted cluster diagnostics |
| Node.js 22 LTS | — | Runtime for tsx bootstrap scripts |
| Helm | — | Package manager |
| ArgoCD CLI | — | Pre-baked; bootstrap skips runtime download |
| kubectl-argo-rollouts plugin | — | Pre-baked |
| Python 3.11 venv | — | boto3 + pyyaml + kubernetes |

Comments are stripped from the generated YAML to stay under the EC2 Image Builder 16,000-character component limit; explanations live in the TypeScript source.

## Content-hash driven AMI invalidation

### How it works

`GoldenAmiStack` computes a SHA-256 hash of the entire `sm-a/` source tree (lines ~149–187 of `golden-ami-stack.ts`):

```typescript
const smaRoot = path.resolve(__dirname, '../../../sm-a');
const stepsHash = fs.existsSync(smaRoot)
  ? (() => {
      const h = crypto.createHash('sha256');
      const exts = new Set(['.ts', '.yaml', '.yml', '.sh', '.json']);
      const skip = new Set(['node_modules', 'dist', '.yarn']);
      const walk = (dir: string): string[] => { ... };
      walk(smaRoot)
        .sort()                    // deterministic order
        .forEach(f => h.update(fs.readFileSync(f)));
      return h.digest('hex').slice(0, 12);
    })()
  : undefined;
```

The 12-character hash (`stepsHash`) is passed to `buildGoldenAmiComponent()` as `extraHash` and embedded in the component YAML document. When the YAML content changes, `GoldenAmiImageConstruct` derives a new `componentVersion` from SHA-256 bytes of the YAML:

```typescript
// golden-ami-image.ts
const contentHash = crypto.createHash('sha256').update(componentDocument).digest();
const componentVersion = `${contentHash[0]}.${contentHash[1]}.${contentHash[2]}`;
// e.g. "83.14.201"
```

Because Image Builder components are **immutable** (same name + version cannot be updated), a new version means CDK must create a new `CfnComponent`. A new component changes the `CfnImageRecipe`, which triggers CloudFormation to replace the `CfnImage` — kicking off a new 15–25 minute AMI bake automatically.

The chain: _source change → hash change → YAML change → component version change → new CfnImage → new AMI ID → SSM parameter updated → Launch Template resolves new AMI_.

### The __dirname bug (fixed)

Prior to the fix, the path was `path.resolve(__dirname, '../../../../sm-a')`. With `__dirname = infra/lib/stacks/`, four `../` levels resolves to _one level above the repo root_. `fs.existsSync` returned false silently, `stepsHash` was always `undefined`, the YAML never carried the source hash, and the component version never changed from source edits.

**Result:** every `cdk deploy` since this hash mechanism was added was a no-op for source changes. The AMI never re-baked from TypeScript or script edits alone — only from version bumps in `configurations.ts` (which changed the YAML directly).

The fix at line 166 of `golden-ami-stack.ts`:
```typescript
// Before (broken — resolves above repo root):
const smaRoot = path.resolve(__dirname, '../../../../sm-a');

// After (correct — three levels up from infra/lib/stacks/ = repo root):
const smaRoot = path.resolve(__dirname, '../../../sm-a');
```

The comment block at lines 151–165 preserves the full diagnosis in the source to prevent re-introducing the bug.

### What triggers a bake

| Change type | Bake triggered? |
|-------------|----------------|
| Any `.ts`, `.yaml`, `.yml`, `.sh`, `.json` in `sm-a/` | Yes — stepsHash changes |
| Version bump in `configurations.ts` (kubeadm, containerd, calico) | Yes — YAML changes directly |
| Changes to `infra/lib/` CDK code only | No — unless `buildGoldenAmiComponent` output changes |
| Changes outside `sm-a/` in the repo | No |

## CfnImage — CloudFormation-managed build

`GoldenAmiImageConstruct` uses `CfnImage` (the L1 CloudFormation construct) rather than `ImageBuilderPipeline`. The difference:

- `CfnImage` builds the AMI **inline during `cdk deploy`** — CloudFormation waits for the build to complete (15–25 min). When the stack deploys, the AMI is guaranteed to exist.
- `CfnImagePipeline` schedules builds separately; the AMI may not exist immediately after deploy.

When the stack is deleted, CloudFormation deregisters the AMI and deletes the SSM parameter — no orphaned images, no stale SSM references pointing at deregistered AMIs. This lifecycle management is the primary reason for choosing `CfnImage` over a pipeline-based approach.

## Build-failure alert

`GoldenAmiAlertConstruct` ([`infra/lib/constructs/compute/golden-ami-alert.ts`](../../infra/lib/constructs/compute/golden-ami-alert.ts)) wires an EventBridge rule on Image Builder state changes (`FAILED`, `CANCELLED`, `TIMED_OUT`) for the recipe named `${namePrefix}-golden-ami-recipe` to an SNS topic. Without this, a failed bake leaves the SSM AMI parameter pointing at the previous build — downstream `cdk-monitoring` Launch Templates silently use the stale AMI.

## VPC resolution — CDK context variable

`GoldenAmiStack` avoids `ec2.Vpc.fromLookup()` (which requires a synth-time AWS credential step). Instead, the VPC ID is injected as a CDK context variable:

```bash
# CI pipeline: reads VPC ID from SSM, passes as context
VPC_ID=$(aws ssm get-parameter --name "/k8s/development/vpc-id" --query Parameter.Value --output text)
cdk deploy --context vpcId=${VPC_ID}
```

The stack reads it via `this.node.tryGetContext('vpcId')` (via `GoldenAmiStackProps.vpcId`). This keeps the `cdk synth` step credential-free and is why the `deploy-golden-ami.yml` workflow reads SSM before calling `cdk deploy`.

## Infrastructure configuration

`GoldenAmiImageConstruct` provisions the Image Builder instance with:

- **Instance type:** `t3.medium` (default; overridable via `instanceTypes` prop)
- **Root EBS:** 30 GB gp3, encrypted (KMS default key)
- **Subnet:** first public subnet of the VPC
- **Termination on failure:** `terminateInstanceOnFailure: true` — no zombie build instances
- **Build logs:** CloudWatch log group `/aws/imagebuilder/{namePrefix}-golden-ami` (3-day retention)
- **IAM:** all least-privilege inline policies (no AWS managed policies); cdk-nag `AwsSolutions-IAM5` suppressions documented inline for hard AWS service constraints (SSM agent, imagebuilder agent, ec2imagebuilder-* S3 buckets)

## Deployment order

```
1. deploy-base [cdk-monitoring]     — VPC, SG, scripts bucket
2. deploy-goldenami [this stack]    — Image Builder pipeline → bake → SSM AMI ID
3. deploy-compute [cdk-monitoring]  — ASG Launch Template resolves new AMI from SSM
```

The `deploy-golden-ami.yml` GitHub Actions workflow handles steps 2 and 3 in sequence on `workflow_dispatch`. `deploy-ssm-automation.yml` deploys the Step Functions state machine separately without triggering an AMI re-bake.

## Related

- [SSM Automation bootstrap integration](../concepts/ssm-automation-bootstrap.md) — how the AMI ID flows from SSM to the Launch Template
- [kubeadm init OS-level flow](../concepts/kubeadm-init-flow.md) — what the baked toolchain enables at runtime

<!--
Evidence trail (auto-generated):
- Source: infra/lib/stacks/golden-ami-stack.ts (read 2026-04-28, 266 lines — stepsHash walk lines 149-187, __dirname bug comment lines 151-165, correct path line 166, VpcFromLookup, buildGoldenAmiComponent call, GoldenAmiAlertConstruct wiring)
- Source: infra/lib/constructs/compute/golden-ami-image.ts (read 2026-04-28, 474 lines — componentVersion SHA-256 bytes 0/1/2 at line ~333, CfnImage vs pipeline design, SSM parameter lifecycle management, IAM inline policies)
- Source: infra/lib/constructs/compute/build-golden-ami-component.ts (read 2026-04-28, first 80 lines — software list, 16k-char limit note)
- Source: infra/lib/config/kubernetes/configurations.ts (read in prior session — KUBERNETES_VERSION=1.35.1, containerd=1.7.24, calico=v3.29.3, k8sgpt=0.4.31)
- Generated: 2026-04-28
-->
