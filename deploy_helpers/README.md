# deploy_helpers/ — Shared Deployment Framework

Reusable Python modules for Kubernetes secret provisioning via
SSM Automation pipelines. Extracts duplicated code from app-specific
`deploy.py` scripts into a shared, tested framework.

---

## Why a Shared Framework?

Before this refactoring, two near-identical monolithic scripts existed:

| Script | Before | After | Reduction |
| --- | --- | --- | --- |
| `nextjs/deploy.py` | 408 lines | ~280 lines | 31% |
| `monitoring/deploy.py` | 343 lines | ~170 lines | 50% |

**Duplicated code** (~200 lines): Config dataclass, `_run_cmd`,
`_ensure_namespace`, `_upsert_secret`, logging setup, `main()` flow,
and error handling. Both scripts used plain `%(message)s` logging
(no JSON for CloudWatch) and had zero test coverage.

The shared framework eliminates this duplication while preserving
each script's unique business logic (e.g. DynamoDB/Bedrock fallbacks
in Next.js, Grafana/GitHub exporter config in monitoring).

---

## Architecture

```text
kubernetes-app/k8s-bootstrap/
├── deploy_helpers/                # Shared framework (this directory)
│   ├── __init__.py                # Package marker
│   ├── config.py                  # DeployConfig base dataclass
│   ├── k8s.py                     # Kubernetes namespace + secret helpers
│   ├── logging.py                 # Structured JSON logging
│   ├── runner.py                  # Subprocess wrapper with logging
│   ├── s3.py                      # aws s3 sync helper
│   └── ssm.py                     # SSM → env-var resolver
│
└── tests/deploy/                  # Mocked unit tests (35 tests)
    ├── conftest.py                # Shared fixtures
    ├── test_config.py             # DeployConfig defaults + env overrides
    ├── test_k8s.py                # Namespace + secret idempotency
    ├── test_ssm.py                # SSM resolution + env overrides
    └── test_nextjs_deploy.py      # Bedrock fallback + assets override
```

### Consumer Scripts

| Script | Location | Namespace | Key Logic |
| --- | --- | --- | --- |
| Next.js secrets | `workloads/charts/nextjs/deploy.py` | `nextjs-app` | DynamoDB/Bedrock SSM fallback, assets bucket override |
| Monitoring secrets | `platform/charts/monitoring/deploy.py` | `monitoring` | Grafana admin, GitHub Actions Exporter token |

Both scripts extend `DeployConfig` with app-specific fields, import
shared helpers, and define only their unique resolution/assembly logic.

---

## Module Reference

### `config.py` — Base Configuration

`DeployConfig` dataclass with standard deployment fields:

| Field | Default | Env Override |
| --- | --- | --- |
| `ssm_prefix` | `/k8s/development` | `SSM_PREFIX` |
| `aws_region` | `eu-west-1` | `AWS_REGION` |
| `kubeconfig` | `/etc/kubernetes/admin.conf` | `KUBECONFIG` |
| `s3_bucket` | `""` | `S3_BUCKET` |
| `s3_key_prefix` | `k8s` | `S3_KEY_PREFIX` |
| `namespace` | `default` | — |
| `dry_run` | `False` | `--dry-run` CLI arg |

Factory method `from_env()` reads all environment variables.
`print_banner()` logs the active configuration on startup.

### `ssm.py` — SSM Parameter Resolution

`resolve_secrets(ssm_client, prefix, secret_map)` — iterates a
`{param_suffix: ENV_VAR}` mapping:

1. Checks for an **environment variable override** first
2. Skips placeholder values (`__VAR__`, `${VAR}`) — these are not overrides
3. Fetches from SSM with `WithDecryption=True` if no override
4. Logs warnings (not errors) for `ParameterNotFound` — allows partial resolution

### `k8s.py` — Kubernetes Operations

All operations are **idempotent** — safe to re-run at any time:

- `load_k8s(kubeconfig)` — lazy-imports `kubernetes` and loads kubeconfig
- `ensure_namespace(v1, namespace)` — creates on 404, no-ops on exists
- `upsert_secret(v1, name, namespace, data)` — creates new, or replaces
  existing on 409 Conflict. Values are base64-encoded automatically.

### `logging.py` — Structured JSON Logging

`log_info`, `log_warn`, `log_error` — emit single-line JSON to stdout:

```json
{"timestamp": "2026-03-25T11:45:40Z", "level": "INFO", "message": "Resolved from SSM", "env_var": "GRAFANA_ADMIN_PASSWORD"}
```

Designed for CloudWatch Logs parsing and SSM Automation output.

### `runner.py` — Subprocess Wrapper

`run_cmd(cmd, check)` — runs shell commands with structured log output
for both stdout and stderr capture.

### `s3.py` — S3 Synchronisation

`sync_from_s3(bucket, key_prefix, target_dir, region)` — wraps
`aws s3 sync` CLI for bootstrap script re-synchronisation on EC2.

---

## Local Development Setup

> **Note:** If you are new to Python, follow these steps carefully.
> The project uses standard Python tooling (`pip`, `pyproject.toml`, `pytest`)
> that work the same way on macOS and Linux.

### Prerequisites

| Tool | Version | Check with |
| --- | --- | --- |
| Python | ≥ 3.9 | `python3 --version` |
| pip | bundled with Python | `pip --version` |
| just | any | `just --version` |

### First-Time Setup

#### 1. Create a Virtual Environment

```bash
cd kubernetes-app/k8s-bootstrap
python3 -m venv .venv
```

#### 2. Activate the Virtual Environment

```bash
source .venv/bin/activate
```

When active, your terminal prompt shows `(.venv)`. To deactivate: `deactivate`

#### 3. Install Dependencies

```bash
# -e = "editable" — source changes take effect immediately
# [dev] = also install test tools (pytest, ruff, pyyaml)
pip install -e ".[dev]"
```

#### 4. Verify the Setup

```bash
which python               # Should show: .../k8s-bootstrap/.venv/bin/python
python -m pytest --version  # Confirm pytest is installed
python -m pytest tests/deploy/ -v  # Quick smoke test
```

---

## Testing

### How Tests Are Designed

All tests use `unittest.mock` to simulate external dependencies
(`boto3.client`, `kubernetes.client.CoreV1Api`, `subprocess.run`).
No real AWS or Kubernetes credentials are required.

**Test categories:**

| File | Tests | Coverage |
| --- | --- | --- |
| `test_config.py` | 10 | Default values, env var overrides, banner output |
| `test_k8s.py` | 7 | Namespace create/exists (404), secret create/replace (409), base64 encoding |
| `test_ssm.py` | 7 | SSM resolution, `ParameterNotFound` handling, env overrides, placeholder detection |
| `test_nextjs_deploy.py` | 11 | `NextjsConfig` properties, DynamoDB Bedrock fallback, assets bucket override |

### Running Tests Locally

```bash
# Run all deploy tests (35 tests, <1 second)
just deploy-test-local

# Run a specific test file
just deploy-test-local test_ssm.py

# Run a single test by name
just deploy-test-local -k "test_upsert"

# Run with extra verbose output
just deploy-test-local -vv
```

> **Tip:** The `just deploy-test-local` recipe simply runs
> `cd kubernetes-app/k8s-bootstrap && python -m pytest tests/deploy/ -v <args>`.
> You can also run `python -m pytest` directly from `kubernetes-app/k8s-bootstrap/`.

### On-Instance Testing (SSM)

For live testing on a control plane instance via SSM RunCommand:

```bash
# Deploy Next.js secrets (dry-run)
just deploy-test-live i-0f1491fd3dc63fd66 nextjs

# Deploy monitoring secrets (dry-run)
just deploy-test-live i-0f1491fd3dc63fd66 monitoring

# Real deployment (no dry-run)
just deploy-test-live i-0f1491fd3dc63fd66 nextjs --no-dry-run
```

---

## EC2 Runtime

On the control plane instance, SSM Automation syncs scripts from S3:

```text
/data/k8s-bootstrap/deploy_helpers/   ← shared framework
/data/app-deploy/nextjs/deploy.py     ← adds /data/k8s-bootstrap to sys.path
/data/app-deploy/monitoring/deploy.py ← adds /data/k8s-bootstrap to sys.path
```

Both `deploy.py` scripts insert `/data/k8s-bootstrap` into `sys.path`
at runtime via `Path(__file__).resolve().parents[2] / "k8s-bootstrap"`.
This can be overridden with the `DEPLOY_HELPERS_PATH` environment variable.

---

## IAM Permissions

The control plane instance role requires:

| Permission | Resource | Purpose |
| --- | --- | --- |
| `ssm:GetParameter` | `/k8s/*/...`, `/nextjs/*/...` | Resolve secrets from SSM |
| `ssm:GetParameter` | `/bedrock-*/...` | Bedrock fallback resolution |
| `s3:GetObject` | `<bucket>/k8s-bootstrap/*` | Download `deploy_helpers/` |
| `s3:GetObject` | `<bucket>/app-deploy/*` | Download `deploy.py` scripts |

These grants are defined in `control-plane-stack.ts` via CDK.

---

## Troubleshooting

### Common Issues

| Problem | Cause | Fix |
| --- | --- | --- |
| `ModuleNotFoundError: No module named 'deploy_helpers'` | `sys.path` not set | Run from `k8s-bootstrap/` or set `DEPLOY_HELPERS_PATH` |
| `ModuleNotFoundError: No module named 'kubernetes'` | Dev deps missing | Run `pip install -e ".[dev]"` from `k8s-bootstrap/` |
| `ParameterNotFound` for all secrets | Wrong `SSM_PREFIX` | Check `SSM_PREFIX` matches actual SSM hierarchy |
| Test fails with real env leak | `GITHUB_TOKEN` in shell | Tests use `@patch.dict` to isolate; ensure CI has clean env |
| Deploy fails with 409 | Secret already exists | Expected — `upsert_secret` handles this via replace |
