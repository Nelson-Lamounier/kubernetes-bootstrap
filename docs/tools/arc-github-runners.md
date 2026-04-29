---
title: ARC GitHub Actions Self-Hosted Runners
type: tool
tags: [arc, github-actions, kubernetes, self-hosted-runners, argocd]
sources:
  - argocd-apps/arc-controller.yaml
  - argocd-apps/arc-runners.yaml
created: 2026-04-28
updated: 2026-04-28
---

# GitHub Actions ARC Self-Hosted Runners — Setup Guide

## Why This Was Built

### The Problem

The `deploy-admin-api` and `deploy-public-api` jobs in `.github/workflows/deploy-api.yml`
previously ran on `ubuntu-latest` (GitHub-hosted runners) and communicated with the cluster
through a fragile 3-hop chain:

```
GitHub Actions (ubuntu-latest)
  → S3 sync (latest deploy.py scripts uploaded)
  → SSM SendCommand (shell script on EC2 control-plane node)
    → kubectl apply / python3 deploy.py
      → Kubernetes API
```

**Problems with that approach:**

| Problem | Impact |
|---------|--------|
| SSM polling loop (15× `sleep 5`) | Added ~75 seconds per deploy for status checks |
| S3 sync required before every run | Scripts could diverge from repo if sync was skipped |
| EC2 instance discovery fragile | `describe-instances` fails if CP is replaced or stopped |
| SSM agent health dependency | Deploy fails if `ssm-agent` is unhealthy on the CP node |
| 60-line shell block for ArgoCD sync | Hard to maintain, no error context |
| `ubuntu-latest` has no `KUBECONFIG` | Needed SSM tunnel or full kubeconfig fetch + sed rewrite |

### The Solution: ARC Self-Hosted Runners

**Actions Runner Controller (ARC)** deploys ephemeral runner pods _inside_ the cluster.
When a job runs with `runs-on: [self-hosted, k8s]`, GitHub dispatches it to a runner pod
that already has in-cluster network access — no SSM hop, no S3 sync, no EC2 dependency.

```
GitHub Actions ([self-hosted, k8s])
  → ARC runner pod (inside cluster, arc-runners namespace)
    → kubernetes.default.svc:443 (in-cluster API server)
      → kubectl apply / python3 deploy.py
```

**Benefits:**

- Direct cluster access — runner pod IS inside the cluster
- No SSM polling — deploy completes in seconds, not minutes
- No S3 sync — scripts are checked out fresh from the repo each run
- No EC2 dependency — works regardless of control-plane node state
- ArgoCD sync via `kubectl annotate` — 1 line, immediate, no polling

---

## System Design

### Component Overview

```
┌─────────────────────────────────────────────────────────────┐
│  GitHub                                                      │
│  ┌──────────────┐    workflow_job events (POST /webhook)    │
│  │  Workflow    │ ──────────────────────────────────────► ──┼─┐
│  │  (k8s runner)│ ◄── runner registers / polls jobs ◄─── ──┼─┘
│  └──────────────┘                                           │
└─────────────────────────────────────────────────────────────┘
         │                          │
         │ OIDC token               │ HTTPS → runners.nelsonlamounier.com
         ▼                          ▼
┌─────────────────────────────────────────────────────────────┐
│  AWS (Development Account — eu-west-1)                      │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Kubernetes Cluster                                   │  │
│  │                                                       │  │
│  │  arc-systems/                                        │  │
│  │    arc-controller-* (Deployment)                     │  │
│  │      - Manages runner pod lifecycle                  │  │
│  │      - Webhook server on port 9000                   │  │
│  │                                                       │  │
│  │  arc-runners/                                        │  │
│  │    AutoscalingRunnerSet "k8s" (0-3 pods)            │  │
│  │    arc-github-secret (GitHub App credentials)        │  │
│  │    arc-runner ServiceAccount (RBAC for deploy.py)   │  │
│  │                                                       │  │
│  │  Traefik (arc-webhook-ingressroute)                  │  │
│  │    runners.nelsonlamounier.com/webhook → port 9000   │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  Route53 (Root Account — via cross-account role)           │
│    runners.nelsonlamounier.com → EIP (A record)            │
└─────────────────────────────────────────────────────────────┘
```

### Runner Lifecycle (Webhook Mode)

```
1. Workflow dispatched (push to develop / workflow_dispatch)
2. GitHub checks for available runners matching [self-hosted, k8s]
3. GitHub sends POST /webhook to runners.nelsonlamounier.com/webhook
4. ARC controller receives event → creates runner pod immediately
5. Runner pod starts, registers with GitHub, picks up the job
6. Job executes inside the pod (in-cluster kubectl, AWS CLI, Python)
7. Job completes → runner pod deleted
```

Without webhook mode (long-poll only), step 4 takes up to 60 seconds.
With webhook mode, it takes under 5 seconds.

### Authentication: GitHub App vs PAT

ARC uses a **GitHub App** (not a PAT) for runner registration:

| | PAT | GitHub App |
|--|-----|------------|
| Expiry | 30/60/90 days | Never (key rotation only) |
| Scope | User-level | App-level (org permissions) |
| Audit trail | Hard to attribute | Per-app activity log |
| Rotation | Manual | Key re-generation |

The GitHub App credentials are stored as a K8s secret (`arc-github-secret`) in the
`arc-runners` namespace — never in GitHub secrets or environment variables.

---

## ArgoCD Application Deployment

### Apply Manifests

```bash
# Apply both ArgoCD Application manifests
kubectl apply -f kubernetes-app/platform/argocd-apps/arc-controller.yaml
kubectl apply -f kubernetes-app/platform/argocd-apps/arc-runners.yaml
```

### Trigger Sync

```bash
# Sync controller first (manages runners)
kubectl patch application arc-controller -n argocd \
  --type merge -p '{"operation": {"sync": {"syncStrategy": {"hook": {"force": true}}}}}'

# Wait for controller pod
kubectl get pods -n arc-systems -w

# Then sync runners
kubectl patch application arc-runners -n argocd \
  --type merge -p '{"operation": {"sync": {"syncStrategy": {"hook": {"force": true}}}}}'
```

---

## Integration with `_deploy-ssm-automation.yml`

The SSM automation pipeline (`_deploy-ssm-automation.yml`) is the **full cluster bootstrap
pipeline** — it handles kubeadm init, worker join, and SM-B config injection. ARC integrates
at two points:

### Point 1: CRD Bootstrap (add to `sync-and-verify` job)

The `autoscalingrunnersets` CRD must be applied with server-side apply. Add a step after
Phase 2 sync that applies the ARC CRDs when the chart version changes:

```yaml
- name: "Phase 2b — Bootstrap ARC CRDs (if needed)"
  run: |
    CHART_VERSION="0.10.1"
    SSM_KEY="/k8s/${{ inputs.cdk-environment }}/arc-crds-version"

    CURRENT=$(aws ssm get-parameter --name "$SSM_KEY" \
      --query 'Parameter.Value' --output text 2>/dev/null || echo "")

    if [ "$CURRENT" = "$CHART_VERSION" ]; then
      echo "[SKIP] ARC CRDs already at $CHART_VERSION"
      exit 0
    fi

    echo "[INFO] Bootstrapping ARC CRDs at $CHART_VERSION"
    helm registry login ghcr.io \
      --username "${{ vars.GITHUB_USERNAME }}" \
      --password "${{ secrets.GHCR_PAT }}"

    helm pull \
      oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller \
      --version "$CHART_VERSION" --untar --destination /tmp/arc-controller

    # Fetch kubeconfig from SSM
    aws ssm get-parameter \
      --name "/k8s/${{ inputs.cdk-environment }}/kubeconfig" \
      --with-decryption --query 'Parameter.Value' --output text \
      | sed 's|https://127.0.0.1:6443|https://kubernetes.default.svc:443|g' \
      > /tmp/kubeconfig
    chmod 600 /tmp/kubeconfig

    kubectl apply --server-side --force-conflicts \
      --field-manager=kubectl-bootstrap \
      --kubeconfig /tmp/kubeconfig \
      -f /tmp/arc-controller/gha-runner-scale-set-controller/crds/

    aws ssm put-parameter \
      --name "$SSM_KEY" --value "$CHART_VERSION" \
      --type String --overwrite
    echo "[OK] ARC CRDs applied at $CHART_VERSION"
```

### Point 2: arc-github-secret Creation

The `arc-github-secret` contains sensitive credentials that cannot be stored in GitHub
secrets (they are K8s credentials, not AWS credentials). Options:

**Option A: Manual (current)** — Run once manually after bootstrap. The secret persists
in the cluster and survives reboots/restores (it is stored in etcd, backed up by the
kubeadm etcd snapshot procedure).

**Option B: AWS Secrets Manager → K8s Secret via SSM automation**

Store GitHub App credentials in AWS Secrets Manager at bootstrap time:
```
/arc/github-app-id
/arc/github-app-installation-id
/arc/github-app-private-key (SecureString)
```

Add a step in SM-B (Config Orchestrator) `_post-bootstrap-config.yml` to create
the secret on every bootstrap, making it self-healing:

```python
# In SM-B step: bootstrap_arc.py
arc_id = ssm.get_parameter('/arc/github-app-id')
arc_install_id = ssm.get_parameter('/arc/github-app-installation-id')
arc_key = ssm.get_parameter('/arc/github-app-private-key', WithDecryption=True)

upsert_secret(v1, 'arc-github-secret', 'arc-runners', {
    'github_app_id': arc_id,
    'github_app_installation_id': arc_install_id,
    'github_app_private_key': arc_key,
})
```

This means the secret is recreated on every cluster restore — no manual intervention needed.

---

## deploy.py and the deploy-admin-api Job

### Current Architecture (Post-ARC)

The deploy jobs now run **inside the cluster** on a self-hosted runner. The `deploy.py`
scripts are run directly via `python3` — not via SSM SendCommand on the EC2 CP node.

**What `deploy.py` does (admin-api):**

1. Reads Cognito parameters from SSM (`/nextjs/development/auth/cognito-*`)
2. Reads Bedrock/DynamoDB parameters from SSM (`/bedrock-dev/*`)
3. Creates/updates `admin-api-secrets` (K8s Secret — Cognito creds)
4. Creates/updates `admin-api-config` (K8s ConfigMap — infra refs)
5. Applies Traefik `IngressRoute` via `kubectl apply`

**Why `deploy.py` is NOT deleted:**

`deploy.py` is the **sole owner** of the admin-api K8s resources it manages. ArgoCD
does not manage `admin-api-secrets`, `admin-api-config`, or the `admin-api` IngressRoute
— those are created imperatively by `deploy.py` to prevent race conditions during secret
rotation. Deleting `deploy.py` would leave these resources unmanaged.

**What changed:** The delivery mechanism changed from SSM → S3 → EC2 to
direct execution on a runner pod inside the cluster. The script logic is unchanged.

### Python Execution Pattern (PEP 668 + PYTHONPATH)

The runner image uses Python 3.12 on Ubuntu, which enforces **PEP 668** — the system
Python rejects `pip install` outside a virtual environment with:

```
error: externally-managed-environment
× This environment is externally managed
```

Both deploy steps create an isolated venv and reference it explicitly:

```yaml
- name: Apply admin-api K8s resources
  env:
    KUBECONFIG: /tmp/kubeconfig
    AWS_DEFAULT_REGION: ${{ env.AWS_REGION }}
    PYTHONPATH: kubernetes-app/k8s-bootstrap
  run: |
    python3 -m venv /tmp/deploy-venv
    /tmp/deploy-venv/bin/pip install -q -r kubernetes-app/k8s-bootstrap/deploy_helpers/requirements.txt
    /tmp/deploy-venv/bin/python3 kubernetes-app/workloads/charts/admin-api/deploy.py
```

**Why `PYTHONPATH: kubernetes-app/k8s-bootstrap`:**

`deploy_helpers` is a local module at `kubernetes-app/k8s-bootstrap/deploy_helpers/`.
The runner's working directory is the repo root — `deploy_helpers` is not a top-level
package and is not on Python's default path. Without `PYTHONPATH`, both scripts fail with:

```
ModuleNotFoundError: No module named 'deploy_helpers'
```

Setting `PYTHONPATH` to `kubernetes-app/k8s-bootstrap` makes `deploy_helpers` importable
as a package without modifying `deploy.py` or installing the module.

### Why SSM Delivery Was Removed

| Old (SSM path) | New (ARC runner path) |
|----------------|----------------------|
| `yarn tsx ssm-deploy.ts --app admin-api` | `python3 kubernetes-app/workloads/charts/admin-api/deploy.py` |
| Uploads script to S3, triggers SSM SendCommand | Checks out repo fresh, runs directly |
| 75+ second polling loop | Completes in seconds |
| Requires CP node to be running | Works regardless of CP state |
| Requires SSM Agent to be healthy | No SSM dependency |

The SSM delivery path (`ssm-deploy.ts`, `sync-bootstrap-scripts.ts`) is still used
by the full bootstrap pipeline (`_deploy-ssm-automation.yml`) for kubeadm steps —
those still run on the EC2 node. Only the API deploy steps moved to ARC.

---

## Runner Pod Configuration

### Why `command: ["/home/runner/run.sh"]` Is Required

The official `ghcr.io/actions/actions-runner:latest` base image has **no ENTRYPOINT and
no CMD set**. When Kubernetes starts a container with no entrypoint override and no
command in the image, the container starts and immediately exits with code 0.

ARC normally injects the command via the `containerMode` mechanism — but this scale set
uses the default mode (steps run directly in the runner container, not in DinD sidecars).
In default mode, ARC does **not** inject the command automatically.

**Without `command:`:** runner pod starts, exits in ~2 seconds with no error, no logs.
ARC marks the EphemeralRunner failed. After 5 retries: `"Pod has failed to start more
than 5 times"`. The JIT config IS present (the controller injects `ACTIONS_RUNNER_INPUT_JITCONFIG`)
— the runner just never executes.

**Fix applied in two places:**

1. **`arc-runners.yaml` container spec** — explicit command so ARC-created pods run:
   ```yaml
   containers:
     - name: runner
       image: ghcr.io/nelson-lamounier/cdk-monitoring/arc-runner:latest
       command: ["/home/runner/run.sh"]
   ```

2. **`Dockerfile` ENTRYPOINT** — makes the image self-describing:
   ```dockerfile
   USER runner
   ENTRYPOINT ["/home/runner/run.sh"]
   ```

Both are required: the Dockerfile ENTRYPOINT is overridden by `command:` in Kubernetes
anyway, but it documents intent and makes `docker run` work without extra arguments.
The `command:` in the pod spec is the operative fix for ARC-managed pods.

### Branch Guard for `workflow_dispatch`

GitHub Actions `branches:` filter under `on:` applies only to push/pull_request events.
`workflow_dispatch` ignores it entirely — manual triggers always appear regardless of
which branch the workflow file is on, and can be dispatched against any branch via
the GitHub UI or API.

Without a branch guard, `workflow_dispatch` on `main` would run deploy steps against
the develop-only ECR/SSM configuration, silently succeeding with the wrong image.

**Fix:** a guard step in `resolve-targets` that all downstream jobs depend on:

```yaml
jobs:
  resolve-targets:
    runs-on: [self-hosted, k8s-runner]
    steps:
      - name: Guard — develop branch only
        if: github.ref != 'refs/heads/develop'
        run: |
          echo "::error::This workflow only runs on the develop branch (got: ${{ github.ref }})"
          exit 1
```

Because `deploy-admin-api` and `deploy-public-api` both `needs: resolve-targets`, a
non-zero exit here cascades — all downstream jobs are skipped. No separate `if:` guard
needed on each job.

---

## File Reference

| File | Purpose |
|------|---------|
| `kubernetes-app/platform/argocd-apps/arc-controller.yaml` | ArgoCD Application for ARC controller Helm chart |
| `kubernetes-app/platform/argocd-apps/arc-runners.yaml` | ArgoCD Application for runner scale set Helm chart (`command: ["/home/runner/run.sh"]` required) |
| `.github/docker/arc-runner/Dockerfile` | Custom runner image with AWS CLI, kubectl, python3+venv pre-installed |
| `kubernetes-app/k8s-bootstrap/system/arc/runner-rbac.yaml` | ServiceAccount + ClusterRole for runner pods |
| `kubernetes-app/k8s-bootstrap/system/arc/webhook-ingressroute.yaml` | Traefik route: runners.nelsonlamounier.com/webhook → ARC port 9000 |
| `infra/lib/config/kubernetes/configurations.ts` | `runnersSubdomain: 'runners'` added to edge config |
| `infra/lib/stacks/kubernetes/edge-stack.ts` | `RunnersDnsRecord` custom resource (A record → EIP) |
| `.github/workflows/deploy-api.yml` | `runs-on: [self-hosted, k8s-runner]` deploy jobs with venv pip + PYTHONPATH |
| `kubernetes-app/workloads/charts/admin-api/deploy.py` | Applies admin-api K8s resources (Secret, ConfigMap, IngressRoute) |
| `kubernetes-app/workloads/charts/public-api/deploy.py` | Applies public-api K8s resources |
| `kubernetes-app/k8s-bootstrap/deploy_helpers/` | Shared Python module imported by both deploy scripts (requires PYTHONPATH) |

---

## Security Notes

- The `arc-runner` ServiceAccount has cluster-wide Secret write access — scoped to only
  what `deploy.py` needs. Review `runner-rbac.yaml` before expanding permissions.
- The `arc-github-secret` contains a GitHub App private key — equivalent to full runner
  registration access. Rotate the key in GitHub App settings if compromised.
- The GHCR PAT (stored as ArgoCD repository secret) needs only `read:packages` scope.
  Rotate at `ghcr-oci-arc-charts` K8s secret level if compromised.
- The ARC webhook endpoint (`runners.nelsonlamounier.com/webhook`) is public — no IP
  allowlist is possible since GitHub sends from rotating IP ranges. The ARC controller
  validates events via `X-Hub-Signature-256` HMAC (configured in `webhookServer.secret`).

## Related

- [ARC Runner Troubleshooting](../troubleshooting/arc-runner-troubleshooting.md) — manual setup steps, verification commands, and troubleshooting journal

<!--
Evidence trail (auto-generated):
- Source: docs/incoming/arc-github-runners-setup.md (migrated 2026-04-28 — split from 971-line doc; concept/setup sections extracted)
- Generated: 2026-04-28
-->
