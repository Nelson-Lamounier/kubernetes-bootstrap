---
title: ARC Runner Troubleshooting
type: troubleshooting
tags: [arc, github-actions, kubernetes, self-hosted-runners]
sources:
  - argocd-apps/arc-controller.yaml
  - argocd-apps/arc-runners.yaml
created: 2026-04-28
updated: 2026-04-28
---

# ARC Runner Troubleshooting

> For setup and architecture, see [ARC GitHub Actions Self-Hosted Runners](../tools/arc-github-runners.md).

## Manual Setup Steps (One-Time, Cannot Be Automated)

These steps must be performed manually before ARC can be deployed.
They involve GitHub UI actions that have no API equivalent in CDK/Terraform.

### Step 1: DNS — Add runners.nelsonlamounier.com

This was done via CDK edge stack (`runnersSubdomain: 'runners'` in `K8S_CONFIGS`).
It creates an A record pointing to the cluster EIP via the cross-account Route53 role.

**Verify:**
```bash
host runners.nelsonlamounier.com
# Expected: runners.nelsonlamounier.com has address <EIP>
```

### Step 2: Create GitHub App

Navigate to: **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**

| Field | Value |
|-------|-------|
| App name | `nelson-portfolio-arc` (or any name) |
| Homepage URL | `https://github.com/Nelson-Lamounier` |
| Webhook | Disabled (ARC uses long-poll for auth, webhook is separate) |
| **Permissions → Repository → Actions** | Read & Write |
| **Permissions → Repository → Administration** | Read & Write |
| **Permissions → Repository → Metadata** | Read (mandatory) |
| Where can this be installed | Only on this account |

After creation:
- Note the **App ID** (numeric, shown at top of app settings page)
- Generate a **private key**: scroll to "Private keys" → "Generate a private key"
  → downloads as `.pem` file

### Step 3: Install GitHub App on the Organisation

Navigate to: **GitHub App settings → Install App → Install on Nelson-Lamounier**

Select: "All repositories" or specific repos.

After installation, navigate to:
`https://github.com/organizations/Nelson-Lamounier/settings/installations`

Click "Configure" on your app. The **Installation ID** is the number at the end of the URL:
```
https://github.com/organizations/.../settings/installations/124999418
#                                                                    ↑
#                                                            INSTALLATION_ID
```

### Step 4: Bootstrap ARC CRDs (Manual, Required Before ArgoCD Sync)

The `autoscalingrunnersets` CRD has a schema exceeding 262144 bytes — Kubernetes'
annotation limit for `kubectl.kubernetes.io/last-applied-configuration`. ArgoCD's
client-side apply stores the full manifest in this annotation, causing:

```
CustomResourceDefinition is invalid: metadata.annotations: Too long: may not be more than 262144 bytes
```

**Why `skipCrds: true` was added to arc-controller.yaml:**

`skipCrds: true` passes `--skip-crds` to Helm during template rendering. ArgoCD
never sees the CRD manifests — they are excluded from the sync entirely. This prevents
the annotation size error and the prune cycle (ArgoCD fails → prunes CRD → fails again).

**Alternative approaches and trade-offs:**

| Approach | Trade-off |
|----------|-----------|
| `skipCrds: true` (current) | CRDs managed manually; must re-run bootstrap on chart upgrades |
| `ServerSideApply=true` (tried) | Should work but ArgoCD v3 has regression for large CRDs |
| `Replace=true` | Destructive; replaces entire resource, can break cluster |
| `ignoreDifferences` + `RespectIgnoreDifferences=true` | Only skips diff check, ArgoCD still applies |
| Global `resource.exclusions` in argocd-cm | Excludes ALL CRDs cluster-wide — too broad |
| Pre-sync Job hook | Adds complexity; hook must manage CRD lifecycle independently |

**The bootstrap command** (run once per chart version bump):

```bash
# Pull the chart to extract CRD manifests
helm registry login ghcr.io \
  --username <GITHUB_USERNAME> \
  --password <GITHUB_PAT_READ_PACKAGES>

helm pull \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller \
  --version 0.10.1 --untar --destination /tmp/arc-controller

# Apply with server-side apply (no annotation size limit)
kubectl apply --server-side --force-conflicts \
  --field-manager=kubectl-bootstrap \
  -f /tmp/arc-controller/gha-runner-scale-set-controller/crds/
```

**"Run the bootstrap command again" means:** when upgrading the chart version
(e.g., `0.10.1` → `0.11.0`), the CRDs may change. Since ArgoCD skips them,
you must manually re-run the above command with the new version number before
updating `targetRevision` in `arc-controller.yaml`. ArgoCD handles all other
resources; only CRDs need this manual step.

**Can this be automated?** Yes — two options:

**Option A: Pre-sync ArgoCD hook (recommended long-term)**

Add a Kubernetes Job with `argocd.argoproj.io/hook: PreSync` annotation inside the
chart values. The Job runs `kubectl apply --server-side` on the CRDs before the main
sync. This requires a service account with `apiextensions.k8s.io/customresourcedefinitions`
RBAC and a container image with `kubectl` + `helm`.

**Option B: Include in `_deploy-ssm-automation.yml`**

Add a step in the SSM automation pipeline that runs the bootstrap command when the
chart version changes (detected via SSM parameter comparison). This is simpler than
Option A and reuses existing AWS infrastructure.

### Step 5: Create arc-github-secret

This secret must be created manually (contains sensitive credentials — never commit to git):

```bash
export KUBECONFIG=/tmp/k8s-dev.kubeconfig  # fetched from SSM

kubectl create namespace arc-runners

kubectl create secret generic arc-github-secret \
  --namespace arc-runners \
  --from-literal=github_app_id="<APP_ID>" \
  --from-literal=github_app_installation_id="<INSTALLATION_ID>" \
  --from-literal=github_app_private_key="$(cat ~/Downloads/<app-name>.private-key.pem)"
```

**Verify the secret was created correctly:**
```bash
# Check all three keys exist
kubectl get secret arc-github-secret -n arc-runners \
  -o jsonpath='{.data}' | jq 'keys'
# Expected: ["github_app_id", "github_app_installation_id", "github_app_private_key"]

# Verify private key is not empty
kubectl get secret arc-github-secret -n arc-runners \
  -o jsonpath='{.data.github_app_private_key}' | base64 -d | head -1
# Expected: -----BEGIN RSA PRIVATE KEY-----
```

### Step 6: Create GHCR Repository Secret in ArgoCD

ArgoCD needs a PAT with `read:packages` scope to pull charts from GHCR OCI registry.
GHCR returns 403 for unauthenticated OCI requests even for public packages.

```bash
kubectl create secret generic ghcr-oci-arc-charts \
  --namespace argocd \
  --from-literal=type=helm \
  --from-literal=name=ghcr-arc-charts \
  --from-literal=url=oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller \
  --from-literal=enableOCI=true \
  --from-literal=username=<GITHUB_USERNAME> \
  --from-literal=password=<PAT_READ_PACKAGES>

kubectl label secret ghcr-oci-arc-charts -n argocd \
  argocd.argoproj.io/secret-type=repository
```

> **Security:** The PAT value should never be pasted into chat sessions, commit messages,
> or log outputs. Generate it in GitHub UI and type/paste it directly into the terminal.
> Rotate immediately if accidentally exposed.

---

## Verification Commands

### Cluster Health Checks

```bash
# 1. ARC controller pod running
kubectl get pods -n arc-systems
# Concept: Controller manages the runner pod lifecycle and webhook server.
# If not Running, ARC cannot create runner pods or receive GitHub events.

# 2. AutoscalingRunnerSet registered
kubectl get autoscalingrunnerset -n arc-runners
# Concept: This CRD instance represents the runner pool. The "k8s" scale set
# must exist and show minRunners=0, maxRunners=3 for runners to be dispatched.
# CURRENT RUNNERS = 0 when idle is correct — minRunners: 0 means zero idle cost.

# 3. Scale set detail
kubectl describe autoscalingrunnerset k8s -n arc-runners
# Look for: githubConfigUrl, githubConfigSecret, controllerServiceAccount
# If githubConfigSecret is wrong, runners won't register with GitHub.

# 4. GitHub App secret has all three fields
kubectl get secret arc-github-secret -n arc-runners \
  -o jsonpath='{.data}' | jq 'keys'
# Must show: github_app_id, github_app_installation_id, github_app_private_key

# 5. GHCR repo secret registered in ArgoCD
kubectl get secret ghcr-oci-arc-charts -n argocd \
  -o jsonpath='{.data.url}' | base64 -d && echo
# Must match the repoURL in arc-controller.yaml exactly

# 6. CRDs installed
kubectl get crd | grep actions.github.com
# Must show: autoscalingrunnersets, autoscalinglisteners, ephemeralrunners, ephemeralrunnersets

# 7. ARC controller logs (no auth errors)
kubectl logs -n arc-systems deploy/arc-controller --tail=30
# Look for: "Starting controller" and NO "401 Unauthorized" or "403 Forbidden"

# 8. Webhook endpoint reachable
curl -I https://runners.nelsonlamounier.com/webhook
# Expected: 200 or 405 (Method Not Allowed for GET — webhook expects POST)
# If 404: Traefik IngressRoute not applied (apply webhook-ingressroute.yaml)
# If connection refused: DNS not resolving or EIP not routing to cluster
```

### GitHub-Side Verification

Navigate to: `https://github.com/organizations/Nelson-Lamounier/settings/actions/runners`

The runner pool `k8s` should appear with status **Idle** (no jobs running) or
**Active** (job in progress). If it does not appear, check ARC controller logs
for authentication errors against the GitHub App.

---

## Testing the Full Integration

### Test 1: Trigger a Workflow on the Self-Hosted Runner

Create a test workflow or use an existing one that targets `[self-hosted, k8s]`:

```yaml
# .github/workflows/test-arc-runner.yml
name: Test ARC Runner
on: workflow_dispatch
jobs:
  test:
    runs-on: [self-hosted, k8s]
    steps:
      - name: Verify in-cluster access
        run: |
          echo "Runner hostname: $(hostname)"
          echo "Kubernetes API: $(curl -sk https://kubernetes.default.svc/healthz)"
          kubectl get nodes
      - name: Verify AWS access
        run: aws sts get-caller-identity
```

While the workflow runs:
```bash
# Watch runner pod appear (scale from 0 → 1)
kubectl get pods -n arc-runners -w
# Expected: A pod named k8s-<random> appears, runs, then is deleted after job completes
```

### Test 2: deploy-admin-api End-to-End

1. Make a trivial change to `api/admin-api/` (e.g., add a comment)
2. Push to `develop`
3. The `deploy-admin-api` job runs on `[self-hosted, k8s]`
4. Watch the runner pod in `arc-runners` namespace
5. Check SSM parameter was updated: `/admin-api/development/image-uri`
6. Verify ArgoCD applied the new image to the admin-api Deployment

```bash
# Check SSM was updated
aws ssm get-parameter \
  --name "/admin-api/development/image-uri" \
  --profile dev-account --region eu-west-1 \
  --query 'Parameter.Value' --output text

# Check ArgoCD reconciled
kubectl get application admin-api -n argocd \
  -o jsonpath='{.status.sync.status}' && echo

# Check the Deployment rolled out
kubectl rollout status deployment/admin-api -n admin-api
```

---

## Troubleshooting Journal

This section documents the issues encountered during initial ARC setup and their
resolutions. Each entry is a real failure mode with the exact symptoms and fix applied.

### Issue 1: Runner Pods Exit in ~2 Seconds — No Logs, No Error

**Symptoms:**
- `kubectl get pods -n arc-runners -w` shows a pod appear and immediately enter
  `Completed` or `Error` state within 2 seconds
- Pod logs are empty (`kubectl logs <pod>` returns nothing)
- GitHub workflow shows job queued but never starts execution
- ARC controller events: `"Pod has failed to start more than 5 times"`
- `kubectl get ephemeralrunner -n arc-runners` shows all runners in `Failed` state
- `kubectl describe ephemeralrunner` shows `ACTIONS_RUNNER_INPUT_JITCONFIG` IS set

**Root Cause:**

The `ghcr.io/actions/actions-runner:latest` base image has no ENTRYPOINT and no CMD.
Kubernetes starts the container, finds nothing to execute, and exits with code 0.
The container never runs `run.sh`. The JIT token is correctly injected — the runner
just never uses it.

**Diagnostic that confirmed it:**

Override the container with a sleep to inspect the environment:
```bash
kubectl run arc-test \
  --image=ghcr.io/actions/actions-runner:latest \
  --restart=Never \
  --namespace=arc-runners \
  --overrides='{
    "spec": {
      "containers": [{
        "name": "arc-test",
        "image": "ghcr.io/actions/actions-runner:latest",
        "command": ["sleep", "3600"],
        "env": [{"name": "ACTIONS_RUNNER_INPUT_JITCONFIG", "value": "debug"}]
      }]
    }
  }'

kubectl exec -it arc-test -n arc-runners -- env | grep ACTIONS_RUNNER
# Confirms: env injection works. Image just lacks entrypoint.
```

Manually exec into a real EphemeralRunner pod that was sleeping (via debug override in
arc-runners.yaml) and run `/home/runner/run.sh` — the GitHub workflow immediately picked
up the job and executed. This confirmed: JIT config correct, runner script works, only
the missing ENTRYPOINT caused the 2-second exit.

**Fix:**

Added `command: ["/home/runner/run.sh"]` to the container spec in `arc-runners.yaml`
AND `ENTRYPOINT ["/home/runner/run.sh"]` to `.github/docker/arc-runner/Dockerfile`.

---

### Issue 2: Ghost Assignment Cascade (cancel-in-progress Flooding)

**Symptoms:**
- Runners pick up a job assignment and exit in ~2 seconds with code 0
- Each new push triggers the previous run to be cancelled
- ARC listener logs show a burst of `"job assigned: <id>"` messages for cancelled runs
- `kubectl get ephemeralrunner -n arc-runners` shows multiple runners in rapid succession,
  all failing, all cycling
- `totalRegisteredRunners: 0` even as new EphemeralRunners are being created

**Root Cause:**

`cancel-in-progress: true` on the workflow concurrency group causes every new trigger
to cancel the previous run. GitHub sends the cancelled job assignment to the listener
anyway — the runner picks it up, detects it is cancelled, exits immediately. Each
runner that exits in this way appears as a failed start to ARC, consuming retry budget.

When many stale runs accumulate (e.g., several push events in rapid succession), the
listener queue fills with ghost assignments. Runners are created, assigned ghost jobs,
exit, and ARC marks them failed — in a loop.

**Fix / Workaround:**

1. Cancel all running and queued workflow runs for the repo:
   ```bash
   gh run list --workflow deploy-api.yml --status in_progress --json databaseId \
     | jq '.[].databaseId' \
     | xargs -I{} gh run cancel {}

   gh run list --workflow deploy-api.yml --status queued --json databaseId \
     | jq '.[].databaseId' \
     | xargs -I{} gh run cancel {}
   ```

2. Clear any Failed EphemeralRunners to let ARC reset state:
   ```bash
   kubectl delete ephemeralrunner -n arc-runners --all
   ```

3. Wait ~30 seconds for the listener queue to drain, then trigger exactly one clean run.

**Long-term note:** `cancel-in-progress: true` is correct behaviour for deploy pipelines
(no point deploying a stale commit). The ghost assignment issue only manifests during
initial debugging when many runs are queued manually in quick succession. In normal
operation (one push → one run → completes before next push), it does not occur.

---

### Issue 3: `error: externally-managed-environment` (PEP 668)

**Symptoms:**

```
error: externally-managed-environment
× This environment is externally managed
╰─> See /usr/lib/python3.12/EXTERNALLY-MANAGED for details
```

The deploy step fails immediately when running `pip install` in the admin-api or
public-api deploy step.

**Root Cause:**

Python 3.12 (Debian/Ubuntu packaging) enforces PEP 668, which prohibits system-wide
`pip install` outside a virtual environment. The runner image uses Python 3.12.

Initial deploy steps used bare `pip install`:
```yaml
run: pip install -r requirements.txt  # fails on Python 3.12
```

A partially-fixed version created a venv but still called the system `pip`:
```yaml
run: |
  python3 -m venv /tmp/deploy-venv
  pip install -r requirements.txt  # still the system pip — also fails
```

**Fix:**

Use the venv binary for both `pip` and `python3`:
```yaml
run: |
  python3 -m venv /tmp/deploy-venv
  /tmp/deploy-venv/bin/pip install -q -r kubernetes-app/k8s-bootstrap/deploy_helpers/requirements.txt
  /tmp/deploy-venv/bin/python3 kubernetes-app/workloads/charts/admin-api/deploy.py
```

---

### Issue 4: `ModuleNotFoundError: No module named 'deploy_helpers'`

**Symptoms:**

```
ModuleNotFoundError: No module named 'deploy_helpers'
```

Occurs even after the venv fix (Issue 3) when the deploy script runs.

**Root Cause:**

`deploy_helpers` is a local package at `kubernetes-app/k8s-bootstrap/deploy_helpers/`.
The runner's working directory is the repo root. Python's module resolution does not
descend into subdirectories — `deploy_helpers` is not importable from the repo root
without explicitly adding its parent to the path.

`deploy.py` imports it as:
```python
from deploy_helpers.ssm import get_param
```

This works when running from `kubernetes-app/k8s-bootstrap/` but fails from the repo
root (which is where the runner checks out the repo).

**Fix:**

Set `PYTHONPATH` in the step's `env:` block:
```yaml
env:
  PYTHONPATH: kubernetes-app/k8s-bootstrap
```

This tells Python to add `kubernetes-app/k8s-bootstrap` to the module search path,
making `deploy_helpers` importable as a package. No changes to `deploy.py` required.

---

### Issue 5: `workflow_dispatch` Triggers on Main Branch

**Symptoms:**

- Clicking "Run workflow" in GitHub UI against the `main` branch triggers the deploy
  pipeline with the `main` branch context
- `branches: [develop, main]` in `on: push:` does NOT prevent `workflow_dispatch` from
  running on any branch — that filter only applies to push events

**Root Cause:**

`workflow_dispatch` is a standalone trigger that bypasses all `branches:` filters. The
GitHub UI shows a branch selector — any branch can be chosen, even `main`. The deploy
workflow is designed for `develop` only (ECR paths, SSM parameters, ArgoCD apps are all
`development` environment scoped).

**Fix:**

Add a guard step as the first step in `resolve-targets`:
```yaml
- name: Guard — develop branch only
  if: github.ref != 'refs/heads/develop'
  run: |
    echo "::error::This workflow only runs on the develop branch (got: ${{ github.ref }})"
    exit 1
```

All downstream jobs `needs: resolve-targets`, so a failure here cascades cleanly.
The `if:` condition `github.ref != 'refs/heads/develop'` means the step is skipped
(and the job succeeds) on the correct branch, and fails on any other branch.

---

### Debugging Toolkit

**Watch runner pods appear and disappear in real time:**
```bash
kubectl get pods -n arc-runners -w
```

**Check EphemeralRunner state (shows Failed, Succeeded, etc.):**
```bash
kubectl get ephemeralrunner -n arc-runners
kubectl describe ephemeralrunner -n arc-runners <name>
```

**Clear all failed EphemeralRunners (let ARC reset):**
```bash
kubectl delete ephemeralrunner -n arc-runners --all
```

**ARC controller logs (runner registration, GitHub auth, job assignments):**
```bash
kubectl logs -n arc-systems deploy/arc-controller --tail=50 -f
```

**ARC listener logs (job queuing, assignment dispatching):**
```bash
kubectl logs -n arc-runners -l app.kubernetes.io/component=listener --tail=50 -f
```

**Debug pod — inspect what the runner image can see (JIT token, env vars):**
```bash
kubectl run arc-debug \
  --image=ghcr.io/nelson-lamounier/cdk-monitoring/arc-runner:latest \
  --restart=Never --namespace=arc-runners \
  --overrides='{"spec":{"containers":[{"name":"arc-debug","image":"ghcr.io/nelson-lamounier/cdk-monitoring/arc-runner:latest","command":["sleep","3600"]}],"serviceAccountName":"arc-runner"}}'

kubectl exec -it arc-debug -n arc-runners -- env | grep -E 'ACTIONS|RUNNER'
kubectl exec -it arc-debug -n arc-runners -- aws sts get-caller-identity
kubectl exec -it arc-debug -n arc-runners -- kubectl get nodes
kubectl delete pod arc-debug -n arc-runners
```

**Cancel all stale workflow runs (drain ghost assignments):**
```bash
for STATUS in in_progress queued; do
  gh run list --workflow deploy-api.yml --status $STATUS --json databaseId \
    | jq '.[].databaseId' \
    | xargs -I{} gh run cancel {} 2>/dev/null || true
done
```

---

## Related

- [ARC GitHub Actions Self-Hosted Runners](../tools/arc-github-runners.md) — architecture, ArgoCD deployment, runner pod configuration

<!--
Evidence trail (auto-generated):
- Source: docs/incoming/arc-github-runners-setup.md (migrated 2026-04-28 — split from 971-line doc; troubleshooting sections extracted)
- Generated: 2026-04-28
-->
