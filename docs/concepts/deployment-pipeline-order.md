---
title: Deployment Pipeline Order
type: concept
tags: [deployment, cdk, kubernetes, bootstrap, argocd, github-actions]
sources:
  - .github/workflows/_deploy-kubernetes.yml
  - .github/workflows/_sync-k8s-content.yml
  - .github/workflows/day-1-orchestration.yml
  - infra/scripts/deployment/stacks.ts
  - infra/lib/projects/kubernetes/factory.ts
created: 2026-04-28
updated: 2026-04-28
---

# Deployment Pipeline Order

Reference guide for the kubeadm Kubernetes platform deployment order, covering infrastructure provisioning, cluster bootstrapping, and application delivery.

## Architecture Overview

The Kubernetes deployment follows a **three-layer decoupled architecture**:

| Layer | Responsibility | Pipeline | Trigger |
|-------|---------------|----------|---------|
| **Infrastructure** | AWS resources (EC2, VPC, S3, IAM, CloudFront) | `_deploy-kubernetes.yml` | Push to `main`/`develop` |
| **Bootstrap** | k3s, Traefik, ArgoCD, Helm charts | `sync-k8s-bootstrap-{env}.yml` | Push changes to `k8s-bootstrap/` |
| **Application** | Next.js pods, IngressRoutes, namespaces | `sync-k8s-app-deploy-{env}.yml` | Push changes to `app-deploy/` |

### Design Decision: Why Decouple?

```mermaid
graph TD
    subgraph "Old: Coupled"
        A1["CDK deploys infra"] --> B1["CDK deploys app"] --> C1["Everything or nothing"]
    end

    subgraph "New: Decoupled"
        A2["CDK deploys infra"] -.->|"independent"| B2["S3 sync → bootstrap"]
        A2 -.->|"independent"| C2["S3 sync → app manifests"]
    end

    style A1 fill:#f66,stroke:#333
    style C1 fill:#f66,stroke:#333
    style A2 fill:#6d6,stroke:#333
    style B2 fill:#69f,stroke:#333
    style C2 fill:#69f,stroke:#333
```

**Benefits:**
- **Blast radius** — Updating a Kubernetes manifest doesn't re-deploy EC2 instances
- **Independent velocity** — App changes deploy in ~60s (S3 sync), not ~15min (CDK)
- **Day-0 safety** — Infrastructure can deploy even when no application exists yet
- **GitOps ready** — ArgoCD watches Git for manifest changes, SSM enforces state via associations

---

## Full Deployment Order

### End-to-End Pipeline Flow

```mermaid
flowchart LR
    subgraph "Phase 1: Foundation"
        S["Shared VPC + ECR"]
    end

    subgraph "Phase 2: K8s Infra (CDK)"
        D["① Data"] --> BA["② Base"]
        D --> GA["Golden AMI (parallel)"]
        BA --> SB["②b Sync Bootstrap to S3"]
        SB --> CO["③ Compute"]
        CO --> AI["④ App IAM"]
        AI --> ED["⑤ Edge (us-east-1)"]
    end

    subgraph "Phase 3: Content Sync"
        BS["3a: Bootstrap Sync"]
        AP["3b: App Deploy Sync"]
    end

    S --> D
    ED --> BS
    ED --> AP

    style S fill:#f9f,stroke:#333
    style D fill:#6d6,stroke:#333
    style BA fill:#6d6,stroke:#333
    style CO fill:#6d6,stroke:#333
    style AI fill:#6d6,stroke:#333
    style ED fill:#6d6,stroke:#333
    style GA fill:#ff9,stroke:#333
    style SB fill:#ff9,stroke:#333
    style BS fill:#69f,stroke:#333
    style AP fill:#69f,stroke:#333
```

---

## Phase 1: Foundation — Shared VPC + ECR

| Detail | Value |
|--------|-------|
| **Workflow** | `_deploy-stack.yml` |
| **Stack** | `Shared-Infra-{env}` |
| **Purpose** | VPC with public subnets, ECR repository |
| **When** | Only on Day-0 or when networking changes |

The Shared stack provides the VPC that all Kubernetes stacks consume. It rarely changes after initial deployment.

---

## Phase 2: K8s Infrastructure (CDK)

**Workflow:** [`_deploy-kubernetes.yml`](.github/workflows/_deploy-kubernetes.yml)

This is the core infrastructure pipeline. It orchestrates 5 CDK stacks plus ancillary jobs (security scan, drift detection, template validation, verification).

### Internal Job Dependency Graph

```mermaid
flowchart TD
    SETUP["setup\n(Synth + Upload)"]

    SETUP --> SEC["security-scan\n(IaC scanning)"]
    SETUP --> DRIFT["drift-detection\n(CloudFormation drift)"]
    SETUP --> VAL["validate-templates\n(cfn-lint)"]

    SEC --> DATA["deploy-data\n① DynamoDB + S3 + SSM + Golden AMI Seed"]
    DRIFT --> DATA
    VAL --> DATA

    DATA --> BASE["deploy-base\n② VPC + SG + KMS + EBS + EIP + S3 Scripts"]
    DATA --> GOLDEN["build-golden-ami\n(parallel, optional Day-0)"]

    BASE --> SYNC_B["sync-bootstrap-content\n②b Seed boot scripts to S3"]
    SYNC_B --> COMPUTE["deploy-compute\n③ EC2 + ASG + SSM Docs"]
    COMPUTE --> APPIAM["deploy-appiam\n④ DynamoDB + S3 + Secrets grants"]
    APPIAM --> EDGE["deploy-edge\n⑤ CloudFront + ACM + WAF (us-east-1)"]
    DATA --> EDGE

    EDGE --> ASSETS["sync-static-assets\n(S3 + CloudFront invalidation)"]
    DATA --> ASSETS

    ASSETS --> VERIFY["verify-and-test\n(Smoke tests)"]
    COMPUTE --> VERIFY
    EDGE --> VERIFY

    style SETUP fill:#ddd,stroke:#333
    style SEC fill:#fdd,stroke:#333
    style DRIFT fill:#fdd,stroke:#333
    style VAL fill:#fdd,stroke:#333
    style DATA fill:#6d6,stroke:#333
    style BASE fill:#6d6,stroke:#333
    style COMPUTE fill:#6d6,stroke:#333
    style APPIAM fill:#6d6,stroke:#333
    style EDGE fill:#6d6,stroke:#333
    style GOLDEN fill:#ff9,stroke:#333
    style SYNC_B fill:#ff9,stroke:#333
    style ASSETS fill:#69f,stroke:#333
    style VERIFY fill:#69f,stroke:#333
```

### Stack Details

#### ① Data Stack — `Monitoring-K8s-Data-{env}`
| Resource | Purpose |
|----------|---------|
| DynamoDB Table | Personal portfolio data (articles, subscriptions) |
| S3 Assets Bucket | Static assets for Next.js |
| S3 Access Logs Bucket | Audit trail for assets bucket |
| SSM Parameters | Cross-stack discovery (table name, bucket, region) |
| **Golden AMI SSM Seed** | Seeds `/k8s/{env}/golden-ami/latest` with parent AL2023 AMI ID |

> [!IMPORTANT]
> The Golden AMI SSM parameter **must** be created in the Data stack (not Compute) to avoid Day-0 `ValidationError`. The Compute stack's LaunchTemplate uses `{{resolve:ssm:...}}` which CloudFormation resolves before any resources are created.

#### ② Base Stack — `Monitoring-K8s-Base-{env}`
| Resource | Purpose |
|----------|---------|
| VPC (imported) | Public subnets from Shared stack |
| Security Group | Ingress rules for k8s ports (6443, 80, 443, etc.) |
| KMS Key | Encryption for EBS volumes |
| EBS Volume | Persistent storage for Prometheus/Grafana data |
| Elastic IP | Static IP for the k8s node |
| S3 Scripts Bucket | Boot scripts and manifests storage (kubeadm init, Helm charts) |

#### ②b Sync Bootstrap Content
Runs `aws s3 sync` to seed boot scripts from `k8s-bootstrap/` into the S3 scripts bucket. This ensures `boot-k8s.sh` is available when the EC2 instance launches during the Compute stack deployment.

> [!NOTE]
> This is a Day-1 safety mechanism. Without it, the EC2 instance would launch but `boot-k8s.sh` wouldn't exist in S3, causing the bootstrap to silently fail.

#### ③ Compute Stack — `Monitoring-K8s-Compute-{env}`
| Resource | Purpose |
|----------|---------|
| Launch Template | AMI (from SSM), instance type, UserData |
| Auto Scaling Group | Single-instance ASG with cfn-signal |
| SSM Documents | `deploy-manifests`, `deploy-app-manifests` |
| State Manager Associations | Continuous config enforcement |
| Instance Role | EC2 instance IAM permissions |

#### ④ App IAM Stack — `Monitoring-K8s-AppIam-{env}`
| Resource | Purpose |
|----------|---------|
| IAM Policies | DynamoDB, S3, Secrets Manager, SSM access |
| Attached to | Compute stack's instance role |

> [!TIP]
> App IAM is separated from Compute so that adding a new DynamoDB table only redeploys the IAM policy — not the ASG or Launch Template. This prevents unnecessary instance replacements.

#### ⑤ Edge Stack — `Monitoring-K8s-Edge-{env}` (us-east-1)
| Resource | Purpose |
|----------|---------|
| ACM Certificate | TLS for `dev.nelsonlamounier.com` |
| WAF WebACL | Rate limiting, IP reputation |
| CloudFront Distribution | CDN routing to EIP origin |
| Route53 Records | DNS CNAME/Alias to CloudFront |

---

## Phase 3: Content Sync (Post-Infrastructure)

After CDK provisions the hardware, two independent pipelines deploy the software layer:

### 3a: Bootstrap Sync

**Workflow:** [`sync-k8s-bootstrap-{env}.yml`](.github/workflows/sync-k8s-bootstrap-dev.yml)
**Reusable:** [`_sync-k8s-content.yml`](.github/workflows/_sync-k8s-content.yml)
**Trigger:** Push to `k8s-bootstrap/**`

| Step | Action |
|------|--------|
| 1 | Discover S3 bucket from SSM (`/k8s/{env}/scripts-bucket`) |
| 2 | `aws s3 sync k8s-bootstrap/ → s3://{bucket}/k8s-bootstrap/` |
| 3 | Create/update SSM State Manager association |
| 4 | Trigger immediate association apply |

**What gets installed:**
- kubeadm Kubernetes cluster initialization
- Traefik (ingress controller → EIP starts responding)
- ArgoCD (GitOps controller)
- Helm charts (Prometheus, Grafana, cert-manager)

### 3b: App Deploy Sync

**Workflow:** [`sync-k8s-app-deploy-{env}.yml`](.github/workflows/sync-k8s-app-deploy-dev.yml)
**Reusable:** [`_sync-k8s-content.yml`](.github/workflows/_sync-k8s-content.yml)
**Trigger:** Push to `app-deploy/**`

| Step | Action |
|------|--------|
| 1 | Discover S3 bucket from SSM |
| 2 | `aws s3 sync app-deploy/ → s3://{bucket}/app-deploy/` |
| 3 | Create/update SSM State Manager association |
| 4 | Trigger immediate association apply |

**What gets deployed:**
- Next.js application pods
- IngressRoutes (Traefik → Next.js)
- Kubernetes namespaces, ResourceQuotas, NetworkPolicies

> [!NOTE]
> Phases 3a and 3b **can run in parallel**. Bootstrap initialises the kubeadm cluster and platform components; app deploy pushes the workload manifests. SSM State Manager ensures they're applied in the correct order on the instance.

> [!WARNING]
> **SM-B (Config Orchestrator) decommission in progress.** Phase 3b previously triggered SM-B, which ran `deploy.py` scripts on the control plane to inject Kubernetes Secrets and ConfigMaps. SM-B is being replaced by ArgoCD-managed External Secrets Operator (ESO) for all secret injection. See [`docs/Migrate_SSM_Automation.md`](../Migrate_SSM_Automation.md) and the decommission plan at [`docs/superpowers/plans/2026-04-23-decommission-sm-b.md`](../superpowers/plans/2026-04-23-decommission-sm-b.md).

---

## Day-1 Orchestration — All-in-One

For fresh environments, the [`day-1-orchestration.yml`](.github/workflows/day-1-orchestration.yml) workflow chains everything:

```mermaid
flowchart TD
    GATE["Gate\n(Confirm DEPLOY-DAY1)"]
    P1["Phase 1: Shared VPC + ECR"]
    P2["Phase 2: K8s Infra (5 stacks)"]
    P3A["Phase 3a: Bootstrap Sync"]
    P3B["Phase 3b: App Manifest Sync"]
    SUM["Phase 4: Summary"]

    GATE --> P1 --> P2
    P2 --> P3A
    P2 --> P3B
    P3A --> SUM
    P3B --> SUM

    style GATE fill:#fdd,stroke:#333
    style P1 fill:#f9f,stroke:#333
    style P2 fill:#6d6,stroke:#333
    style P3A fill:#69f,stroke:#333
    style P3B fill:#69f,stroke:#333
    style SUM fill:#ddd,stroke:#333
```

| Feature | Detail |
|---------|--------|
| **Trigger** | Manual only (`workflow_dispatch`) |
| **Safety** | Requires typing `DEPLOY-DAY1` to confirm |
| **Concurrency** | One run per environment |
| **Toggleable** | Each phase can be independently skipped via inputs |

---

## What Runs When?

### On Push to `main` / `develop`

| Changed Files | Pipeline Triggered | What Deploys |
|--------------|-------------------|--------------|
| `infra/**` | `deploy-kubernetes-{env}.yml` | CDK stacks (Data → Base → Compute → AppIam → Edge) |
| `k8s-bootstrap/**` | `sync-k8s-bootstrap-{env}.yml` | Boot scripts → S3 → SSM association |
| `app-deploy/**` | `sync-k8s-app-deploy-{env}.yml` | App manifests → S3 → SSM association |
| Both infra + bootstrap | Both pipelines (independent) | Infrastructure + bootstrap in parallel |

### Manual Triggers

| Workflow | When to Use |
|----------|-------------|
| `day-1-orchestration.yml` | Fresh environment (Day-0 → Day-1) |
| `build-golden-ami-{env}.yml` | Force a new Golden AMI bake |
| `sync-k8s-bootstrap-{env}.yml` | Re-apply bootstrap manually |
| `sync-k8s-app-deploy-{env}.yml` | Re-apply app manifests manually |

---

## Troubleshooting

### Day-0: `ValidationError: Unable to fetch parameters`
**Cause:** Golden AMI SSM parameter doesn't exist when Compute stack deploys.
**Fix:** The Data stack now seeds `/k8s/{env}/golden-ami/latest` with the parent AL2023 AMI ID. Ensure the Data stack deploys before Compute.

### Day-0: EIP HTTP unreachable
**Cause:** CDK provisions the instance but Traefik isn't installed yet.
**Fix:** Run `sync-k8s-bootstrap-{env}.yml` to install k3s + Traefik. The smoke test classifies this as non-critical.

### Day-0: CloudFront returns 404
**Cause:** CloudFront is configured but the origin (EIP) isn't serving content.
**Fix:** After bootstrap + app deploy sync, Next.js pods start → Traefik routes traffic → CloudFront returns 200.

### API Stack: NOT_FOUND
**Cause:** The API stack is optional (application-layer, deployed separately).
**Status:** The smoke test treats this as non-critical and logs a warning.

---

## Application Deployment: Frontend BlueGreen via Argo Rollouts

While infrastructure and bootstrap phases are handled natively by CDK and AWS SSM, the Next.js frontend has a bespoke, true zero-downtime deployment flow managed directly by GitHub Actions and Argo Rollouts.

**Workflow:** [`deploy-frontend.yml`](.github/workflows/deploy-frontend.yml)

### Delivery Sequence
1. **Container Build**: A standalone Docker image is built and tagged uniquely with `${{ github.sha }}-r${{ github.run_attempt }}` enabling GitOps deterministic tracking.
2. **S3 Static Chunk Sync**: The `frontend-ops/sync-static-to-s3.ts` script syncs the new `.next/BUILD_ID` to S3. Crucially, it **retains both the new and previous static chunks** to prevent `404` CSS/JS errors from the Active pod during the transition.
3. **In-Place Image Test**: The script `edge-stack.integration.test.ts` validates that the image in ECR perfectly aligns with the static chunks uploaded to S3.
4. **GitOps Trigger**: ArgoCD Image Updater detects the new ECR image tag and commits it back to the cluster repository (`nextjs-values.yaml`).
5. **Rollout Transition**: Argo Rollouts generates a new Preview ReplicaSet.
6. **Live Integration Testing**: The pipeline executes `bluegreen.integration.test.ts` over an SSM tunnel to assert that the Kubernetes Services correctly segregate traffic between the stable components and the preview environment.
7. **Promotion**: Pre-promotion PromQL queries analyze standard metrics; if healthy, Argo Rollouts performs a full cutover and terminates the previous ReplicaSet.

## Related

- [Progressive delivery with Argo Rollouts](progressive-delivery-rollouts.md) — Blue/Green mechanics and promotion commands
- [ArgoCD Image Updater](argocd-image-updater.md) — how ECR tag detection triggers Rollouts
- [SSM Automation bootstrap](ssm-automation-bootstrap.md) — SM-A bootstrap orchestrator design
- [Migrate SSM Automation](../Migrate_SSM_Automation.md) — SM-B decommission plan

<!--
Evidence trail (auto-generated):
- Source: docs/incoming/deployment-pipeline-guide.md (migrated 2026-04-28 — three-layer decoupled architecture, CDK stack ordering, Phase 3 SSM associations, Day-1 orchestration, Frontend BlueGreen delivery sequence)
- Update: SM-B decommission note added per docs/superpowers/plans/2026-04-23-decommission-sm-b.md reference
- Generated: 2026-04-28
-->
