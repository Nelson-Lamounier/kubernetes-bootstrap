# system/ — Kubernetes Bootstrap System Components

Day-1 infrastructure scripts and manifests deployed to the control plane
via S3 → SSM RunCommand. These run **before** ArgoCD can reconcile, bridging
the gap between a bare EC2 instance and a fully operational Kubernetes cluster.

---

## Why Python?

The ArgoCD bootstrap orchestrator (`bootstrap_argocd.py`) and the TLS certificate
persistence script (`persist-tls-cert.py`) are written in **Python** rather than
shell because they need to:

- **Call AWS APIs** (SSM Parameter Store, Secrets Manager) via `boto3` — Python's
  AWS SDK is far more ergonomic than shelling out to `aws cli` for structured
  JSON responses, error handling, and retry logic.
- **Parse and manipulate JSON** — reading K8s Secret data, encoding/decoding
  base64 certificate payloads, and building SSM payloads is cleaner with
  `json.loads()` / `json.dumps()` than with `jq` + shell variables.
- **Handle errors gracefully** — Python's `try/except` with `botocore.ClientError`
  provides specific error codes (`ParameterNotFound`, `AccessDeniedException`)
  that would require complex `aws cli` exit code parsing in shell.
- **Support testability** — Python functions can be unit tested with `pytest`
  and mocked with `unittest.mock`, whereas bash scripts can only be validated
  with syntax checks and content assertions.

The DR scripts (`etcd-backup.sh`, `install-etcd-backup-timer.sh`) remain in
**shell** because they orchestrate system-level tools (`systemctl`, `crictl`,
`etcdctl`) where shell is the natural and more portable choice.

---

## Directory Structure

```
system/
├── argocd/                     # ArgoCD server + App-of-Apps
│   ├── bootstrap_argocd.py     # Main orchestrator (modular Python package)
│   ├── bootstrap-argocd.sh     # SSM entry point (sources env → runs Python)
│   ├── helpers/                # Shared utilities (config, logger, runner)
│   ├── steps/                  # Individual bootstrap steps (networking, etc.)
│   ├── install.yaml            # Vendored ArgoCD manifests (~1.8MB)
│   ├── namespace.yaml          # argocd namespace
│   ├── default-project.yaml    # Default AppProject
│   ├── platform-root-app.yaml  # Platform App-of-Apps (monitoring, ingress)
│   ├── workloads-root-app.yaml # Workloads App-of-Apps (portfolio, API)
│   ├── repo-secret.yaml        # GitHub repo credentials
│   ├── ingress.yaml            # ArgoCD Traefik IngressRoute
│   └── webhook-ingress.yaml    # GitHub webhook IngressRoute
│
├── argocd-notifications/
│   └── notifications-cm.yaml   # Slack/GitHub notification templates
│
├── cert-manager/
│   ├── persist-tls-cert.py     # Back up / restore TLS Secrets via SSM
│   ├── cluster-issuer.yaml     # Let's Encrypt ClusterIssuer (prod + staging)
│   └── ops-certificate.yaml    # Wildcard certificate for *.ops domain
│
├── dr/                         # Disaster Recovery
│   ├── etcd-backup.sh          # Snapshot etcd → S3 (with SSE + pruning)
│   └── install-etcd-backup-timer.sh  # systemd timer (hourly backups)
│
├── traefik/
│   └── traefik-values.yaml     # Helm values (DaemonSet, mTLS, Prometheus)
│
└── priority-classes.yaml       # PriorityClass definitions (system/workloads)
```

---

## Component Details

### ArgoCD (`argocd/`)

**Purpose:** Bootstrap the GitOps engine itself — the one component that
cannot be managed by GitOps.

| File | Role |
|------|------|
| `bootstrap_argocd.py` | Orchestrates the full install: apply manifests → wait for rollout → configure admin credentials → create root Applications |
| `bootstrap-argocd.sh` | SSM RunCommand entry point — sources `/etc/profile.d/k8s-env.sh` and invokes the Python orchestrator |
| `install.yaml` | Pinned, vendored ArgoCD manifests (avoids external fetch at bootstrap time) |
| `platform-root-app.yaml` | Root Application pointing to `platform/` charts (Prometheus, Grafana, Loki, Tempo, Traefik) |
| `workloads-root-app.yaml` | Root Application pointing to `workloads/` charts (portfolio site, APIs) |

**Why vendored?** The cluster has no ingress controller or DNS at bootstrap
time, so Helm chart pulls would fail. Vendoring guarantees deterministic,
offline installation.

### cert-manager (`cert-manager/`)

**Purpose:** Persist TLS certificates across instance replacements to avoid
Let's Encrypt rate limiting (5 certs/domain/week).

| File | Role |
|------|------|
| `persist-tls-cert.py` | Backs up K8s TLS Secrets to SSM SecureString; restores them before cert-manager starts on the next bootstrap |
| `cluster-issuer.yaml` | Let's Encrypt ACME issuer (production + staging) |
| `ops-certificate.yaml` | Wildcard Certificate for `*.ops.<domain>` |

**Workflow:**
1. **Restore** (bootstrap): SSM → K8s Secret (before cert-manager starts)
2. **Backup** (post-issuance): K8s Secret → SSM (after cert is `Ready`)

Supports both `kubernetes.io/tls` and `Opaque` Secret types (ACME account keys).

### Disaster Recovery (`dr/`)

**Purpose:** Automated etcd snapshots uploaded to S3, enabling cluster restore
without data loss.

| File | Role |
|------|------|
| `etcd-backup.sh` | Takes an etcd snapshot, verifies integrity, uploads to S3 with `--sse AES256`, prunes old backups (keeps 168 = 7 days × 24 hourly) |
| `install-etcd-backup-timer.sh` | Creates a systemd service + timer for hourly execution |

**Key design decisions:**
- **Shell, not Python:** These scripts interact with `systemctl`, `crictl`,
  `etcdctl`, and static pods — shell is the natural choice for system-level
  orchestration.
- **Host-visible snapshot path:** Uses `/var/lib/etcd/snapshots/` (not `/tmp/`)
  because kubeadm's etcd static pod mounts `/var/lib/etcd` as a hostPath.
  The container writes the snapshot, and the host's `aws s3 cp` can read it.
- **etcd 3.6 compatibility:** Uses `etcdutl` for snapshot verification
  (replaces deprecated `etcdctl snapshot status`).

**S3 layout:**
```
s3://<bucket>/dr-backups/etcd/
├── 20260325-100609.db        # Timestamped snapshots
├── 20260325-110612.db
└── latest.db                 # Always points to the most recent (in-bucket copy)
```

### Traefik (`traefik/`)

Helm values for Traefik deployed as a DaemonSet with hostNetwork.
Includes Prometheus metrics, OTLP tracing to Tempo, and the default TLS store.

### Priority Classes

Defines `system-critical` and `workload-standard` PriorityClasses to ensure
system components (monitoring, ingress) are never evicted in favour of workloads.

---

## IAM Permissions

The control plane instance role requires:

| Permission | Resource | Purpose |
|------------|----------|---------|
| `s3:GetObject` | `<bucket>/*` | Download scripts and manifests |
| `s3:PutObject` | `<bucket>/dr-backups/*` | Upload etcd snapshots |
| `s3:DeleteObject` | `<bucket>/dr-backups/*` | Prune old backups |
| `ssm:PutParameter` | `/k8s/*/tls/*` | Store TLS certificate backups |
| `ssm:GetParameter` | `/k8s/*/tls/*` | Restore TLS certificates |
| `secretsmanager:GetSecretValue` | `k8s/*` | Crossplane cloud credentials |

These grants are defined in `control-plane-stack.ts` via CDK `grantRead`,
`grantPut`, `grantDelete`, and inline `PolicyStatement` constructs.

---

## Local Development Setup

> **Note:** If you are new to Python, follow these steps carefully.
> The project uses standard Python tooling (`pip`, `pyproject.toml`, `pytest`)
> that work the same way on macOS and Linux.

### Prerequisites

| Tool | Version | Check with |
|------|---------|------------|
| Python | ≥ 3.9 | `python3 --version` |
| pip | bundled with Python | `pip --version` |
| just | any | `just --version` |

macOS ships with Python 3.9+. If you need a newer version:
```bash
brew install python@3.11
```

### First-Time Setup

#### 1. Create a Virtual Environment

A **virtual environment** (venv) is an isolated Python installation that keeps
this project's dependencies separate from your system Python. This prevents
version conflicts between projects.

```bash
# Navigate to the k8s-bootstrap package root
cd kubernetes-app/k8s-bootstrap

# Create a virtual environment in the .venv/ directory
python3 -m venv .venv
```

This creates a `.venv/` folder containing a private copy of Python and pip.
The folder is already in `.gitignore` — it is never committed.

#### 2. Activate the Virtual Environment

You must activate the venv **every time you open a new terminal session**:

```bash
source .venv/bin/activate
```

When active, your terminal prompt changes to show `(.venv)`:
```
(.venv) ~/Desktop/portfolio/cdk-monitoring/kubernetes-app/k8s-bootstrap $
```

> **Tip:** To deactivate (return to system Python), simply run: `deactivate`

#### 3. Install Dependencies

With the venv active, install the project and its dev dependencies:

```bash
# -e  = "editable" — changes to source files take effect immediately
# [dev] = also install test tools (pytest, ruff, pyyaml)
pip install -e ".[dev]"
```

**What does `pip install -e ".[dev]"` do?**
- Reads `pyproject.toml` to discover the package and its dependencies
- Installs runtime deps: `boto3`, `kubernetes`, `bcrypt`
- Installs dev deps: `pytest`, `pytest-mock`, `pyyaml`, `ruff`
- Links the local source so edits work without re-installing

#### 4. Verify the Setup

```bash
# Check Python is using the venv
which python      # Should show: .../k8s-bootstrap/.venv/bin/python

# Check pytest is installed
python -m pytest --version

# Run a quick test to confirm everything works
python -m pytest tests/system/ -v
```

### Day-to-Day Workflow

```bash
# 1. Open terminal → navigate to k8s-bootstrap
cd kubernetes-app/k8s-bootstrap

# 2. Activate the venv
source .venv/bin/activate

# 3. Work, edit, test (repeat as needed)
just bootstrap-pytest tests/system/

# 4. Done? Deactivate (optional — closing the terminal also works)
deactivate
```

### Key Files for Python Newcomers

| File | Purpose |
|------|---------|
| `pyproject.toml` | The project manifest — defines deps, test config, linting rules |
| `tests/conftest.py` | Shared pytest fixtures (mock config, etc.) |
| `tests/system/` | The test suite for `system/` scripts |

---

## Testing

### How Tests Were Designed

The tests are split into two categories based on what they validate:

**1. Unit Tests (`test_persist_tls_cert.py`)** — For the Python script
- All external calls (`subprocess.run` for kubectl, `boto3` for SSM) are
  **mocked** using `unittest.mock` — no real AWS or K8s calls are made.
- The script's hyphenated filename (`persist-tls-cert.py`) cannot be
  imported with a regular `import` statement, so the tests use
  `importlib.util` to load it dynamically.
- Tests cover: backup/restore happy paths, dry-run mode, SSM errors,
  missing certificate fields, and edge cases.

**2. Static Validation (`test_dr_scripts.py`)** — For shell scripts and YAML
- Runs `bash -n` to syntax-check shell scripts (catches typos without executing)
- Asserts that scripts contain required safety features (`set -euo pipefail`,
  `--sse AES256`, correct snapshot paths, cleanup steps)
- Parses all YAML manifests with `yaml.safe_load_all()` to catch syntax errors
- Verifies K8s manifests have a `kind` field (Helm values files are excluded)

### Running Tests Locally

```bash
# Run the full system test suite (55 tests, ~4 seconds)
just bootstrap-pytest tests/system/

# Run only the TLS cert persistence tests
just bootstrap-pytest tests/system/test_persist_tls_cert.py

# Run only the DR / YAML validation tests
just bootstrap-pytest tests/system/test_dr_scripts.py

# Run a single specific test by name
just bootstrap-pytest tests/system/test_persist_tls_cert.py -k "test_backup_success"

# Run with extra verbose output (shows each assertion)
just bootstrap-pytest tests/system/ -vv
```

> **Tip:** The `just bootstrap-pytest` recipe simply runs
> `cd kubernetes-app/k8s-bootstrap && python -m pytest <args>`.
> You can also run `python -m pytest` directly from `kubernetes-app/k8s-bootstrap/`.

### Test Coverage Summary

| Test File | Tests | What It Covers |
|-----------|-------|----------------|
| `test_persist_tls_cert.py` | 15 | SSM path construction, backup (success, not found, dry-run, empty data, SSM error), restore (already exists, dry-run, TLS success, Opaque success, SSM not found), missing TLS fields |
| `test_dr_scripts.py` | 40 | Bash syntax (`bash -n`), strict mode, snapshot paths, S3 encryption, etcdctl resolution, cert validation, cleanup, systemd units, YAML parseability, K8s `kind` fields |

### On-Instance Testing (SSM)

For live testing via SSM RunCommand (requires an active control plane instance):

```bash
# TLS cert backup/restore (dry-run on instance)
just cert-test <instance-id>
just cert-test <instance-id> backup       # backup only
just cert-test <instance-id> restore      # restore only

# etcd backup — check prerequisites
just etcd-test <instance-id>

# etcd backup — full run (takes snapshot, uploads to S3)
just etcd-test <instance-id> run
```

---

## Bootstrap Execution Order

The SSM Automation document runs these in sequence:

```
1. persist-tls-cert.py --restore     ← Restore certs from SSM
2. bootstrap-argocd.sh               ← Install ArgoCD + root apps
3. install-etcd-backup-timer.sh      ← Enable hourly etcd backups
4. persist-tls-cert.py --backup      ← Back up newly issued certs
```

All steps are **idempotent** — safe to re-run at any time:
- Steps 1 & 4: Skip if Secret/parameter already exists
- Step 2: `kubectl apply` handles existing resources
- Step 3: `systemctl enable` is a no-op if already enabled

---

## Troubleshooting

### Common Issues

| Problem | Cause | Fix |
|---------|-------|-----|
| `ModuleNotFoundError: No module named 'boto3'` | Dev deps not installed | Run `pip install -e ".[dev]"` from `kubernetes-app/k8s-bootstrap/` |
| `etcd-backup.sh: Permission denied` | Script not executable | Run `chmod +x system/dr/etcd-backup.sh` |
| S3 upload fails with `AccessDenied` | Instance role missing `s3:PutObject` on `dr-backups/*` | Deploy `control-plane-stack.ts` with updated IAM grants |
| SSM `ParameterNotFound` on restore | No previous backup exists | Expected on first bootstrap — cert-manager will issue a new cert |
| `bash -n` test fails | Syntax error in shell script | Check the error output — it shows the exact line number |
