"""Tests for deploy_helpers.ssm module."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from deploy_helpers.ssm import resolve_secrets


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

TEST_SECRET_MAP: dict[str, str] = {
    "grafana-admin-password": "GRAFANA_ADMIN_PASSWORD",
    "github-token": "GITHUB_TOKEN",
}


class MockClientError(Exception):
    """Lightweight mock of botocore.exceptions.ClientError."""

    def __init__(self, code: str, message: str = "mock error") -> None:
        self.response = {"Error": {"Code": code, "Message": message}}
        super().__init__(message)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestResolveSecretsFromSSM:
    """Verify SSM parameter resolution from mocked boto3 client."""

    def test_resolves_single_parameter(self, mock_ssm: MagicMock) -> None:
        mock_ssm.get_parameter.return_value = {
            "Parameter": {"Value": "super-secret-password"},
        }

        secrets = resolve_secrets(
            mock_ssm, "/k8s/development", {"grafana-admin-password": "GRAFANA_ADMIN_PASSWORD"},
        )

        assert secrets["GRAFANA_ADMIN_PASSWORD"] == "super-secret-password"
        mock_ssm.get_parameter.assert_called_once_with(
            Name="/k8s/development/grafana-admin-password",
            WithDecryption=True,
        )

    @patch.dict("os.environ", {"GRAFANA_ADMIN_PASSWORD": "", "GITHUB_TOKEN": ""})
    def test_resolves_multiple_parameters(self, mock_ssm: MagicMock) -> None:
        mock_ssm.get_parameter.side_effect = [
            {"Parameter": {"Value": "grafana-pw"}},
            {"Parameter": {"Value": "gh-token-123"}},
        ]

        secrets = resolve_secrets(mock_ssm, "/k8s/development", TEST_SECRET_MAP)

        assert len(secrets) == 2
        assert secrets["GRAFANA_ADMIN_PASSWORD"] == "grafana-pw"
        assert secrets["GITHUB_TOKEN"] == "gh-token-123"

    def test_handles_parameter_not_found(self, mock_ssm: MagicMock) -> None:
        mock_ssm.get_parameter.side_effect = MockClientError("ParameterNotFound")

        secrets = resolve_secrets(
            mock_ssm,
            "/k8s/development",
            {"missing-param": "MISSING_VAR"},
            client_error_cls=MockClientError,
        )

        assert "MISSING_VAR" not in secrets

    def test_handles_generic_ssm_error(self, mock_ssm: MagicMock) -> None:
        mock_ssm.get_parameter.side_effect = MockClientError("AccessDeniedException")

        secrets = resolve_secrets(
            mock_ssm,
            "/k8s/development",
            {"restricted-param": "RESTRICTED_VAR"},
            client_error_cls=MockClientError,
        )

        assert "RESTRICTED_VAR" not in secrets


class TestResolveSecretsEnvOverride:
    """Verify environment variable overrides bypass SSM."""

    @patch.dict("os.environ", {"GRAFANA_ADMIN_PASSWORD": "env-override-value"})
    def test_env_override_skips_ssm(self, mock_ssm: MagicMock) -> None:
        secrets = resolve_secrets(
            mock_ssm,
            "/k8s/development",
            {"grafana-admin-password": "GRAFANA_ADMIN_PASSWORD"},
        )

        assert secrets["GRAFANA_ADMIN_PASSWORD"] == "env-override-value"
        mock_ssm.get_parameter.assert_not_called()

    @patch.dict("os.environ", {"GRAFANA_ADMIN_PASSWORD": "__GRAFANA_ADMIN_PASSWORD__"})
    def test_placeholder_value_is_not_override(self, mock_ssm: MagicMock) -> None:
        """Placeholder values like __VAR__ should NOT be treated as overrides."""
        mock_ssm.get_parameter.return_value = {
            "Parameter": {"Value": "real-value-from-ssm"},
        }

        secrets = resolve_secrets(
            mock_ssm,
            "/k8s/development",
            {"grafana-admin-password": "GRAFANA_ADMIN_PASSWORD"},
        )

        assert secrets["GRAFANA_ADMIN_PASSWORD"] == "real-value-from-ssm"
        mock_ssm.get_parameter.assert_called_once()

    @patch.dict("os.environ", {"GRAFANA_ADMIN_PASSWORD": ""})
    def test_empty_env_is_not_override(self, mock_ssm: MagicMock) -> None:
        """Empty string should NOT be treated as an override."""
        mock_ssm.get_parameter.return_value = {
            "Parameter": {"Value": "ssm-value"},
        }

        secrets = resolve_secrets(
            mock_ssm,
            "/k8s/development",
            {"grafana-admin-password": "GRAFANA_ADMIN_PASSWORD"},
        )

        assert secrets["GRAFANA_ADMIN_PASSWORD"] == "ssm-value"
