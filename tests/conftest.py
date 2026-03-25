"""Shared pytest fixtures for k8s-bootstrap tests."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest


@pytest.fixture()
def mock_cfg() -> MagicMock:
    """Return a mock Config dataclass with sensible defaults for testing."""
    cfg = MagicMock()
    cfg.dry_run = True
    cfg.env = "development"
    cfg.aws_region = "eu-west-1"
    cfg.ssm_prefix = "/k8s/development"
    cfg.argocd_dir = "/data/k8s-bootstrap/system/argocd"
    cfg.kubeconfig = "/etc/kubernetes/admin.conf"
    cfg.argocd_cli_version = "v2.14.11"
    cfg.argo_timeout = 120
    return cfg
