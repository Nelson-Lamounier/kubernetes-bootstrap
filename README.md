# kubernetes-bootstrap

Kubernetes cluster bootstrap orchestration — EC2 control-plane initialisation, worker-node joining, and Day-1 system component deployment.

## Repository Purpose

This repository contains the scripts and configuration that run **once** during cluster lifecycle events:

| Concern | Directory | Trigger |
|---------|-----------|---------|
| **EC2 Bootstrap** | `boot/` | Instance launch via SSM Run Command |
| **System Bootstrap** | `system/` | Post-boot SSM automation |
| **Deploy Helpers** | `deploy_helpers/` | Shared Python library for both |
| **CI Scripts** | `scripts/` | TypeScript CI/CD helpers |
| **Tests** | `tests/` | Pytest suite (55+ tests) |

## Architecture

```
kubernetes-bootstrap/
├── boot/                      # EC2 instance bootstrap
│   ├── control_plane.py       # kubeadm init orchestration
│   ├── worker.py              # kubeadm join orchestration
│   └── steps/                 # Modular bootstrap steps
├── system/                    # Day-1 system components
│   ├── argocd/                # ArgoCD install + app-of-apps seed
│   ├── cert-manager/          # TLS certificate lifecycle
│   ├── dr/                    # etcd disaster recovery (S3 snapshots)
│   ├── traefik/               # Ingress controller values
│   ├── argocd-notifications/  # Notification ConfigMap
│   └── arc/                   # GitHub Actions Runner Controller
├── deploy_helpers/            # Shared Python deployment library
│   ├── ssm.py                 # AWS SSM parameter operations
│   ├── k8s.py                 # Kubernetes client helpers
│   ├── s3.py                  # S3 upload/download
│   └── ...
├── scripts/                   # TypeScript CI helpers
├── tests/                     # Pytest suite
│   ├── argocd/                # ArgoCD bootstrap tests
│   ├── boot/                  # EC2 bootstrap tests
│   ├── deploy/                # Deploy helper tests
│   └── system/                # System bootstrap tests
└── pyproject.toml             # Python project configuration
```

## Related Repositories

| Repository | Purpose |
|-----------|---------|
| [`kubernetes-platform`](https://github.com/Nelson-Lamounier/kubernetes-platform) | Platform services (Helm charts, ArgoCD apps, dashboards) — GitOps-managed |
| [`cdk-monitoring`](https://github.com/Nelson-Lamounier/cdk-monitoring) | CDK infrastructure + workload charts |

## Development

### Prerequisites

- Python 3.12+
- kubectl configured for target cluster
- AWS CLI with appropriate credentials

### Run Tests

```bash
# Install dependencies
pip install -e ".[dev]"

# Run the full test suite
pytest tests/ -v

# Run with coverage
pytest tests/ --cov=boot --cov=deploy_helpers --cov=system -v
```

### Linting

```bash
ruff check .
ruff format --check .
```

## Licence

Private — Nelson Lamounier
