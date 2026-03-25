"""Tests for nextjs deploy.py app-specific logic."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

import sys
import os

# Ensure deploy_helpers is importable
_BOOTSTRAP_DIR = str(os.path.join(os.path.dirname(__file__), "..", ".."))
if _BOOTSTRAP_DIR not in sys.path:
    sys.path.insert(0, _BOOTSTRAP_DIR)

# We need to add the nextjs deploy module to sys.path as well
# tests/deploy/ → k8s-bootstrap/ → kubernetes-app/ (3 levels up)
_NEXTJS_DIR = str(
    os.path.join(
        os.path.dirname(__file__), "..", "..", "..",
        "workloads", "charts", "nextjs",
    )
)
if _NEXTJS_DIR not in sys.path:
    sys.path.insert(0, _NEXTJS_DIR)


# ---------------------------------------------------------------------------
# Mock ClientError
# ---------------------------------------------------------------------------

class MockClientError(Exception):
    """Lightweight mock of botocore.exceptions.ClientError."""

    def __init__(self, code: str = "ParameterNotFound") -> None:
        self.response = {"Error": {"Code": code}}
        super().__init__(code)


# ---------------------------------------------------------------------------
# Tests: NextjsConfig
# ---------------------------------------------------------------------------


class TestNextjsConfig:
    """Verify NextjsConfig properties and derived values."""

    def test_frontend_ssm_prefix_derived(self) -> None:
        """frontend_ssm_prefix is derived from ssm_prefix."""
        # Need to import after sys.path is set
        from deploy import NextjsConfig

        cfg = NextjsConfig(ssm_prefix="/k8s/development")
        assert cfg.frontend_ssm_prefix == "/nextjs/development"

    def test_frontend_ssm_prefix_production(self) -> None:
        from deploy import NextjsConfig

        cfg = NextjsConfig(ssm_prefix="/k8s/production")
        assert cfg.frontend_ssm_prefix == "/nextjs/production"

    @patch.dict("os.environ", {"FRONTEND_SSM_PREFIX": "/custom/prefix"})
    def test_frontend_ssm_prefix_env_override(self) -> None:
        from deploy import NextjsConfig

        cfg = NextjsConfig(ssm_prefix="/k8s/development")
        assert cfg.frontend_ssm_prefix == "/custom/prefix"

    def test_environment_name(self) -> None:
        from deploy import NextjsConfig

        cfg = NextjsConfig(ssm_prefix="/k8s/staging")
        assert cfg.environment_name == "staging"

    def test_short_env_development(self) -> None:
        from deploy import NextjsConfig

        cfg = NextjsConfig(ssm_prefix="/k8s/development")
        assert cfg.short_env == "dev"

    def test_short_env_production(self) -> None:
        from deploy import NextjsConfig

        cfg = NextjsConfig(ssm_prefix="/k8s/production")
        assert cfg.short_env == "prd"

    def test_short_env_unknown(self) -> None:
        from deploy import NextjsConfig

        cfg = NextjsConfig(ssm_prefix="/k8s/custom-env")
        assert cfg.short_env == "custom-env"

    def test_default_namespace(self) -> None:
        from deploy import NextjsConfig

        cfg = NextjsConfig()
        assert cfg.namespace == "nextjs-app"


# ---------------------------------------------------------------------------
# Tests: resolve_nextjs_secrets
# ---------------------------------------------------------------------------


class TestResolveNextjsSecrets:
    """Verify app-specific SSM resolution with Bedrock fallbacks."""

    def test_dynamodb_bedrock_fallback(self) -> None:
        """Falls back to bedrock SSM path when nextjs path missing."""
        from deploy import NextjsConfig, resolve_nextjs_secrets

        cfg = NextjsConfig(ssm_prefix="/k8s/development")
        mock_ssm = MagicMock()

        # First set of calls: standard resolve (all fail except NEXTAUTH_SECRET)
        # Then bedrock fallback for DynamoDB
        def get_parameter_side_effect(**kwargs: str) -> dict:
            name = kwargs["Name"]
            if name == "/bedrock-dev/content-table-name":
                return {"Parameter": {"Value": "bedrock-content-table"}}
            if name == "/bedrock-dev/assets-bucket-name":
                return {"Parameter": {"Value": "bedrock-assets-bucket"}}
            raise MockClientError("ParameterNotFound")

        mock_ssm.get_parameter.side_effect = get_parameter_side_effect

        secrets = resolve_nextjs_secrets(cfg, mock_ssm, MockClientError)

        assert secrets["DYNAMODB_TABLE_NAME"] == "bedrock-content-table"

    def test_assets_bucket_bedrock_override(self) -> None:
        """Bedrock assets-bucket-name overrides resolved value."""
        from deploy import NextjsConfig, resolve_nextjs_secrets

        cfg = NextjsConfig(ssm_prefix="/k8s/development")
        mock_ssm = MagicMock()

        def get_parameter_side_effect(**kwargs: str) -> dict:
            name = kwargs["Name"]
            if name == "/nextjs/development/assets-bucket-name":
                return {"Parameter": {"Value": "legacy-bucket"}}
            if name == "/bedrock-dev/content-table-name":
                raise MockClientError("ParameterNotFound")
            if name == "/bedrock-dev/assets-bucket-name":
                return {"Parameter": {"Value": "bedrock-data-bucket"}}
            raise MockClientError("ParameterNotFound")

        mock_ssm.get_parameter.side_effect = get_parameter_side_effect

        secrets = resolve_nextjs_secrets(cfg, mock_ssm, MockClientError)

        assert secrets["ASSETS_BUCKET_NAME"] == "bedrock-data-bucket"

    def test_no_bedrock_override_keeps_original(self) -> None:
        """Keeps original value when Bedrock fallback also fails."""
        from deploy import NextjsConfig, resolve_nextjs_secrets

        cfg = NextjsConfig(ssm_prefix="/k8s/development")
        mock_ssm = MagicMock()

        def get_parameter_side_effect(**kwargs: str) -> dict:
            name = kwargs["Name"]
            if name == "/nextjs/development/assets-bucket-name":
                return {"Parameter": {"Value": "original-bucket"}}
            if name == "/nextjs/development/dynamodb-table-name":
                return {"Parameter": {"Value": "original-table"}}
            raise MockClientError("ParameterNotFound")

        mock_ssm.get_parameter.side_effect = get_parameter_side_effect

        secrets = resolve_nextjs_secrets(cfg, mock_ssm, MockClientError)

        assert secrets["DYNAMODB_TABLE_NAME"] == "original-table"
        # When bedrock fallback fails, original value preserved
        assert secrets["ASSETS_BUCKET_NAME"] == "original-bucket"
