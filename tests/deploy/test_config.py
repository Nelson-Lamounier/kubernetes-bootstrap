"""Tests for deploy_helpers.config module."""
from __future__ import annotations

from unittest.mock import patch

import pytest

from deploy_helpers.config import DeployConfig


class TestDeployConfigDefaults:
    """Verify default values are populated from environment."""

    def test_default_ssm_prefix(self, deploy_cfg: DeployConfig) -> None:
        assert deploy_cfg.ssm_prefix == "/k8s/development"

    def test_default_aws_region(self, deploy_cfg: DeployConfig) -> None:
        assert deploy_cfg.aws_region == "eu-west-1"

    def test_default_namespace(self, deploy_cfg: DeployConfig) -> None:
        assert deploy_cfg.namespace == "test-ns"

    def test_dry_run_default_false(self, deploy_cfg: DeployConfig) -> None:
        assert deploy_cfg.dry_run is False

    def test_secrets_default_empty(self, deploy_cfg: DeployConfig) -> None:
        assert deploy_cfg.secrets == {}


class TestDeployConfigEnvOverrides:
    """Verify environment variable overrides work."""

    @patch.dict("os.environ", {"SSM_PREFIX": "/k8s/production"})
    def test_ssm_prefix_from_env(self) -> None:
        cfg = DeployConfig.from_env()
        assert cfg.ssm_prefix == "/k8s/production"

    @patch.dict("os.environ", {"AWS_REGION": "us-east-1"})
    def test_aws_region_from_env(self) -> None:
        cfg = DeployConfig.from_env()
        assert cfg.aws_region == "us-east-1"

    @patch.dict("os.environ", {"KUBECONFIG": "/custom/kubeconfig"})
    def test_kubeconfig_from_env(self) -> None:
        cfg = DeployConfig.from_env()
        assert cfg.kubeconfig == "/custom/kubeconfig"

    @patch.dict("os.environ", {"S3_BUCKET": "my-bucket"})
    def test_s3_bucket_from_env(self) -> None:
        cfg = DeployConfig.from_env()
        assert cfg.s3_bucket == "my-bucket"


class TestDeployConfigBanner:
    """Verify banner prints without errors."""

    def test_print_banner_no_error(self, deploy_cfg: DeployConfig, capsys: pytest.CaptureFixture[str]) -> None:
        deploy_cfg.print_banner("Test Deployment")
        captured = capsys.readouterr()
        assert "Test Deployment" in captured.out
        assert "ssm_prefix" in captured.out
