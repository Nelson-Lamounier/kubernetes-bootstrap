"""Conftest for deploy_helpers tests.

Provides shared fixtures for mocked boto3 SSM clients,
Kubernetes CoreV1Api instances, and DeployConfig objects.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from deploy_helpers.config import DeployConfig


@pytest.fixture()
def deploy_cfg() -> DeployConfig:
    """Return a DeployConfig with test defaults."""
    return DeployConfig(
        ssm_prefix="/k8s/development",
        aws_region="eu-west-1",
        kubeconfig="/tmp/test-kubeconfig",
        s3_bucket="",
        s3_key_prefix="k8s",
        namespace="test-ns",
        dry_run=False,
    )


@pytest.fixture()
def mock_ssm() -> MagicMock:
    """Return a mocked boto3 SSM client."""
    return MagicMock()


@pytest.fixture()
def mock_v1() -> MagicMock:
    """Return a mocked Kubernetes CoreV1Api."""
    return MagicMock()
