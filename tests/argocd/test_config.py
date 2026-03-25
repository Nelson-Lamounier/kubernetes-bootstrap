"""Unit tests for ArgoCD bootstrap Config dataclass and parse_args()."""
from __future__ import annotations

import sys
from unittest.mock import patch

from helpers.config import Config, parse_args


class TestConfig:
    """Verify Config dataclass defaults and field types."""

    def test_default_values(self) -> None:
        """Config should have sensible defaults matching the EC2 runtime."""
        cfg = Config()

        assert cfg.env == "development"
        assert cfg.aws_region == "eu-west-1"
        assert cfg.ssm_prefix == "/k8s/development"
        assert cfg.dry_run is False
        assert cfg.argo_timeout == 120
        assert cfg.kubeconfig == "/etc/kubernetes/admin.conf"

    def test_env_derived_from_ssm_prefix(self) -> None:
        """Config.env should be derived from the SSM prefix path."""
        cfg = Config(ssm_prefix="/k8s/staging")
        assert cfg.env == "staging"

        cfg2 = Config(ssm_prefix="/k8s/production")
        assert cfg2.env == "production"

    def test_custom_region_and_timeout(self) -> None:
        """Config should accept custom field values."""
        cfg = Config(
            aws_region="us-east-1",
            dry_run=True,
            argo_timeout=300,
        )

        assert cfg.aws_region == "us-east-1"
        assert cfg.dry_run is True
        assert cfg.argo_timeout == 300


class TestParseArgs:
    """Verify CLI argument parsing."""

    def test_dry_run_flag(self) -> None:
        """--dry-run should set dry_run=True."""
        with patch.object(sys, "argv", ["bootstrap_argocd.py", "--dry-run"]):
            cfg = parse_args()

        assert cfg.dry_run is True

    def test_default_no_dry_run(self) -> None:
        """Without --dry-run, dry_run should default to False."""
        with patch.object(sys, "argv", ["bootstrap_argocd.py"]):
            cfg = parse_args()

        assert cfg.dry_run is False
