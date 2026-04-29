---
title: Bootstrap Deploy and Test Reference
type: runbook
tags: [bootstrap, ssm-automation, step-functions, testing, kubernetes, kubeadm]
sources:
  - sm-a/
  - kubernetes-app/k8s-bootstrap/
  - infra/lib/stacks/k8s/
created: 2026-04-28
updated: 2026-04-28
---

This wiki covers the complete iteration loop for the CDK-managed Kubernetes bootstrap pipeline. It explains when and how to use each testing layer — from offline Python unit tests, through interactive SSM shells, all the way to full Step Functions executions — and documents every `just` recipe and raw AWS CLI command needed to move between them.

---

## System Architecture & Script Reference

Before diving into workflows and commands, this section explains **what the scripts actually do, why they exist, and how they fit the overall application design**. If you are new to the codebase or returning after a gap, read this section first.

---

### Why Self-Hosted Kubernetes Needs Bootstrap Scripts

Managed Kubernetes services (EKS, GKE, AKS) provision the control plane, networking, and node registration automatically on your behalf. **Self-hosted Kubernetes (kubeadm on EC2) does not.** After an EC2 instance boots from the Golden AMI, it is just a machine with the right binaries installed. Nothing is running. No cluster exists.

These Python scripts are the automation layer that turns a blank EC2 instance into a functioning Kubernetes node — and keeps it that way across every replacement, scaling event, and disaster recovery scenario. They run via SSM Run Command (triggered by Step Functions) so there is no need for SSH access, bastion hosts, or human intervention.

**Why Python, not shell scripts?**
Shell scripts become fragile at this complexity level — they have no type safety, poor error handling, and no unit testability. Python with structured step runners (`StepRunner`), marker files for idempotency, and boto3 for AWS API calls gives the same capability with testable, maintainable code. The 75-test offline pytest suite would not be possible with bash.

---

### Two Execution Tiers

Every script in this system belongs to one of two clearly separated tiers, each managed by its own dedicated Step Functions state machine:

```
┌─────────────────────────────────────────────────────────────────┐
│  TIER 1 — BOOTSTRAP SCRIPTS  (kubernetes-app/k8s-bootstrap/)    │
│                                                                   │
│  Run once on the EC2 node at first boot (or re-run on           │
│  replacement). Responsible for making the node a Kubernetes      │
│  cluster member. Must complete before any pod can be scheduled.  │
│                                                                   │
│  Entry points:  control_plane.py  /  worker.py                  │
│  Orchestrated by: SM-A  (Bootstrap Orchestrator)                │
│  SM-A started by: trigger-bootstrap.ts (GHA Phase 4)            │
│  Runs as:       root (SSM Run Command document)                  │
│  Log group:     /ssm/k8s/development/bootstrap (CloudWatch)     │
│                 /data/k8s-bootstrap/logs/                        │
└─────────────────────────────────────────────────────────────────┘
           │
           │  SM-A SUCCEED → EventBridge rule fires SM-B
           │  (self-healing: any node replacement auto-retriggers)
           ▼
┌─────────────────────────────────────────────────────────────────┐
│  TIER 2 — DEPLOY SCRIPTS  (kubernetes-app/workloads/charts/)    │
│                                                                   │
│  Run after the cluster is healthy. Responsible for deploying     │
│  application-level Kubernetes resources (Secrets, ConfigMaps,    │
│  IngressRoutes). Run on the control plane because they need      │
│  access to /etc/kubernetes/admin.conf (the cluster kubeconfig).  │
│                                                                   │
│  Entry points:  nextjs/deploy.py, monitoring/deploy.py,         │
│                 start-admin/deploy.py, admin-api/deploy.py,      │
│                 public-api/deploy.py                             │
│  Orchestrated by: SM-B  (Config Orchestrator)                   │
│  SM-B started by: EventBridge (auto) OR trigger-config.ts       │
│  Runs as:       root (SSM Run Command document)                  │
│  Log group:     /ssm/k8s/development/deploy (CloudWatch)        │
└─────────────────────────────────────────────────────────────────┘
```

The two orchestrators are **decoupled by design**. SM-A manages cluster infrastructure (control-plane bootstrap, worker re-join). SM-B manages application runtime configuration (K8s Secrets, ConfigMaps, IngressRoutes). EventBridge bridges them: when SM-A SUCCEEDS, SM-B fires automatically — enabling self-healing without any CI pipeline involvement.

> **Local equivalents:**
> - `just bootstrap-run $INSTANCE_ID` — runs `bootstrap-argocd.sh` **directly on EC2 via `AWS-RunShellScript`** (ArgoCD-only Day-2 re-run, **not** SM-A)
> - `just config-run development` — manually triggers SM-B config injection (all 5 deploy.py scripts)
> - `just config-status` — shows the latest SM-B execution ARN and status
>
> ⚠️ `bootstrap-run` and SM-A are **not** equivalent. See the [Execution Path Decision Guide](#execution-path-decision-guide) below.

---

### Tier 1 — Bootstrap Scripts: What Each Step Does

#### `control_plane.py` — The Control Plane Entrypoint

The single entry point for bootstrapping an EC2 instance into the Kubernetes **control plane**. Runs all 10 steps in order, each idempotent (safe to re-run):

| Step | Module | What it does |
|---|---|---|
| 1 | `common.step_validate_ami` | Verifies Golden AMI binaries (`kubeadm`, `kubelet`, `kubectl`, `containerd`) and kernel settings (`net.ipv4.ip_forward`, `br_netfilter`) are correct before touching the cluster |
| 2 | `cp/dr_restore.py` | **Disaster recovery**: if admin.conf is missing but S3 has an etcd snapshot, restores certificates and etcd data before `kubeadm init`. Enables full cluster reconstruction from backup |
| 3 | `cp/ebs_volume.py` | Formats (first boot only) and mounts the EBS data volume at `/data/`. Creates `kubernetes/`, `k8s-bootstrap/`, and `app-deploy/` directories. **This is what persists cluster state across instance replacements** |
| 4 | `cp/kubeadm_init.py` | Runs `kubeadm init` with the cluster config, creates a Route 53 DNS record for the API server, backs up certificates to S3, and publishes the join token + CA hash to SSM so worker nodes can discover them |
| 5 | `cp/calico.py` | Installs the **Calico CNI** via the Tigera operator. See explanation below |
| 5b | `cp/ccm.py` | Installs the **AWS Cloud Controller Manager** via Helm. See explanation below |
| 6 | `cp/kubectl_access.py` | Copies the kubeconfig to `~root`, `~ec2-user`, and `~ssm-user` so all three accounts can run `kubectl` commands interactively |
| 7 | `cp/s3_sync.py` | Downloads all bootstrap manifests from S3 onto the instance at `/data/k8s-bootstrap/`. Includes the ArgoCD helm values, Traefik config, and PodDisruptionBudgets |
| 8 | `cp/argocd.py` | Installs ArgoCD from the vendored Helm chart and applies the **App-of-Apps** root application. From this point, ArgoCD owns the declarative state of all cluster workloads |
| 9 | `cp/verify.py` | Post-boot health checks: all nodes Ready, core namespace pods healthy (`kube-system`, `calico-system`, `tigera-operator`, `argocd`), ArgoCD Application sync status, outside-in API server connectivity |
| 10 | `cp/etcd_backup.py` | Installs a systemd timer that runs `etcd-backup.sh` **hourly**, pushing snapshots to S3. Enables disaster recovery via step 2 above |

**Idempotency:** Each step creates a marker file (e.g. `/etc/kubernetes/.calico-installed`) on first success. On re-run (e.g. after an AMI upgrade or instance replacement), the step checks for the marker and skips if already complete.

---

#### `worker.py` — The Worker Node Entrypoint

The entry point for bootstrapping EC2 instances into worker node pools (`general`, `monitoring`). Simpler than the control plane — it joins an existing cluster rather than creating one:

| Step | Module | What it does |
|---|---|---|
| 1 | `common.step_validate_ami` | Same AMI validation as the control plane |
| 2 | `wk/join_cluster.py` | Reads the join token and CA hash from SSM (published by `kubeadm_init.py`). Detects CA mismatches (control plane was replaced), retries with token refresh. Runs `kubeadm join` then checks kubelet health |
| 3 | `common.step_install_cloudwatch_agent` | Installs the CloudWatch agent so the node's system logs stream to CloudWatch |
| 4 | `wk/stale_pvs.py` | Monitoring workers only: removes PersistentVolumeClaims from dead nodes to unblock pod rescheduling (Loki, Prometheus bind PVCs to specific nodes) |
| 5 | `wk/verify_membership.py` | Confirms the node is registered in the cluster and that its node labels (`role=application`, `node-pool=general`) match the expected values. Triggers a rejoin if the node is missing or has drifted labels |

---

### Why Calico? What Is a CNI?

After `kubeadm init` completes, the Kubernetes control plane is running — but **no pod can be scheduled yet**. Every node gets the taint `node.kubernetes.io/not-ready` until a CNI (Container Network Interface) plugin is installed.

A CNI is the network layer that:
- Assigns an IP address from the pod CIDR (`192.168.0.0/16`) to every pod
- Routes traffic between pods on different nodes
- Enforces `NetworkPolicy` rules that isolate namespaces and services

Without a CNI, pods remain in `Pending` state indefinitely. The control plane itself cannot function — CoreDNS stays `Pending`, kubeadm cannot confirm readiness, and nothing follows.

**Why Calico specifically?**

| Requirement | Why Calico satisfies it |
|---|---|
| Supports `NetworkPolicy` | Native, not bolted on |
| Works on EC2 without BGP peering | VXLAN encapsulation mode (`encapsulation: VXLAN`) routes pod traffic without needing Layer 3 routing configuration in AWS |
| Managed via Kubernetes operator | Tigera operator means Calico itself is declarative and upgradeable via `kubectl apply` |
| PodDisruptionBudgets supported | Calico node DaemonSets can tolerate rolling updates without losing network connectivity |
| Resource-bounded | Explicit CPU/memory requests prevent calico-node from starving application pods on small nodes |

The `calico.py` step applies the Tigera operator manifest, then waits for the `Installation` custom resource to reach `Available` before proceeding. It also applies the PodDisruptionBudget manifests (`system/calico-pdbs.yaml`) to protect Calico during node drain operations.

---

### Why the AWS Cloud Controller Manager (CCM)?

After `kubeadm init`, every EC2 node gets the taint:

```
node.cloudprovider.kubernetes.io/uninitialized
```

This taint blocks **all** pod scheduling on the node — including CoreDNS, ArgoCD, and even the Calico operator pods. The taint exists because Kubernetes knows it is running on a cloud provider but has not yet verified the node's cloud identity.

The AWS CCM removes this taint by:
1. Calling the EC2 API to verify the instance identity (via IMDS)
2. Setting the `spec.providerID` field (`aws:///eu-west-1a/i-0abc123`) on the node object
3. Removing the `uninitialized` taint so pods can be scheduled

Without the CCM, no pods can schedule at all — the cluster is created but immediately non-functional. The `ccm.py` step installs the CCM via Helm and waits up to 120 seconds for the taint to be removed. ArgoCD later adopts the Helm release and manages future upgrades declaratively.

---

### Tier 2 — Deploy Scripts: What Each One Does

Deploy scripts run **after the cluster is bootstrapped and healthy**. They do not install system components — they create application-level Kubernetes resources (Secrets, ConfigMaps, IngressRoutes) that the pods in the cluster need to function.

All deploy scripts run on the **control plane node** (which has `/etc/kubernetes/admin.conf`) via the `k8s-dev-deploy-runner` SSM document, orchestrated sequentially by **SM-B (Config Orchestrator)**.

SM-B executes the five scripts in a fixed order — each step depends on the previous completing without error:

| Step | Script | What it creates | SSM parameters it reads |
|---|---|---|---|
| 1 | `nextjs/deploy.py` | `nextjs-secrets` (K8s Secret), `nextjs-config` (ConfigMap), Traefik IngressRoute + originSecret patch | Cognito auth, DynamoDB table names, S3 bucket, CloudFront origin secret |
| 2 | `monitoring/deploy.py` | Grafana Secret, Prometheus ConfigMap, Helm chart release | Grafana admin credentials, GitHub K8s secrets, alerting endpoints |
| 3 | `start-admin/deploy.py` | `start-admin-secrets` (K8s Secret), Cognito + DynamoDB + Bedrock config | Cognito client ID, DynamoDB table, Bedrock endpoint |
| 4 | `admin-api/deploy.py` | `admin-api-secrets` (K8s Secret), `admin-api-config` (ConfigMap), Traefik IngressRoute | Cognito auth, DynamoDB tables, Lambda ARN |
| 5 | `public-api/deploy.py` | `public-api-config` (ConfigMap), Traefik IngressRoute | DynamoDB table names, S3 bucket |

**Why not put these values in the Helm chart?** The values in SSM (Cognito pool IDs, DynamoDB table names, S3 bucket names) are **environment-specific** and **secret**. Putting them in a Helm chart values file would either leak secrets into git or require a secrets management layer. SSM Parameter Store is the single source of truth — the deploy scripts bridge between SSM and Kubernetes, creating the Secrets and ConfigMaps that the pods mount at runtime.

**Why run on the control plane and not the worker nodes?** The deploy scripts use `kubectl apply` which requires the cluster admin kubeconfig (`/etc/kubernetes/admin.conf`). This file exists only on the control plane. Worker nodes are joined members — they do not have admin credentials and cannot issue `kubectl` commands.

---

### The Overall Application Design: How It All Connects

```
AWS (CDK-managed infrastructure)
├── EC2 + ASG  ← instances boot from Golden AMI
├── SSM Parameter Store  ← cluster join tokens, S3 bucket names, app config
├── S3  ← bootstrap scripts, etcd backups, manifests
├── SM-A (Bootstrap Orchestrator)  ← cluster infrastructure lifecycle
├── SM-B (Config Orchestrator)     ← application runtime config injection
├── EventBridge  ← bridges SM-A SUCCEED → SM-B (self-healing)
└── SSM Run Command  ← executes scripts on EC2 without SSH

                  ↓ On every new instance (or replacement)

Golden AMI boots  →  EC2 user data publishes instance ID to SSM
                  →  SM-A (Bootstrap Orchestrator) triggered by GHA
                         Step 3: EBS mounted (cluster state persists)
                         Step 4: kubeadm init (or rejoin)
                         Step 5: Calico CNI installed (pods can schedule)
                         Step 5b: CCM installed (AWS taint removed)
                         Step 8: ArgoCD installed (declarative sync begins)
                                     ↓
                         ArgoCD syncs all applications from Git:
                           Traefik (ingress)
                           cert-manager (TLS)
                           nextjs, admin-api, public-api, start-admin
                           Prometheus + Loki + Grafana (observability)
                                     ↓
                  →  SM-A SUCCEED fires EventBridge rule
                  →  SM-B (Config Orchestrator) triggered automatically
                         Step 1: nextjs/deploy.py   (K8s Secrets + IngressRoute)
                         Step 2: monitoring/deploy.py (Grafana + Helm chart)
                         Step 3: start-admin/deploy.py (Cognito + Bedrock)
                         Step 4: admin-api/deploy.py  (ConfigMap + IngressRoute)
                         Step 5: public-api/deploy.py (ConfigMap + IngressRoute)
                                     ↓
                         All pods have their config — applications are live
```

The cluster is fully self-healing after the bootstrap phase:
- **ArgoCD** manages all workloads from Git — any Git commit auto-deploys.
- **SM-B + EventBridge** re-injects runtime secrets automatically whenever SM-A completes — any EC2 replacement triggers the full config injection cycle without CI pipeline involvement.
- **No secrets ever touch Git.** No manual `kubectl apply` is needed in normal operation.

To trigger SM-B manually (secret rotation, testing):
```bash
just config-run development
just config-status   # check latest execution
```

---

## Architecture Decision Records

These decisions were not arbitrary. Each one was made to solve a concrete constraint imposed by self-hosted Kubernetes on EC2. This section documents the reasoning so that future changes can be evaluated against the same constraints.

---

### ADR-1: Python for EC2 Scripts (Not TypeScript or Bash)

**Decision:** All bootstrap and deploy scripts running on EC2 instances are written in Python.

**Why not TypeScript?**

TypeScript is the standard for infrastructure-as-code in this monorepo (CDK stacks, GitHub Actions scripts, API services). However, TypeScript is a poor fit for scripts that run directly on EC2 via SSM Run Command:

| Constraint | TypeScript on EC2 | Python on EC2 |
|---|---|---|
| **Runtime availability** | Requires Node.js installed on the AMI | Python 3 ships with Amazon Linux 2023 — zero AMI overhead |
| **Dependency installation** | `npm install` needs network access at runtime; inside the `opt/k8s-venv/` virtualenv Python deps are pre-installed on the AMI | `boto3`, `pyyaml` pre-installed in `/opt/k8s-venv/` at AMI build time |
| **AWS SDK** | `@aws-sdk/client-ssm` requires Node module resolution at runtime | `boto3` is the native AWS Python SDK — stable, battle-tested, and available on every AWS-managed environment |
| **Subprocess calls** | `child_process.spawn` for `kubeadm`, `kubectl`, `helm` is verbose and lacks structured error handling | `subprocess.run(check=True, capture_output=True)` with Python's `shlex` is idiomatic and easily mockable |
| **Unit testability** | Mocking `child_process` in Jest is complex; no native mock for `aws-sdk` in unit tests | `pytest-mock` provides `mocker.patch('subprocess.run')` and `mocker.patch('boto3.client')` — the entire AWS surface is mockable offline |
| **Error handling** | Unhandled promise rejections can silently swallow errors | Python exceptions propagate explicitly; `StepRunner` wraps every step in `try/except` with structured logging |

**Why not Bash?**

Bash was the original approach for individual steps. It was replaced with Python for two reasons:

1. **No unit testability.** The 75-test offline pytest suite (`just bootstrap-pytest`) is only possible in Python. Bash has no equivalent — `bats` exists but cannot easily mock `aws` CLI calls or subprocess behaviour.
2. **Idempotency is fragile in Bash.** Marker file checks, retry loops with exponential backoff, and CA mismatch detection (in `wk/join_cluster.py`) require structured logic that becomes unmaintainable in shell.

**The Golden AMI pre-installs:**
```
/opt/k8s-venv/
├── bin/python3         ← venv interpreter used by all SSM documents
├── lib/python3.x/
│   └── site-packages/
│       ├── boto3/
│       ├── yaml/
│       └── ...
```

The SSM Run Command document prepends `/opt/k8s-venv/bin` to `$PATH` so `python3` inside the document always resolves to the venv — never the system interpreter. This is why bare `python3` in an interactive `ssm-shell` resolves differently and why `--dry-run` commands must explicitly use `/opt/k8s-venv/bin/python3`.

---

### ADR-2: SSM Run Command (not SSH, Ansible, or CodeDeploy)

**Decision:** All remote script execution on EC2 nodes uses AWS SSM Run Command via the `k8s-dev-bootstrap-runner` and `k8s-dev-deploy-runner` SSM documents. No SSH, no Ansible, no bastion.

**Why SSM Run Command and not SSH?**

SSH requires:
- A key pair distributed to every machine and every developer
- Security groups with port 22 open (a compliance concern)
- A bastion host or VPN to reach private instances
- Manual key rotation when engineers leave

SSM Run Command requires:
- The EC2 instances to have the SSM agent (pre-installed on Amazon Linux 2023)
- An IAM instance profile with `ssm:SendCommand` permission
- Nothing else — no keys, no ports, no bastion

The `just ssm-shell` recipe calls `AWS-StartInteractiveCommand` (a built-in SSM document) using your local AWS credentials via OIDC — the same credentials that deploy infrastructure. **Access is governed by IAM, not by key distribution.**

**Why SSM Run Command and not SSM Automation (the YAML document type)?**

SSM Automation (schema 0.3, the YAML `runCommand` action type) was the first implementation and is still used for the bootstrap runner documents (`k8s-dev-bootstrap-runner`, `k8s-dev-deploy-runner`). However, the **orchestration** of those documents was migrated from pure SSM Automation to Step Functions. The reasons:

| Requirement | SSM Automation alone | Step Functions + SSM RunCommand |
|---|---|---|
| **Conditional branching** | Limited `aws:branch` with string comparisons | Native `Choice` states with full JSONPath expressions |
| **Parallel execution** | No native parallel branches | Native `Parallel` state |
| **Wait for completion** | No built-in polling — requires `aws:waitForAwsResourceProperty` which has a 2-hour hard limit | Custom poll loop (`sendCommand` → `Wait` → `getCommandInvocation` → retry) with configurable timeouts |
| **State passing between steps** | Manual SSM parameter reads/writes per step | First-class JSON state machine context (`$.router.ssmPrefix`, `$.Payload`) |
| **Failure handling** | `onFailure: Abort` terminates execution silently | `Catch` clauses route to `Fail` states with structured error messages visible in the console |
| **Observability** | Execution history disappears after 30 days | CloudWatch Logs integration with structured JSON per step, retained permanently |
| **Debuggability** | Opaque YAML document — hard to trace which step failed | Step Functions visual console shows every state transition and input/output payload |

**Why SSM Run Command and not Ansible, Chef, or similar?**

Configuration management tools (Ansible, Chef, Puppet) are designed for *ongoing* configuration drift correction. This system has a different model:

- Instances boot from a **Golden AMI** with all software pre-installed
- Bootstrap runs **once**, creates idempotency markers, and is never expected to re-run unless the instance is replaced
- There is no drift to correct — ArgoCD manages cluster state declaratively and `verify_membership.py` handles node registration drift

Adding an Ansible control node would require additional EC2 instances, network access, inventory management, and key distribution — all problems SSM Run Command already solves without any additional infrastructure.

---

### ADR-3: AWS Step Functions for Orchestration (Not Lambda Chains or EventBridge Pipes)

**Decision:** The bootstrap and config injection sequences are each orchestrated by a dedicated AWS Step Functions Express Workflow, defined in TypeScript via CDK constructs in `infra/lib/constructs/ssm/`.

#### SM-A — Bootstrap Orchestrator (`bootstrap-orchestrator.ts`)

Manages cluster infrastructure: control-plane bootstrap, worker re-join. Terminates when all workers have rejoined. **Does not run deploy scripts.**

```
GHA trigger (trigger-bootstrap.ts)
    ↓
SM-A execution starts
    ↓
State 1: InvokeRouter Lambda
    → Reads ASG tags (k8s:bootstrap-role, k8s:ssm-prefix)
    → Returns: { role, ssmPrefix, instanceId, s3Bucket }
    ↓
State 2: UpdateInstanceId
    → Writes instanceId to SSM (/k8s/{env}/bootstrap/control-plane-instance-id)
    ↓
State 3: BootstrapControlPlane (sendCommand → Wait 30s → Poll Loop)
    → Sends control_plane.py via SSM Run Command
    → Polls every 30s via getCommandInvocation
    → Retries up to 60 times (30 min total)
    ↓
State 4 (parallel): RejoinGeneralPool, RejoinMonitoringPool
    → sendCommand worker.py to each worker pool instance
    ↓
SUCCEED → EventBridge rule fires SM-B automatically
```

#### SM-B — Config Orchestrator (`config-orchestrator.ts`)

> [!WARNING]
> **SM-B is being decommissioned.** The `deploy.py` secret injection scripts are being replaced by ArgoCD-managed External Secrets Operator (ESO). The SM-B state machine and EventBridge trigger will be removed once ESO migration is complete. See [`docs/Migrate_SSM_Automation.md`](../Migrate_SSM_Automation.md) and [`docs/superpowers/plans/2026-04-23-decommission-sm-b.md`](../superpowers/plans/2026-04-23-decommission-sm-b.md) for the migration plan.

Manages application runtime config: 5 deploy.py scripts sequentially on the control plane. Triggered by EventBridge (auto) **or** `trigger-config.ts` (manual / GHA Phase 6).

```
EventBridge (SM-A SUCCEED) OR trigger-config.ts (GHA / just config-run)
    ↓
SM-B execution starts
    ↓
State 1: ResolveControlPlane
    → Reads /k8s/{env}/bootstrap/control-plane-instance-id from SSM
    → (No router Lambda needed — CP instance ID written by SM-A)
    ↓
State 2: DeployNextjs   → nextjs/deploy.py   (sendCommand → Poll Loop)
State 3: DeployMonitoring → monitoring/deploy.py
State 4: DeployStartAdmin → start-admin/deploy.py
State 5: DeployAdminApi  → admin-api/deploy.py
State 6: DeployPublicApi  → public-api/deploy.py
    ↓
SUCCEED / FAIL (structured error to CloudWatch + GitHub Step Summary)
```

**Self-healing property:** Because SM-B is triggered by EventBridge on SM-A SUCCEED, any replacement of the control-plane EC2 instance (planned or unplanned) automatically re-injects all five application secrets without any CI pipeline or human intervention.

**Why not a Lambda chain (Lambda A calls Lambda B)?**

Lambda chains (also called "Lambda orchestration") were a common pattern before Step Functions matured. They have fundamental problems:

- **No timeout guarantee.** If Lambda A times out while waiting for Lambda B, you have no visibility into where the failure occurred.
- **No visual state.** You cannot see in-flight execution state without custom logging.
- **No retry logic.** Each Lambda must implement its own retry/backoff, creating duplicated boilerplate.
- **No long-running support.** Lambda has a 15-minute hard timeout. The `BootstrapControlPlane` step can take up to **30 minutes** (kubeadm init + Calico install + ArgoCD sync). Step Functions has no such limit.

**Why not bare EventBridge rules with Lambda targets?**

EventBridge can trigger a Lambda when an EC2 instance launches. But a single Lambda cannot:
- Wait for a 30-minute SSM command to complete
- Poll for completion in a loop
- Branch conditionally (control plane vs worker) based on ASG tags
- Execute worker rejoins in parallel after the control plane is confirmed healthy

All of that would require a Lambda-chain, which reintroduces every problem above.

**Why not AWS CodePipeline?**

CodePipeline is designed for CI/CD artifact pipelines (build → test → deploy). It is not designed for:
- Event-triggered, instance-specific infra orchestration
- Dynamic branching based on resource tags at runtime
- Sub-minute polling intervals (CodePipeline polls on a 1-minute minimum)
- SSM Run Command native integration

**The specific CDK pattern used:**

```typescript
// bootstrap-orchestrator.ts — real architecture
const startExec = new sfnTasks.CallAwsService(this, `${id}Start`, {
    service: 'ssm',
    action: 'sendCommand',           // ← native SSM Run Command
    parameters: {
        DocumentName: runnerDocName, // k8s-dev-bootstrap-runner
        InstanceIds: [JsonPath.stringAt('$.router.instanceId')],
        // ...
    },
});

// Custom poll loop — Step Functions has no native SSM command waiter
const pollStatus = new sfnTasks.CallAwsService(this, `${id}Poll`, {
    service: 'ssm',
    action: 'getCommandInvocation',
    // ...
});

const choice = new sfn.Choice(this, `${id}Choice`)
    .when(sfn.Condition.stringEquals('$.status', 'InProgress'), waitState)
    .when(sfn.Condition.stringEquals('$.status', 'Success'), continueState)
    .otherwise(failState);   // TimedOut, Failed, Cancelled
```

There is no native `sfnTasks.SsmRunCommand.waitForCompletion()` in CDK — the poll loop is custom-built because that granularity of control is required.

---

### ADR-4: GitHub Actions for CI/CD (Not Jenkins, CircleCI, or CodePipeline)

**Decision:** The entire CI/CD pipeline runs on GitHub Actions, using OIDC for AWS credential federation and a custom Docker CI image.

**Pipeline structure:**

| Workflow file | What it does |
|---|---|
| `deploy-kubernetes.yml` | CDK stack deployment for K8s infra — deploys SM-A, SM-B, EventBridge, IAM, EC2 compute |
| `deploy-ssm-automation.yml` | Syncs scripts to S3, triggers SM-A (Phase 4), verifies SM-A health (Phase 5), triggers SM-B (Phase 6) — **the primary day-2 pipeline** |
| `deploy-post-bootstrap.yml` | Triggers SM-B (Config Orchestrator) only — for secret rotation or targeted config re-injection without re-bootstrap |
| `gitops-k8s.yml` | ArgoCD GitOps sync — applies platform charts (Traefik, cert-manager, monitoring) |
| `deploy-api.yml` | Builds and pushes Docker images for `admin-api`, `public-api` |
| `deploy-frontend.yml` | Builds Next.js and `start-admin`, pushes to ECR |
| `deploy-bedrock.yml` | Deploys AI/ML stack (Bedrock, Lambda, DynamoDB) |

**Why GitHub Actions and not Jenkins?**

Jenkins requires a dedicated server, plugin management, and ongoing maintenance. GitHub Actions is:
- **Zero infrastructure.** No Jenkins master to operate, patch, or scale.
- **Source-local.** Workflows live in `.github/workflows/` — the pipeline is code-reviewed with the feature branch, not managed separately.
- **Composable.** Reusable workflows (`_deploy-kubernetes.yml`, `_deploy-ssm-automation.yml`) are called from root workflows via `uses:`, eliminating duplication.

**Why OIDC and not long-lived AWS access keys?**

Long-lived AWS keys in GitHub Secrets are a significant security risk — they never expire, cannot be scoped to a single execution, and are a common target for secret scanning. OIDC (OpenID Connect) federation issues **temporary credentials per workflow run**:

```yaml
permissions:
  id-token: write  # Required to request the OIDC JWT from GitHub

- uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: ${{ secrets.AWS_OIDC_ROLE }}
    aws-region: ${{ vars.AWS_REGION }}
```

The GitHub OIDC token is exchanged for temporary STS credentials scoped to the IAM role `AWS_OIDC_ROLE`. The role trust policy restricts which repository and branch can assume it. **No static AWS credentials exist anywhere in the pipeline.**

**Why a custom Docker CI image?**

```yaml
container:
  image: ghcr.io/nelson-lamounier/cdk-monitoring/ci:latest
```

The custom `ci:latest` image pre-installs:
- Node.js + Yarn (pinned versions)
- Python 3 + boto3 + pytest
- AWS CLI v2
- `just` (command runner)
- `kubectl`, `helm`, `kubeadm` (for integration test assertions)

This eliminates the `apt-get install` / `pip install` / `npm install` steps that dominate most GitHub Actions pipelines. Runner startup goes from ~3–5 minutes of installation to ~15 seconds of image pull. It also guarantees identical environments between local `just` recipes and CI jobs — the same `pytest` version, the same `boto3` version, the same `aws` CLI behaviour.

**Why path-scoped triggers?**

```yaml
on:
  push:
    branches: [develop]
    paths:
      - 'kubernetes-app/k8s-bootstrap/**'
      - 'kubernetes-app/workloads/charts/**'
```

The monorepo contains infrastructure (CDK), frontend (Next.js, TanStack), API services, Kubernetes scripts, and AI/ML code. Without path scoping, every commit would trigger every pipeline. With path scoping:
- Bootstrap script changes trigger `deploy-ssm-automation.yml`
- CDK stack changes trigger `deploy-kubernetes.yml`
- API code changes trigger `deploy-api.yml`
- Frontend changes trigger `deploy-frontend.yml`

Each pipeline runs only when relevant files change — reducing pipeline queue time and unnecessary AWS deployments.

**Why `concurrency: cancel-in-progress: false`?**

```yaml
concurrency:
  group: deploy-ssm-bootstrap-development
  cancel-in-progress: false
```

Most pipelines use `cancel-in-progress: true` to abort stale runs when a new commit pushes. Bootstrap pipelines use `false` because cancelling a mid-flight Step Functions execution that is running `kubeadm init` on the control plane would leave the cluster in an undefined intermediate state. A queued pipeline run is safer than a cancelled bootstrap.

---

## The Problem This Solves

Every change to a `deploy.py` script or SSM document previously required a full pipeline round-trip:

```
Edit code → git commit → git push → GitHub Actions triggers
 → CDK synth (1–2 min) → CDK diff/deploy (2–5 min)
 → Step Functions execution (3–5 min) → CloudWatch tail
 → Total: 10–15 minutes per iteration
```

A broken SSM bash preamble (`set -u` on a non-login shell), a wrong S3 path in `deploy.py`, or a missing environment variable would each take 10 minutes to surface, with another full cycle required for any fix.

### The local-first iteration loop

```
Edit deploy.py → run local unit tests (< 5 s, no AWS)
 → sync single file to S3 (< 10 s) → ssm-shell to pull & run (< 30 s)
 → Total: under 1 minute per iteration
```

Only when all local tests pass does a commit get pushed. The pipeline then runs a known-good change — not an experiment.

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────────────┐
│  GitHub Actions (CI)                                                   │
│  .github/workflows/deploy-ssm-automation.yml                           │
│    Phase 4: trigger-bootstrap.ts → SM-A                                │
│    Phase 6: _post-bootstrap-config.yml → trigger-config.ts → SM-B      │
│                │                                                       │
│                │  CDK deploy → synthesises CloudFormation              │
│                ▼                                                       │
│  AWS CloudFormation (SsmAutomation-development)                        │
│  ├── SM-A  Bootstrap Orchestrator  ← cluster lifecycle                 │
│  ├── SM-B  Config Orchestrator     ← app runtime config                │
│  ├── EventBridge rule              ← SM-A SUCCEED → fires SM-B         │
│  ├── k8s-dev-bootstrap-runner      ← SSM document for Tier 1 scripts   │
│  ├── k8s-dev-deploy-runner         ← SSM document for Tier 2 scripts   │
│  └── IAM roles (SM-A role, SM-B role, router Lambda role)              │
└────────────────────────────────────────────────────────────────────────┘
         │ SM-A execution                         │ SM-B execution
         │ (control_plane.py, worker.py)          │ (deploy.py × 5)
         ▼                                        ▼
EC2 Control-Plane Node           EC2 Control-Plane Node
/data/k8s-bootstrap/             /data/app-deploy/<service>/deploy.py
         │                                        │
         ▼                                        ▼
kubeadm init, Calico, CCM      kubectl apply Secrets + ConfigMaps
ArgoCD App-of-Apps                    + IngressRoute patches
         │
         │  SM-A SUCCEED
         └──────────────→ EventBridge → SM-B fires automatically
                                        (self-healing, no CI needed)
```

### S3 bucket layout

The scripts bucket is resolved at runtime from SSM (`/k8s/development/scripts-bucket`):

```
s3://{bucket}/
  k8s-bootstrap/          # bootstrap scripts (control_plane.py, worker.py, etc.)
  app-deploy/
    admin-api/            # deploy.py + any helpers
    public-api/
    nextjs/
    monitoring/
    start-admin/
```

The SSM deploy-runner document (`k8s-dev-deploy-runner`) syncs from S3 to `/data/app-deploy/` on the EC2 node before executing the script.

---

## Logging Landscape

Four independent CloudWatch log groups capture every layer of the pipeline:

| Layer | Log Group | Retention | What's Logged |
|---|---|---|---|
| **SM-A (Bootstrap Orchestrator)** | `/aws/vendedlogs/states/k8s-dev-bootstrap-orchestrator` | 7 days | Every SM-A state transition, input/output JSON, execution errors |
| **SM-B (Config Orchestrator)** | `/aws/vendedlogs/states/k8s-dev-config-orchestrator` | 7 days | Every SM-B state transition — 5 deploy steps, input/output JSON |
| **SSM Bootstrap Runner** | `/ssm/k8s/development/bootstrap` | 14 days | Stdout/stderr of `control_plane.py`, `worker.py` on EC2 |
| **SSM Deploy Runner** | `/ssm/k8s/development/deploy` | 14 days | Stdout/stderr of every `deploy.py` script invoked by SM-B |

SSM CloudWatch output is routed via `CloudWatchOutputConfig` in the `sendCommand` call inside `buildRunCommandChain`. Every `echo`, Python `print`, and traceback lands in the appropriate log group, streamed per `CommandId`.

```bash
# Tail SM-A state transitions live
aws logs tail "/aws/vendedlogs/states/k8s-dev-bootstrap-orchestrator" \
  --region eu-west-1 --profile dev-account --follow --format short

# Tail SM-B state transitions live
aws logs tail "/aws/vendedlogs/states/k8s-dev-config-orchestrator" \
  --region eu-west-1 --profile dev-account --follow --format short

# Tail deploy script stdout (all 5 scripts stream here)
aws logs tail "/ssm/k8s/development/deploy" \
  --region eu-west-1 --profile dev-account --follow --format short
```

### Known gap

SSM stdout is **not** embedded in Step Functions history. You must cross-reference the `CommandId` from the Step Functions state output against the SSM log group. See the Debugging Reference section for the command to do this.

### SM-B execution ARN

`trigger-config.ts` always emits the execution ARN to `$GITHUB_OUTPUT` (`config_execution_arn`) and the GitHub Step Summary. For local runs:
```bash
just config-status   # prints the latest SM-B execution ARN and status
```

---

## Workflow A — Local Unit Tests

**When to use:** Every time you edit `deploy.py`. This is the first gate — if this fails, do not bother hitting AWS.

The `deploy_helpers/ssm.py` resolver checks for matching environment variables before making a boto3 API call. Setting `COGNITO_USER_POOL_ID=test-value` bypasses the SSM parameter lookup entirely. `_load_boto3()` is patched at the module level, so no AWS credentials are required.

```bash
# Run all tests for admin-api/deploy.py (13 tests, < 5 s)
just deploy-test admin-api

# Run tests for any other script
just deploy-test public-api
just deploy-test nextjs
```

### What is tested

| Test Class | What It Covers |
|---|---|
| `TestAdminApiConfig` | Config defaults, `frontend_ssm_prefix` derivation, `short_env` mapping |
| `TestSsmResolutionViaEnvOverride` | SSM env-var bypass pattern works locally |
| `TestSecretConfigMapSplit` | Cognito keys go to Secret, Dynamo keys go to ConfigMap |
| `TestIngressRouteHostname` | Correct hostname for dev vs production environment |
| `TestMissingCognitoRaisesError` | Missing Cognito param raises `SystemExit` |
| `TestDryRun` | `--dry-run` flag prints config and exits without touching K8s |

If a test fails, fix it before proceeding. Do not push to CI expecting the pipeline to catch it — that costs 10 minutes.

---

## Workflow B — Sync Script to S3 and Interactive Shell

**When to use:** After local unit tests pass. Use this to verify the script runs correctly on the actual EC2 node against real Kubernetes and real AWS secrets — before triggering the Step Functions pipeline.

### Step 1 — Sync your local deploy.py to S3

```bash
# Upload deploy.py only (fastest — for most iterations on the script logic)
just deploy-sync admin-api

# Upload the entire chart directory (when helpers or other files also changed)
just deploy-sync admin-api development full

# Same for other scripts
just deploy-sync public-api
just deploy-sync public-api development full
```

`deploy-sync` resolves the S3 bucket name from SSM (`/k8s/development/scripts-bucket`) — the same source as CI — then runs `aws s3 cp` (single file) or `aws s3 sync --delete` (full directory). After completion it prints the EC2 path and ready-to-paste shell commands:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅  Sync complete → s3://k8s-dev-scripts-xxxx/app-deploy/admin-api/deploy.py

  ── Interactive (recommended): open shell, then run ────────
    just ssm-shell development

  Inside the shell — paste each line individually:
    aws s3 cp s3://k8s-dev-scripts-xxxx/app-deploy/admin-api/deploy.py /data/app-deploy/admin-api/deploy.py --region eu-west-1

    KUBECONFIG=/etc/kubernetes/admin.conf SSM_PREFIX=/k8s/development /opt/k8s-venv/bin/python3 /data/app-deploy/admin-api/deploy.py --dry-run

    # Live run (applies K8s resources):
    KUBECONFIG=/etc/kubernetes/admin.conf SSM_PREFIX=/k8s/development /opt/k8s-venv/bin/python3 /data/app-deploy/admin-api/deploy.py
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

#### What deploy-sync updates — and what it does NOT

> **`deploy-sync` is scoped to one workload chart.** It does **not** update the SSM document bash logic, the Step Functions state machine, or the bootstrap scripts. Both of those have their own separate local-first workflows documented below.

| Layer | Updated by `deploy-sync`? | How to update / test it locally |
|---|---|---|
| `deploy.py` for the target workload | Yes (file mode) | `just deploy-sync <script>` |
| Helpers alongside `deploy.py` | Yes (full mode only) | `just deploy-sync <script> development full` |
| Bootstrap scripts (`control_plane.py`, `ebs_volume.py`, etc.) | No — own workflow | `just bootstrap-sync` + `just bootstrap-pull` + `just bootstrap-dry-run` |
| SSM document bash preamble / runner logic | No — CDK only | `just deploy-stack SsmAutomation-development kubernetes development` |
| Step Functions state machine DAG | No — CDK only | `just deploy-stack SsmAutomation-development kubernetes development` |

**`full` mode** syncs everything in `kubernetes-app/workloads/charts/<script>/` except `chart/`, `__pycache__/`, `*.pyc`, and `test_*`.

**`file` mode** (default) uploads only `deploy.py`. Use this for 95% of iterations.

---

#### Bootstrap scripts — local-first workflow

Bootstrap scripts (`kubernetes-app/k8s-bootstrap/`) are **executed by Step Functions** via SSM Run Command. They live on S3 at `k8s-bootstrap/` and are pulled onto the EC2 node at runtime — separate from the workload `app-deploy/` prefix.

They have their own complete local-first loop with **75 offline unit tests** and dedicated `just` recipes.

**Step 1 — Run offline unit tests (no AWS, no EC2 needed)**

```bash
# All boot/ tests — ebs_volume, kubeadm_init, join_cluster, verify_membership, etc.
just boot-test-local

# Specific file only
just boot-test-local test_ebs_volume.py

# Specific test by name
just boot-test-local -k "test_chown_and_chmod_applied_to_app_deploy"

# Full pytest suite (boot + system + deploy_helpers, 75 tests total)
just bootstrap-pytest
```

If tests pass, proceed to live testing on the EC2 node.

**Step 2 — Sync bootstrap scripts to S3**

```bash
just bootstrap-sync
# Equivalent to: aws s3 sync kubernetes-app/k8s-bootstrap/ s3://{bucket}/k8s-bootstrap/
# Excludes: __pycache__/, *.pyc, tests/, .venv/, pyproject.toml
```

**Step 3 — Pull the updated scripts onto the EC2 node**

```bash
INSTANCE_ID=$(aws ssm get-parameter \
  --name "/k8s/development/bootstrap/control-plane-instance-id" \
  --region eu-west-1 --profile dev-account \
  --query "Parameter.Value" --output text)

just bootstrap-pull $INSTANCE_ID
# Runs: aws s3 sync s3://{bucket}/k8s-bootstrap/ /data/k8s-bootstrap/ on the instance
```

**Step 4 — Dry-run on the live instance**

```bash
just bootstrap-dry-run $INSTANCE_ID
# Runs: python3 bootstrap_argocd.py --dry-run via SSM RunCommand
# Prints what it would do without modifying the cluster
```

**All-in-one (sync + pull + dry-run in one command)**

```bash
just bootstrap-test $INSTANCE_ID
```

**Live run — applies real changes**

```bash
just bootstrap-run $INSTANCE_ID
# Output saved to: kubernetes-app/k8s-bootstrap/logs/bootstrap-run-<timestamp>.log
```

> **Note:** `bootstrap-sync` overwrites the live S3 scripts for the environment immediately. Changes take effect the next time Step Functions triggers a bootstrap execution — not instantly on the running cluster. Only use in `development`.

---

### Execution Path Decision Guide

`just bootstrap-run` and SM-A look similar but are fundamentally different. Choosing the wrong one wastes time or leaves the cluster in a partial state.

#### Execution path comparison

```
just bootstrap-run $INSTANCE_ID
       │
       └─► AWS SSM send-command  (AWS-RunShellScript — built-in document)
                  │
                  └─► EC2 instance directly
                            │
                            └─► bash /data/k8s-bootstrap/system/argocd/bootstrap-argocd.sh
                                      │
                                      ├─► dnf install python3-pip  (if missing — AL2023 fix)
                                      ├─► pip3 install -r requirements.txt
                                      └─► python3 bootstrap_argocd.py
                                              (ArgoCD install + App-of-Apps ×10 steps)

SM-A (Bootstrap Orchestrator)  ← triggered by GHA Phase 4 or EventBridge ASG launch
       │
       └─► Step Functions state machine
                  │
                  ├─► InvokeRouter Lambda (reads ASG tags → role, ssmPrefix, s3Bucket)
                  ├─► BootstrapControlPlane → SSM RunCommand (custom runner doc)
                  │        └─► control_plane.py  (kubeadm init, Calico, CCM, ArgoCD, etcd backup)
                  └─► RejoinGeneralPool + RejoinMonitoringPool (parallel)
                           └─► worker.py  (kubeadm join, CloudWatch agent)
```

#### When to use which

| Scenario | Command | Why |
|---|---|---|
| **ArgoCD config drifted** (wrong password, bad IngressRoute) | `just bootstrap-run $INSTANCE_ID` | Runs only ArgoCD steps — fast, no cluster disruption |
| **ArgoCD pod restarted** — already healthy | `just bootstrap-run $INSTANCE_ID` | Idempotency guard skips re-install automatically |
| **Rotate ArgoCD secrets** (CI token, webhook key, admin password) | `just bootstrap-run $INSTANCE_ID` | Safer than SM-A — skips kubeadm completely |
| **Test bootstrap script changes** (dry-run first) | `just bootstrap-dry-run $INSTANCE_ID` | Always dry-run before a real run |
| **New EC2 instance** (ASG replacement) | SM-A via EventBridge (automatic) | Full cluster init — kubeadm must run before ArgoCD |
| **Worker nodes need to rejoin** | SM-A via `just trigger-bootstrap` | Worker rejoin requires SM-A router + Step Functions poll loop |
| **Full cluster rebuild** from scratch | SM-A (GHA Phase 4) | Only path that runs kubeadm init + Calico + CCM |
| **App secrets / ConfigMaps outdated** | `just config-run development` | Triggers SM-B (5 deploy.py scripts) — no bootstrap needed |

#### Key difference: what scripts run

| | `just bootstrap-run` | SM-A (Step Functions) |
|---|---|---|
| **Entry point** | `system/argocd/bootstrap-argocd.sh` → `bootstrap_argocd.py` | `boot/steps/control_plane.py` |
| **Scope** | ArgoCD bootstrap only (Steps 1–10 of `bootstrap_argocd.py`) | Full cluster: EBS mount, kubeadm init, Calico, CCM, S3 sync, **then** ArgoCD |
| **SSM document** | `AWS-RunShellScript` (AWS built-in) | `k8s-dev-bootstrap-runner` (CDK-deployed custom document) |
| **Poll loop** | `aws ssm wait` in your local shell | Step Functions custom poll loop (30s intervals, up to 60 retries) |
| **Worker nodes** | ❌ Does not touch worker nodes | ✅ Rejoins `general` + `monitoring` pools in parallel |
| **Trigger** | Manual (`just`) | EventBridge ASG launch event **or** GHA Phase 4 |
| **SM-B fires after?** | ❌ No — `bootstrap-run` does not emit an EventBridge event | ✅ SM-A SUCCEED → EventBridge → SM-B auto-fires |
| **Safe to re-run?** | ✅ Yes — idempotency guard skips healthy ArgoCD | ✅ Yes — marker files skip completed steps |

> **Bottom line:** Use `just bootstrap-run` for ArgoCD-only Day-2 operations on a cluster that is already bootstrapped. Use SM-A for anything that requires `kubeadm init`, worker rejoin, or a fresh machine.

### Step 2 — Open an interactive shell on the EC2 node

```bash
# Opens a bash session on the control-plane via SSM Session Manager
# No SSH key, no bastion — just AWS credentials
just ssm-shell
```

Under the hood this resolves the control-plane instance ID from SSM (`/k8s/development/bootstrap/control-plane-instance-id`) and calls `aws ssm start-session`.

### Step 3 — Pull the updated script and run it

The SSM deploy-runner document syncs from S3 at execution time. When using `ssm-shell` you are in a raw bash session, not the SSM document, so you must pull the file manually to get the updated version. This gives explicit control over which version is active on the node.

> **Important:** Use `/opt/k8s-venv/bin/python3`, not bare `python3`. The SSM document prepends `/opt/k8s-venv/bin` to `$PATH` before executing scripts, so `boto3` is installed there — not in the system Python. In a raw `ssm-shell`, bare `python3` resolves to the system interpreter which has no `boto3`.

```bash
# Pull the script you just synced
aws s3 cp s3://<bucket>/app-deploy/admin-api/deploy.py /data/app-deploy/admin-api/deploy.py --region eu-west-1

# Dry run — prints the config it would apply, no K8s changes
KUBECONFIG=/etc/kubernetes/admin.conf SSM_PREFIX=/k8s/development /opt/k8s-venv/bin/python3 /data/app-deploy/admin-api/deploy.py --dry-run

# Live run — applies Secrets and ConfigMaps to the cluster
KUBECONFIG=/etc/kubernetes/admin.conf SSM_PREFIX=/k8s/development /opt/k8s-venv/bin/python3 /data/app-deploy/admin-api/deploy.py
```

Alternatively, activate the venv for the whole shell session to use bare `python3`:

```bash
source /opt/k8s-venv/bin/activate
# Now plain python3 resolves boto3
KUBECONFIG=/etc/kubernetes/admin.conf SSM_PREFIX=/k8s/development python3 /data/app-deploy/admin-api/deploy.py --dry-run
```

The `--dry-run` flag is safe to call at any time. It resolves all config, prints what it would create, then exits without modifying any Kubernetes resources.

---

## Workflow C — One-shot SSM Trigger and CloudWatch Tail

**When to use:** When you want to run the script through the real SSM document — not raw Python — and watch live CloudWatch output, without opening an interactive shell.

```bash
# Sync to S3, then trigger via the deploy-runner document and tail CloudWatch
just deploy-sync admin-api && just deploy-script admin-api

# Just trigger (if already synced)
just deploy-script admin-api

# Other scripts
just deploy-script public-api
just deploy-script nextjs development
```

### What deploy-script does

1. Resolves the control-plane instance ID from SSM
2. Calls `aws ssm send-command` using the `k8s-dev-deploy-runner` document
3. Polls for completion every 10 s (max 5 min)
4. Tails `/ssm/k8s/development/deploy` in CloudWatch while waiting
5. Prints final status (`Success` / `Failed`) and the last 50 log lines

This is the closest local equivalent to what Step Functions does when it calls the deploy steps.

---

## Workflow D — Full SM-A (Bootstrap) Execution

**When to use:** Only after Workflows A, B, and C pass for bootstrap script changes. This is the full end-to-end gate for Tier 1 (cluster infrastructure) changes.

```bash
# Discover the control-plane instance ID and ASG name
INSTANCE_ID=$(aws ssm get-parameter \
  --name "/k8s/development/bootstrap/control-plane-instance-id" \
  --region eu-west-1 --profile dev-account \
  --query "Parameter.Value" --output text)

ASG_NAME=$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --region eu-west-1 --profile dev-account \
  --query "Reservations[0].Instances[0].Tags[?Key=='aws:autoscaling:groupName'].Value" \
  --output text)

SM_A_ARN=$(aws ssm get-parameter \
  --name "/k8s/development/bootstrap/state-machine-arn" \
  --region eu-west-1 --profile dev-account \
  --query "Parameter.Value" --output text)

# Trigger a full SM-A run (control-plane bootstrap + worker re-join)
aws stepfunctions start-execution \
  --state-machine-arn "$SM_A_ARN" \
  --name "manual-test-$(date +%s)" \
  --region eu-west-1 --profile dev-account \
  --input "{
    \"detail\": {
      \"EC2InstanceId\": \"$INSTANCE_ID\",
      \"AutoScalingGroupName\": \"$ASG_NAME\"
    }
  }"
```

> **EventBridge self-healing:** When SM-A SUCCEEDS, EventBridge automatically fires SM-B. You do not need to manually trigger SM-B after a successful SM-A run unless you want to force an out-of-cycle secret re-injection.

### Tail SM-A log in real-time

```bash
aws logs tail "/aws/vendedlogs/states/k8s-dev-bootstrap-orchestrator" \
  --region eu-west-1 --profile dev-account \
  --follow --format short
```

### Extract a failed CommandId from SM-A execution history

```bash
EXEC="<paste-execution-arn-here>"

aws stepfunctions get-execution-history \
  --execution-arn "$EXEC" \
  --region eu-west-1 --profile dev-account \
  --output json | python3 -c "
import json, sys
data = json.load(sys.stdin)
for e in data['events']:
    t = e.get('type', '')
    if 'TaskSucceeded' in t or 'TaskFailed' in t:
        out = e.get('taskSucceededEventDetails', {}) or e.get('taskFailedEventDetails', {})
        output = out.get('output', '{}')
        try:
            parsed = json.loads(output)
            cmd = parsed.get('CommandId') or parsed.get('Command', {}).get('CommandId')
            if cmd:
                print(f'{t}: CommandId = {cmd}')
        except Exception:
            pass
"
```

---

## Workflow E — SM-B (Config Orchestrator) Manual Trigger

> [!WARNING]
> SM-B is being decommissioned. See the note in the [SM-B section](#sm-b----config-orchestrator-config-orchestratorts) above.

**When to use:** After Workflow B or C confirms a `deploy.py` change works on the live node — or when rotating secrets without re-bootstrapping the cluster. This is the integration gate for all Tier 2 (app config) changes.

### Via just recipe (recommended)

```bash
# Trigger SM-B — runs all 5 deploy.py scripts sequentially on the control plane
just config-run development

# Check the latest SM-B execution status (ARN + SUCCEEDED/FAILED)
just config-status
```

`config-run` resolves the Config SM ARN from SSM (`/k8s/development/bootstrap/config-state-machine-arn`), starts the execution, and polls every 15 s until terminal state (max 60 min).

### Via raw AWS CLI

```bash
SM_B_ARN=$(aws ssm get-parameter \
  --name "/k8s/development/bootstrap/config-state-machine-arn" \
  --region eu-west-1 --profile dev-account \
  --query "Parameter.Value" --output text)

aws stepfunctions start-execution \
  --state-machine-arn "$SM_B_ARN" \
  --name "manual-config-$(date +%s)" \
  --region eu-west-1 --profile dev-account \
  --input '{"trigger":"manual","source":"cli"}'
```

### Tail SM-B log in real-time

```bash
aws logs tail "/aws/vendedlogs/states/k8s-dev-config-orchestrator" \
  --region eu-west-1 --profile dev-account \
  --follow --format short

# Deploy script stdout (all 5 scripts stream here)
aws logs tail "/ssm/k8s/development/deploy" \
  --region eu-west-1 --profile dev-account \
  --follow --format short
```

### Extract a failed CommandId from SM-B execution history

```bash
SM_B_EXEC="<paste-sm-b-execution-arn-here>"

aws stepfunctions get-execution-history \
  --execution-arn "$SM_B_EXEC" \
  --region eu-west-1 --profile dev-account \
  --output json | python3 -c "
import json, sys
data = json.load(sys.stdin)
for e in data['events']:
    t = e.get('type', '')
    if 'TaskSucceeded' in t or 'TaskFailed' in t:
        out = e.get('taskSucceededEventDetails', {}) or e.get('taskFailedEventDetails', {})
        output = out.get('output', '{}')
        try:
            parsed = json.loads(output)
            cmd = parsed.get('CommandId') or parsed.get('Command', {}).get('CommandId')
            if cmd:
                print(f'{t}: CommandId = {cmd}')
        except Exception:
            pass
"
```

---

## Deploying CDK Stacks

### Available stacks

Run `just list kubernetes development` to see the current list:

```
Data-development
Base-development
GoldenAmi-development
SsmAutomation-development      ← SSM Documents + Step Functions + IAM
ControlPlane-development       ← EC2 control-plane + ASG
GeneralPool-development        ← Worker pool ASG
MonitoringPool-development     ← Monitoring worker pool
AppIam-development             ← IAM roles for pod workloads
Api-development                ← API Gateway + Lambda
Edge-development               ← CloudFront + WAF
Observability-development      ← Grafana + Loki stack
```

### Deploy only the SSM stack

This is the most common targeted deploy. Use it when you have changed:

- `infra/lib/constructs/ssm/ssm-run-command-document.ts` — bash preamble
- `infra/lib/stacks/kubernetes/ssm-automation-stack.ts` — runner step scripts
- Any Step Functions state machine definition

```bash
just deploy-stack SsmAutomation-development kubernetes development
```

The `--exclusively` flag tells CDK to deploy this single stack only, without attempting to deploy dependent stacks. This typically takes 2–3 minutes.

### When to deploy other stacks

| Changed file | Stack to deploy |
|---|---|
| `ssm-run-command-document.ts`, `ssm-automation-stack.ts` | `SsmAutomation-development` |
| `control-plane-stack.ts`, worker IAM | `ControlPlane-development` |
| `worker-asg-stack.ts` (general pool) | `GeneralPool-development` |
| `app-iam-stack.ts` (IRSA roles) | `AppIam-development` |
| CloudFront, WAF | `Edge-development` |
| Loki, Grafana | `Observability-development` |

### Diff before deploying

Always run `diff` first to confirm exactly what CloudFormation will change:

```bash
just diff kubernetes development
```

For a single stack:

```bash
cd infra && npx cdk diff SsmAutomation-development \
  -c project=kubernetes -c environment=development \
  --profile dev-account
```

### Synth only

Validate the CloudFormation template without deploying:

```bash
cd infra && npx cdk synth SsmAutomation-development \
  -c project=kubernetes -c environment=development \
  --profile dev-account
```

---

## After Tests Pass — Promotion Checklist

Once Workflow B or C confirms the script works on the live node, verify all three gates before committing:

```
✅ Local unit tests pass     →  just deploy-test <script>
✅ Dry-run config is correct →  ssm-shell + python3 deploy.py --dry-run
✅ SSM run succeeds          →  just deploy-script <script>
```

### Commit and push

Commit the updated `deploy.py` with a conventional commit message:

```bash
git add kubernetes-app/workloads/charts/admin-api/deploy.py
git commit -m "fix(k8s): correct MANIFESTS_DIR path in admin-api deploy script"
```

If the SSM construct also changed, commit infrastructure separately:

```bash
git add infra/lib/constructs/ssm/
git add infra/lib/stacks/kubernetes/ssm-automation-stack.ts
git commit -m "fix(infra): remove -u flag from SSM bash preamble"
```

### What CI does on push to develop

1. Runs `cdk diff` and posts a summary to the PR
2. Deploys the changed stack (e.g. `SsmAutomation-development`)
3. Runs `sync-bootstrap-scripts.ts` to push scripts to S3

Since you validated locally, this should be a green run. Never push an untested `deploy.py` change — the pipeline has no Python test gate, you are the gate.

---

## Debugging Reference

### Step-Level Observability & Troubleshooting

To radically reduce the time spent jumping between Step Functions and CloudWatch logs, the orchestrator now includes multi-layered, step-level observability. If an orchestration step fails, use these tools to troubleshoot:

1. **Step Functions Console (Rich Errors):** 
   If a step fails or times out, open the Step Functions execution in the AWS Console. The terminal `Fail` state will contain an enriched `Cause` JSON strictly formatted with:
   - The exact command failure message and exit code.
   - A direct, one-click URL to the specific CloudWatch Log Stream for that exact run.
   - The tail (up to 4000 chars) of `stdout` and `stderr` so you often don't even need to open CloudWatch.
   - The precise SSM SSM query command to fetch the raw JSON invocation.

2. **Grafana Dashboard (Visual Timelines):** 
   Open your Grafana instance and navigate to the **Auto-Bootstrap** dashboard. The "Step-Level Observability" row provides:
   - State timeline traces showing exactly when each bootstrap and ArgoCD step started, succeeded, or failed.
   - Duration charts to spot performance regressions in specific scripts.
   - Cross-referenced CloudWatch Logs Insights queries for errors.

3. **SSM Parameter Store (Live Status Markers):** 
   The orchestrator writes real-time JSON status markers for every step. You can query these directly from the AWS CLI to see the exact state of a node without touching CloudWatch:
   ```bash
   # Check control plane boot steps
   aws ssm get-parameters-by-path --path "/k8s/development/bootstrap/status/boot" --region eu-west-1 --profile dev-account
   
   # Check ArgoCD bootstrap steps
   aws ssm get-parameters-by-path --path "/k8s/development/bootstrap/status/argocd" --region eu-west-1 --profile dev-account
   ```

### Tail the deploy SSM log group live

```bash
aws logs tail "/ssm/k8s/development/deploy" \
  --region eu-west-1 --profile dev-account \
  --follow --format short
```

### View a specific SSM command invocation

```bash
COMMAND_ID="<from-step-functions-history-or-deploy-script-output>"
INSTANCE_ID=$(aws ssm get-parameter \
  --name "/k8s/development/bootstrap/control-plane-instance-id" \
  --region eu-west-1 --profile dev-account \
  --query "Parameter.Value" --output text)

aws ssm get-command-invocation \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --region eu-west-1 --profile dev-account \
  --query "{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}" \
  --output json
```

### List the 5 most recent SSM log streams

```bash
aws logs describe-log-streams \
  --log-group-name "/ssm/k8s/development/deploy" \
  --region eu-west-1 --profile dev-account \
  --order-by LastEventTime --descending \
  --query "logStreams[:5].logStreamName" --output table
```

### Run all 5 deploy scripts — via SM-B (canonical)

**The canonical way** to run all five deploy scripts sequentially is via SM-B. Use `just config-run` for the wrapped version, or the raw CLI below:

```bash
# Recommended — triggers SM-B, polls until completion
just config-run development
```

SM-B runs the scripts in this fixed order with full retry/poll logic, CloudWatch streaming, and structured failure output:
1. `nextjs/deploy.py`
2. `monitoring/deploy.py`
3. `start-admin/deploy.py`
4. `admin-api/deploy.py`
5. `public-api/deploy.py`

### Run all 5 deploy scripts — via raw SSM (low-level diagnostic)

Use only when SM-B itself is unavailable or you need to test individual scripts in isolation:

```bash
INSTANCE_ID=$(aws ssm get-parameter \
  --name "/k8s/development/bootstrap/control-plane-instance-id" \
  --region eu-west-1 --profile dev-account \
  --query "Parameter.Value" --output text)

S3_BUCKET=$(aws ssm get-parameter \
  --name "/k8s/development/scripts-bucket" \
  --region eu-west-1 --profile dev-account \
  --query "Parameter.Value" --output text)

for SCRIPT in nextjs monitoring start-admin admin-api public-api; do
  echo "=== Deploying $SCRIPT ==="
  CMD_ID=$(aws ssm send-command \
    --instance-ids "$INSTANCE_ID" \
    --document-name "k8s-dev-deploy-runner" \
    --parameters "{
      \"ScriptPath\": [\"app-deploy/${SCRIPT}/deploy.py\"],
      \"SsmPrefix\": [\"/k8s/development\"],
      \"S3Bucket\": [\"$S3_BUCKET\"],
      \"Region\": [\"eu-west-1\"]
    }" \
    --region eu-west-1 --profile dev-account \
    --cloud-watch-output-config '{
      "CloudWatchLogGroupName": "/ssm/k8s/development/deploy",
      "CloudWatchOutputEnabled": true
    }' \
    --query "Command.CommandId" --output text)

  echo "  CommandId: $CMD_ID — waiting..."
  aws ssm wait command-executed \
    --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
    --region eu-west-1 --profile dev-account 2>/dev/null || true

  STATUS=$(aws ssm get-command-invocation \
    --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
    --region eu-west-1 --profile dev-account \
    --query "Status" --output text)
  echo "  → $STATUS"
  [[ "$STATUS" != "Success" ]] && break
done
```

### Validate the SSM bash preamble locally

```bash
just ssm-preamble-test
```

This runs the exact preamble that every SSM command executes:

```bash
set -exo pipefail
export HOME="${HOME:-/root}"
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
```

If this passes locally, it will pass inside SSM. The `-u` (`nounset`) flag has been intentionally removed from the preamble to prevent failures in non-login SSM shells where variables like `$HOME` may not be set.

---

## Linux File Permissions — chmod, chown, and the EBS Volume

This section documents the root-cause analysis and permanent fix for the `Permission denied` error encountered when trying to sync a script into `/data/app-deploy/` from an interactive `ssm-shell` session. Understanding it requires a working knowledge of the Linux permission model.

---

### The Linux Permission Model

Every file and directory on a Linux system has three permission classes and three permission bits:

```
 Permission string: -rwxr-xr--
                    │└─┬─┘└─┬─┘└─┬─┘
                    │  │     │    └── Other  (everyone else)
                    │  │     └─────── Group  (owning group)
                    │  └──────────── Owner  (owning user)
                    └─────────────── File type (- file, d directory)
```

**The three letters per class — r, w, x:**

| Bit | File meaning | Directory meaning |
|-----|--------------|-------------------|
| `r` | Read the file contents | List directory contents (`ls`) |
| `w` | Write / modify file contents | Create, delete, or rename files inside the directory |
| `x` | Execute the file as a programme | Enter the directory (`cd`) |

A dash `-` means the permission is **absent**. So `rwxr-xr--` means:
- Owner: read + write + execute
- Group: read + execute (not write)
- Other: read only

---

### Octal Notation

Each permission class is also representable as a 3-bit number (0–7):

| Octal | Binary | Permissions |
|-------|--------|-------------|
| `0`   | `000`  | `---` (none) |
| `1`   | `001`  | `--x` |
| `2`   | `010`  | `-w-` |
| `3`   | `011`  | `-wx` |
| `4`   | `100`  | `r--` |
| `5`   | `101`  | `r-x` |
| `6`   | `110`  | `rw-` |
| `7`   | `111`  | `rwx` |

So `chmod 755 file` sets `rwxr-xr-x`, and `chmod 644 file` sets `rw-r--r--`.

Common patterns used in this project:

```bash
chmod 600 /home/ssm-user/.kube/config   # rw-------  owner-only read/write (kubeconfig)
chmod 755 /usr/local/bin/kubectl        # rwxr-xr-x  executable by everyone
chmod 644 /etc/kubernetes/pki/ca.crt   # rw-r--r--  public cert, read by all
chmod g+w /data/app-deploy             # add group write without changing other bits
```

---

### The `chmod` Command

`chmod` (**ch**ange file **mod**e bits) alters the permission bits of a file or directory.

```bash
# Symbolic form — easier to read, additive or subtractive
chmod u+x script.py          # add execute for owner
chmod g+w /data/app-deploy   # add group write
chmod o-r secret.txt         # remove read from others
chmod a=r config.txt         # set all classes to read-only

# Octal form — sets all bits exactly
chmod 755 /usr/local/bin/kubectl
chmod 600 ~/.kube/config
chmod 660 /data/app-deploy/admin-api/deploy.py

# Recursive — apply to all files and subdirectories
chmod -R g+w /data/app-deploy
```

Symbolic target letters: `u` (user/owner), `g` (group), `o` (other), `a` (all three).

---

### The `chown` Command

`chown` (**ch**ange **own**ership) sets which user and/or group owns a file.

```bash
# Change owner only
chown root /data/app-deploy

# Change owner and group together (user:group)
chown root:ssm-user /data/app-deploy

# Change group only
chown :ssm-user /data/app-deploy

# Recursive — apply to all files and subdirectories
chown -R root:ssm-user /data/app-deploy
```

Group membership matters because: if a file is owned by `root:ssm-user` and has `g+w`, then any user in the `ssm-user` group can write it — even though they are not the file owner.

---

### Inspecting Permissions

```bash
# Long listing — shows permissions, owner, group
ls -la /data/app-deploy/

# Example output:
# drwxrwxr-x  3 root  ssm-user 4096 Apr 12 06:00 app-deploy
# drwxrwxr-x  2 root  ssm-user 4096 Apr 12 06:00 admin-api
# -rw-rw-r--  1 root  ssm-user 8192 Apr 12 06:00 deploy.py

# Check which groups the current user belongs to
id
# uid=1001(ssm-user) gid=1001(ssm-user) groups=1001(ssm-user)

# Show numeric octal permissions
stat -c "%a %n" /data/app-deploy/*
```

---

### Why This Was Needed — Root Cause

#### The problem

The bootstrap step (`ebs_volume.py`) runs inside the **SSM Run Command document**, which executes as **root**. When the EBS data volume is formatted and mounted, `ensure_data_directories` creates the subdirectory structure:

```
/data/
  kubernetes/   ← owned by root:root, mode 755
  k8s-bootstrap/ ← owned by root:root, mode 755
  app-deploy/   ← owned by root:root, mode 755  ← PROBLEM
```

All directories are owned by `root:root` with mode `755` (no group write).

When a developer runs `just ssm-shell`, AWS SSM Session Manager opens a shell as **`ssm-user`** — a restricted account created by the SSM agent. `ssm-user` is not root, and is not in the `root` group, so the permission check for `/data/app-deploy/` looks like this:

```
Directory:  drwxr-xr-x  root  root  /data/app-deploy/admin-api/
ssm-user's access:
  Is ssm-user the owner?              → No  (owner is root)
  Is ssm-user in the 'root' group?    → No
  Other bits: r-x                     → Read and enter, but NOT write
  Result: EACCES (Permission denied) when trying to create/write a file.
```

This produced the exact error seen:

```
[Errno 13] Permission denied: '/data/app-deploy/admin-api/deploy.py.202Ae3ac'
```

The `.202Ae3ac` suffix is the temporary file that `aws s3 cp` creates before atomically renaming it — so even a simple `s3 cp` requires write permission on the directory.

#### Why `sudo` prompted for a password

On standard Amazon Linux 2023 instances, the SSM agent adds `ssm-user` to `/etc/sudoers.d/ssm-agent-users` with `NOPASSWD: ALL`. However, this behaviour is not guaranteed across all AMI versions, and custom Golden AMIs may not include these sudoers rules if the AMI was baked without an active SSM agent. In this cluster's Golden AMI, `ssm-user` had no passwordless sudo entry, so `sudo aws s3 cp ...` prompted for a password that nobody knows.

---

### The Two-Layer Fix

#### Layer 1 — `ebs_volume.py`: grant group-write at directory creation time

In `boot/steps/cp/ebs_volume.py`, after creating the directory structure, `ensure_data_directories` now runs:

```python
run_cmd(["chown", "-R", "root:ssm-user", str(app_deploy)], check=False)
run_cmd(["chmod", "-R", "g+w",           str(app_deploy)], check=False)
```

This changes the ownership and permissions of the entire `/data/app-deploy/` subtree:

```
Before:  drwxr-xr-x  root  root    /data/app-deploy/
After:   drwxrwxr-x  root  ssm-user  /data/app-deploy/
```

Breaking down `drwxrwxr-x`:
- `d`   — directory
- `rwx` — root (owner): read + write + enter
- `rw-` — wait, it's actually `rwx` for group too because `g+w` adds write to the existing `r-x`
- Actually: `rwx` (owner) + `rwx` (group, from `r-x` + `g+w` = `rwx`) + `r-x` (other)
- Result: `drwxrwxr-x` (numeric `775`)

With `ssm-user` as the group owner, any member of the `ssm-user` group — including the interactive SSM session — can now create, write, and rename files in `/data/app-deploy/` without sudo.

The `check=False` parameter makes the chown **non-fatal**: if `ssm-user` does not exist yet at EBS mount time (a race condition on very first boot before the SSM agent has created the user), the bootstrap step logs a warning and continues. The S3 sync during deployment creates files as root, so this is not a blocking issue.

#### Layer 2 — `ssm-shell`: open a root session via `AWS-StartInteractiveCommand`

The `justfile` `ssm-shell` recipe was updated to pass `--document-name AWS-StartInteractiveCommand` with `"command": ["sudo su -"]`:

```bash
aws ssm start-session \
  --target "${INSTANCE_ID}" \
  --document-name AWS-StartInteractiveCommand \
  --parameters '{"command":["sudo su -"]}' \
  --region eu-west-1 --profile dev-account
```

`AWS-StartInteractiveCommand` is a managed SSM document that runs a single command and gives you an interactive terminal around it. `sudo su -` (or equivalently `sudo -i`) spawns a login shell as root, bypassing the ssm-user sudoers lookup entirely — because the SSM agent itself has permission to escalate.

You now land directly in a root bash session:

```bash
$ just ssm-shell
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SSM Root Shell → i-06afb27d869985957  (development)
  Python: /opt/k8s-venv/bin/python3
  Scripts: /data/app-deploy/<service>/deploy.py
  Ctrl-D to exit
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[root@ip-10-0-1-42 ~]#
```

From this root shell, `aws s3 cp` to `/data/app-deploy/` works with neither sudo nor password.

#### Why both layers?

| Scenario | Layer 1 alone | Layer 2 alone | Both |
|---|---|---|---|
| `ssm-shell` + `s3 cp` | ✅ Works (group write) | ✅ Works (root) | ✅ |
| Old AMI without NOPASSWD sudo | ✅ Works (group write) | ✅ Works (SSM escalation) | ✅ |
| SSM agent version too old for `AWS-StartInteractiveCommand` | ✅ Still works | ❌ Fails | ✅ |
| First boot before ssm-user created | ⚠️ chown non-fatal, falls back | ✅ Works (root) | ✅ |

Layer 1 is the **permanent structural fix**. Layer 2 is the **developer ergonomics fix**. Together they are resilient to both failure modes.

---

### The EBS Volume and Permission Persistence

Unlike the root filesystem (which is ephemeral on EC2 ASG instances), the EBS data volume at `/data/` **persists across instance replacements**. This means:

1. `ebs_volume.py` only formats the volume on **first boot** (when `blkid` returns no filesystem). On subsequent boots it just mounts the existing ext4 filesystem.
2. `ensure_data_directories` is always called, but `mkdir(exist_ok=True)` is a no-op for existing directories.
3. The `chown`/`chmod` commands **are called on every boot**, which means the permissions are self-healing: even if a previous pipeline run created a file as root with `644`, the next bootstrap re-applies `g+w` to the entire subtree.

This is why `check=False` is used for the chown/chmod calls — if they fail silently on one boot (e.g., ssm-user race condition), the next successful run will correct it.

```bash
# Verify permissions on the live node from ssm-shell
ls -la /data/app-deploy/
ls -la /data/app-deploy/admin-api/

# Manual one-time fix on existing cluster (no bootstrap cycle needed)
chown -R root:ssm-user /data/app-deploy && chmod -R g+w /data/app-deploy
```

---


### Shift-left validation

Modern DevOps centres on pushing validation as early as possible in the development loop. The further left a defect is caught, the cheaper it is to fix:

```
Local test (< 5 s) < SSM dry-run (< 30 s) < CI pipeline (10+ min) < Production
   cheapest                                                          most expensive
```

This pipeline implements all four gates in order, blocking promotion at each one.

### Immutable infrastructure, mutable scripts

CDK-managed resources (SSM Documents, Step Functions, IAM) are immutable — they are replaced, not patched. The Python scripts they execute are mutable — they live on S3 and can be updated without re-deploying infrastructure.

`deploy-sync` exploits this boundary: a new `deploy.py` can be pushed to S3 in 10 seconds and tested immediately, without touching CloudFormation. The SSM document only needs redeploying when the document schema, bash preamble, or Step Functions DAG changes.

### SSM Session Manager over SSH

- **No SSH keys to manage or rotate** — access is controlled entirely by IAM
- **No port 22 open** — no security group inbound rules, no VPN, no key pair provisioning
- **Every session is audited** — logged to CloudWatch by default
- **Works from any developer machine** with valid AWS credentials and `session-manager-plugin`

This follows the [AWS Well-Architected Framework Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/infrastructure-protection.html) recommendation for EC2 instance access.

### Local Python unit tests over integration tests

The `deploy.py` scripts make boto3 SSM API calls, `kubectl apply` subprocess calls, and complex conditional logic. End-to-end testing requires a running Kubernetes cluster, live AWS credentials, correct SSM parameter values, and a working EC2 instance — none of which are available in a local development environment or CI without AWS credentials.

By patching `_load_boto3` and using the env-var override pattern in `deploy_helpers/ssm.py`, 100% of the business logic is testable locally with zero external dependencies. Tests run in CI on every PR without AWS credentials, run on any developer machine without cluster access, and surface defects in seconds rather than after a 10-minute pipeline run.

### The just task runner as the developer interface

All workflows are exposed through [just](https://github.com/casey/just) recipes that encode environment-specific defaults, abstract long AWS CLI invocations, print human-readable instructions after every step, and are self-documenting via `just --list`. This follows the [12-Factor App](https://12factor.net/) principle of dev/prod parity: local tooling uses the exact same bucket, SSM prefix, and IAM identity as the CI pipeline.

---

*Last updated: 2026-04-12 — reflects two-state-machine decoupled architecture (SM-A Bootstrap Orchestrator + SM-B Config Orchestrator), EventBridge self-healing bridge (SM-A SUCCEED → auto-fires SM-B), `trigger-config.ts` manual SM-B trigger script, `just config-run` / `just config-status` local recipes, new SM-B CloudWatch log group (`/aws/vendedlogs/states/k8s-dev-config-orchestrator`), `ssm-run-command-document.ts` preamble hardening (`-u` removal), `deploy-sync` / `ssm-shell` / `deploy-script` / `deploy-test` local tooling, `test_deploy_local.py` offline test suite (13 tests), `ssm-shell` root-session upgrade (`AWS-StartInteractiveCommand`), `ebs_volume.py` group-write fix for `ssm-user`, and Linux permissions reference.*
