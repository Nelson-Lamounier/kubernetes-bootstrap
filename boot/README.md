# boot/ — Kubernetes Node Bootstrap Scripts

Orchestrates control plane and worker node bootstrap via SSM Automation.
These scripts run on bare EC2 instances during initial setup and instance
replacement, transforming them into fully operational Kubernetes nodes.

---

## Why Python?

The bootstrap scripts are written in **Python** because they need to:

- **Call AWS APIs** (EC2, SSM, Route 53, S3) via `boto3` — volume attachment,
  DNS record management, and SSM parameter reads require structured error handling
  that is impractical with `aws cli` exit code parsing.
- **Manage Kubernetes state** — kubeadm token generation, CA certificate hashing,
  and kubectl operations produce JSON output that needs structured parsing.
- **Enforce idempotency** — the `StepRunner` context manager uses marker files
  to track step completion, preventing re-execution on retry. This pattern is
  cleaner in Python's `with` statement than in shell.
- **Support testability** — each step is a standalone function accepting a
  `BootConfig` dataclass, testable with `pytest` and `unittest.mock`.

---

## Architecture

### Modular Design

The original monolithic `control_plane.py` (1,431 lines) and `worker.py`
(641 lines) have been refactored into independently testable step modules:

```text
boot/steps/
├── boot_helpers/           # Shared configuration
│   ├── __init__.py
│   └── config.py           # BootConfig dataclass — single source of truth for env vars
│
├── common.py               # StepRunner, logging, AMI validation, CloudWatch agent
│
├── cp/                     # Control plane steps (10 modules)
│   ├── __init__.py          # Step orchestrator → main()
│   ├── ebs_volume.py        # Step 0: Attach + format EBS data volume
│   ├── dr_restore.py        # Step 2: Restore etcd snapshot + certs from S3
│   ├── kubeadm_init.py      # Step 3: kubeadm init + DNS + cert backup
│   ├── calico.py            # Step 4: Install Calico CNI
│   ├── ccm.py               # Step 4b: Install AWS Cloud Controller Manager
│   ├── kubectl_access.py    # Step 5: Configure kubectl for ubuntu / root
│   ├── s3_sync.py           # Step 6: Sync manifests from S3
│   ├── argocd.py            # Step 7: Trigger ArgoCD bootstrap
│   ├── verify.py            # Step 8: Cluster health verification
│   └── etcd_backup.py       # Step 10: Install etcd backup systemd timer
│
├── wk/                     # Worker steps (3 modules)
│   ├── __init__.py          # Step orchestrator → main()
│   ├── join_cluster.py      # Step 2: kubeadm join (with CA re-join logic)
│   ├── eip.py               # Step 4: Associate Elastic IP
│   └── stale_pvs.py         # Step 5: Clean stale PersistentVolumes
│
├── control_plane.py         # SSM entry point (preserved for compatibility)
├── worker.py                # SSM entry point (preserved for compatibility)
└── orchestrator.py          # CLI dispatcher for control_plane / worker
```

### Entry Point Compatibility

SSM Automation executes `python3 control_plane.py` or `python3 worker.py`
from `/data/k8s-bootstrap/boot/steps/`. The original entry point files are
preserved and delegate to the modular `cp.main()` / `wk.main()` functions.

### Execution Order

**Control Plane** (`cp/__init__.py`):

```text
Step 0:  Attach + format EBS volume         → ebs_volume.py
Step 2:  Restore etcd + certs (DR)          → dr_restore.py
Step 3:  kubeadm init + DNS + SSM publish   → kubeadm_init.py
Step 4:  Install Calico CNI                 → calico.py
Step 4b: Install AWS Cloud Controller Mgr   → ccm.py
Step 5:  Configure kubectl access           → kubectl_access.py
Step 6:  S3 manifest sync                   → s3_sync.py
Step 7:  ArgoCD bootstrap                   → argocd.py
Step 8:  Cluster health verification        → verify.py
Step 10: etcd backup timer                  → etcd_backup.py
```

**Worker** (`wk/__init__.py`):

```text
Step 1:  Validate AMI                       → common.py
Step 2:  kubeadm join cluster               → join_cluster.py
Step 3:  Install CloudWatch agent           → common.py
Step 4:  Associate Elastic IP               → eip.py
Step 5:  Clean stale PersistentVolumes      → stale_pvs.py
```

---

## Component Reference

### `boot_helpers/config.py` — BootConfig

A Python `dataclass` that consolidates all environment variables into a single
typed object. Every field has a sensible default for the development environment.

| Field | Env Var | Default |
|-------|---------|---------|
| `ssm_prefix` | `SSM_PREFIX` | `/k8s/development` |
| `aws_region` | `AWS_REGION` | `eu-west-1` |
| `k8s_version` | `K8S_VERSION` | `1.35.1` |
| `data_dir` | `DATA_DIR` | `/data/kubernetes` |
| `pod_cidr` | `POD_CIDR` | `192.168.0.0/16` |
| `service_cidr` | `SERVICE_CIDR` | `10.96.0.0/12` |
| `api_dns_name` | `API_DNS_NAME` | `k8s-api.k8s.internal` |
| `s3_bucket` | `S3_BUCKET` | *(empty)* |
| `mount_point` | `MOUNT_POINT` | `/data` |
| `volume_id` | `VOLUME_ID` | *(empty)* |
| `calico_version` | `CALICO_VERSION` | `v3.29.3` |
| `environment` | `ENVIRONMENT` | `development` |
| `node_label` | `NODE_LABEL` | `role=worker` |
| `join_max_retries` | `JOIN_MAX_RETRIES` | `10` |
| `join_retry_interval` | `JOIN_RETRY_INTERVAL` | `30` |

Usage:

```python
from boot_helpers.config import BootConfig

cfg = BootConfig.from_env()
print(cfg.ssm_prefix)   # /k8s/development
print(cfg.aws_region)    # eu-west-1
```

### `common.py` — Shared Utilities

| Component | Purpose |
|-----------|---------|
| `StepRunner` | Context manager for idempotent step execution. Creates marker files under `/var/run/k8s-bootstrap/` to skip completed steps on retry. |
| `run_cmd()` | Shell command wrapper with structured logging + dry-run support |
| `step_validate_ami()` | Verifies the EC2 AMI has required packages (kubeadm, kubectl, kubelet) |
| `step_install_cloudwatch_agent()` | Configures + starts the CloudWatch agent on the node |

### `cp/` — Control Plane Steps

| Module | Purpose |
|--------|---------|
| `ebs_volume.py` | Attaches the persistent EBS volume to the instance, resolves NVMe device names (Nitro instances), formats with ext4 if blank, mounts to `/data`, creates subdirectories |
| `dr_restore.py` | Checks S3 for etcd snapshot + certificate archive; restores before kubeadm init |
| `kubeadm_init.py` | Runs `kubeadm init`, publishes join token + CA hash to SSM, creates Route 53 DNS record, backs up certs to SSM |
| `calico.py` | Applies Calico CRDs + operator manifest via `kubectl apply` |
| `ccm.py` | Installs AWS Cloud Controller Manager via `helm upgrade --install` |
| `kubectl_access.py` | Copies admin.conf to `~ubuntu/.kube/config` and `/root/.kube/config` |
| `s3_sync.py` | Syncs manifests from S3 to the local `/data/k8s-bootstrap/` directory |
| `argocd.py` | Delegates to the `system/argocd` bootstrap script |
| `verify.py` | Polls `kubectl get nodes` + `kubectl get pods -A` until the cluster is healthy |
| `etcd_backup.py` | Runs `install-etcd-backup-timer.sh` to enable the systemd backup timer |

### `wk/` — Worker Steps

| Module | Purpose |
|--------|---------|
| `join_cluster.py` | Fetches the join token + CA hash from SSM, resolves the control plane endpoint, runs `kubeadm join` with retry. Includes CA mismatch detection: if the local CA doesn't match SSM, it runs `kubeadm reset` before re-joining |
| `eip.py` | Associates an Elastic IP to the worker instance via the EC2 API |
| `stale_pvs.py` | Identifies PersistentVolumes bound to nodes that no longer exist in the cluster and deletes them to free storage |

---

## Idempotency

Every step uses the `StepRunner` context manager which:

1. **Creates a marker file** (e.g. `/var/run/k8s-bootstrap/step-03-kubeadm-init.done`)
   on successful completion.
2. **Skips execution** if the marker file already exists.
3. **Removes the marker** on failure, allowing automatic retry.

This ensures safe re-runs during SSM Automation retries or instance replacement.

---

## Local Development

> **Note:** If you are new to Python, see `system/README.md` for a detailed
> first-time setup guide covering virtual environments and `pip install`.

### Quick Start

```bash
cd kubernetes-app/k8s-bootstrap

# Create and activate virtual environment (first time only)
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -e ".[dev]"
```

### Running Tests

The boot test suite is fully mocked — no AWS credentials or Kubernetes cluster
required. All tests run offline in ~0.1 seconds.

```bash
# Run all boot tests (35 tests)
python -m pytest tests/boot/ -v

# Run a specific test file
python -m pytest tests/boot/test_ebs_volume.py -v

# Run a single test by name
python -m pytest tests/boot/ -k "test_returns_nvme_device"

# Run all tests (boot + argocd + system)
python -m pytest -v
```

Or using the justfile:

```bash
just bootstrap-pytest tests/boot/
```

### Test Coverage

| Test File | Tests | What It Covers |
|-----------|-------|----------------|
| `test_config.py` | 7 | BootConfig defaults, env var overrides, property methods |
| `test_ebs_volume.py` | 11 | NVMe device resolution, volume state parsing, format-if-needed, directory creation |
| `test_join_cluster.py` | 9 | CA hash computation, CA mismatch detection + reset, control plane endpoint resolution, kubelet readiness |
| `test_stale_pvs.py` | 8 | Cluster node discovery, stale PV identification, namespace filtering, error handling |

**Test design:**

- All external calls (`subprocess.run`, `boto3`, `requests`) are mocked
- Each test file focuses on one step module
- Tests exercise both happy paths and error cases (timeouts, API failures, invalid JSON)

### Import Collision Note

The `boot/` and `system/argocd/` packages both originally had a `helpers/config.py`
module. To avoid pytest import collisions, the boot version was renamed to
`boot_helpers/`. The `pyproject.toml` pythonpath includes both `boot/steps` and
`system/argocd`, and the unique names prevent conflicts.

---

## SSM Automation Integration

The SSM Automation document (`infra/lib/constructs/ssm/automation-document.ts`)
syncs the entire `boot/steps/` directory from S3, then executes:

```bash
# Control plane
cd /data/k8s-bootstrap/boot/steps && python3 control_plane.py

# Worker
cd /data/k8s-bootstrap/boot/steps && python3 worker.py
```

The original entry point files (`control_plane.py`, `worker.py`) delegate to
`cp.main()` and `wk.main()` respectively.

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `ModuleNotFoundError: No module named 'boot_helpers'` | `boot/steps` not in pythonpath | Run `pip install -e ".[dev]"` or add `boot/steps` to `pythonpath` in `pyproject.toml` |
| `ModuleNotFoundError: No module named 'common'` | Running from wrong directory | Execute from `boot/steps/` or ensure `boot/steps` is in `PYTHONPATH` |
| `StepRunner marker exists` | Step already completed | Delete `/var/run/k8s-bootstrap/step-*.done` to re-run |
| `volume_id is empty` | `VOLUME_ID` env var not set | Set via EC2 user-data or SSM Automation parameters |
| `kubeadm join: CA mismatch` | Control plane rebuilt with new CA | The join step auto-detects this and runs `kubeadm reset` before retrying |
| Boot tests fail with `helpers.config` import error | Old `__pycache__` cached | Delete `__pycache__` dirs and re-run: `find . -name __pycache__ -exec rm -rf {} +` |
