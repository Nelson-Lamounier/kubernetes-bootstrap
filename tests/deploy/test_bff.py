"""Tests for deploy_helpers.bff — BFF service URL resolution.

Verifies that:
- Both URLs are resolved via the shared resolve_secrets() path (no raw calls).
- Resolution always targets us-east-1 via _make_edge_ssm_client() (KubernetesEdgeStack region).
- In-cluster fallbacks are applied when SSM parameters are missing.
- One URL can be resolved while the other falls back independently.
- Environment variable overrides are honoured (inherited from resolve_secrets).
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from deploy_helpers.bff import (
    BffUrls,
    _EDGE_REGION,
    _FALLBACK_ADMIN_API,
    _FALLBACK_PUBLIC_API,
    resolve_bff_urls,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class MockClientError(Exception):
    """Lightweight mock of botocore.exceptions.ClientError."""

    def __init__(self, code: str = "ParameterNotFound", message: str = "mock error") -> None:
        self.response = {"Error": {"Code": code, "Message": message}}
        super().__init__(message)


def _ssm_returning(values: dict[str, str]) -> MagicMock:
    """Build an SSM mock that returns the given path → value mapping.

    Unknown paths raise MockClientError("ParameterNotFound").

    Args:
        values: Mapping of full SSM parameter path to string value.

    Returns:
        Configured MagicMock for the SSM client.
    """
    client = MagicMock()

    def side_effect(Name: str, WithDecryption: bool = True) -> dict:  # noqa: N803
        if Name in values:
            return {"Parameter": {"Value": values[Name]}}
        raise MockClientError("ParameterNotFound")

    client.get_parameter.side_effect = side_effect
    return client


def _patch_edge_client(ssm_mock: MagicMock):
    """Return a context manager that patches _make_edge_ssm_client to return *ssm_mock*.

    ``resolve_bff_urls`` always calls :func:`deploy_helpers.bff._make_edge_ssm_client`
    to obtain a ``us-east-1`` SSM client.  Patching this factory function lets
    tests inject a mock without requiring real AWS credentials.

    Args:
        ssm_mock: The mock SSM client to return from the factory.

    Returns:
        A ``patch`` context manager.
    """
    return patch("deploy_helpers.bff._make_edge_ssm_client", return_value=ssm_mock)


# ---------------------------------------------------------------------------
# Happy-path tests
# ---------------------------------------------------------------------------


class TestResolveBffUrls:
    """Verify BFF URL resolution when SSM parameters are present."""

    def test_returns_bff_urls_dataclass(self) -> None:
        """resolve_bff_urls() must return a BffUrls instance."""
        ssm = _ssm_returning({
            "/bedrock-dev/admin-api-url": "https://admin.example.com",
            "/bedrock-dev/public-api-url": "https://api.example.com",
        })

        with _patch_edge_client(ssm):
            result = resolve_bff_urls(ssm, "dev", MockClientError)

        assert isinstance(result, BffUrls)

    def test_resolves_both_urls_from_ssm(self) -> None:
        """Both ADMIN_API_URL and PUBLIC_API_URL are resolved from SSM."""
        ssm = _ssm_returning({
            "/bedrock-dev/admin-api-url": "https://admin.example.com",
            "/bedrock-dev/public-api-url": "https://api.example.com",
        })

        with _patch_edge_client(ssm):
            result = resolve_bff_urls(ssm, "dev", MockClientError)

        assert result.admin_api_url == "https://admin.example.com"
        assert result.public_api_url == "https://api.example.com"

    def test_uses_correct_short_env_in_paths(self) -> None:
        """SSM paths must use the short_env prefix /bedrock-{short_env}/."""
        ssm = _ssm_returning({
            "/bedrock-prd/admin-api-url": "https://admin.nelsonlamounier.com",
            "/bedrock-prd/public-api-url": "https://api.nelsonlamounier.com",
        })

        with _patch_edge_client(ssm):
            result = resolve_bff_urls(ssm, "prd", MockClientError)

        assert result.admin_api_url == "https://admin.nelsonlamounier.com"
        assert result.public_api_url == "https://api.nelsonlamounier.com"

    def test_result_is_frozen(self) -> None:
        """BffUrls must be immutable (frozen dataclass)."""
        ssm = _ssm_returning({
            "/bedrock-dev/admin-api-url": "https://admin.example.com",
            "/bedrock-dev/public-api-url": "https://api.example.com",
        })

        with _patch_edge_client(ssm):
            result = resolve_bff_urls(ssm, "dev", MockClientError)

        with pytest.raises(Exception):  # noqa: PT011 — FrozenInstanceError
            result.admin_api_url = "https://other.example.com"  # type: ignore[misc]

    def test_always_uses_us_east_1_region(self) -> None:
        """_make_edge_ssm_client must be called (always targets us-east-1).

        KubernetesEdgeStack is deployed to us-east-1 for CloudFront WAF. All
        /bedrock-*/admin-api-url and /bedrock-*/public-api-url parameters live
        in that region, regardless of the cluster's primary AWS region.
        The _EDGE_REGION constant must equal 'us-east-1'.
        """
        assert _EDGE_REGION == "us-east-1", (
            "_EDGE_REGION must be 'us-east-1' — update only if KubernetesEdgeStack "
            "is moved to a different region."
        )

        ssm = _ssm_returning({})
        factory_mock = MagicMock(return_value=ssm)

        with patch("deploy_helpers.bff._make_edge_ssm_client", factory_mock):
            resolve_bff_urls(ssm, "dev", MockClientError)

        factory_mock.assert_called_once()


# ---------------------------------------------------------------------------
# Fallback tests
# ---------------------------------------------------------------------------


class TestResolveBffUrlsFallbacks:
    """Verify in-cluster fallbacks when SSM parameters are absent."""

    def test_both_fallback_when_ssm_empty(self) -> None:
        """When neither parameter exists, both in-cluster fallbacks are used."""
        ssm = _ssm_returning({})

        with _patch_edge_client(ssm):
            result = resolve_bff_urls(ssm, "dev", MockClientError)

        assert result.admin_api_url == _FALLBACK_ADMIN_API
        assert result.public_api_url == _FALLBACK_PUBLIC_API

    def test_admin_fallback_when_only_public_exists(self) -> None:
        """admin_api_url falls back independently if its SSM param is missing."""
        ssm = _ssm_returning({
            "/bedrock-dev/public-api-url": "https://api.example.com",
        })

        with _patch_edge_client(ssm):
            result = resolve_bff_urls(ssm, "dev", MockClientError)

        assert result.admin_api_url == _FALLBACK_ADMIN_API
        assert result.public_api_url == "https://api.example.com"

    def test_public_fallback_when_only_admin_exists(self) -> None:
        """public_api_url falls back independently if its SSM param is missing."""
        ssm = _ssm_returning({
            "/bedrock-dev/admin-api-url": "https://admin.example.com",
        })

        with _patch_edge_client(ssm):
            result = resolve_bff_urls(ssm, "dev", MockClientError)

        assert result.admin_api_url == "https://admin.example.com"
        assert result.public_api_url == _FALLBACK_PUBLIC_API

    def test_access_denied_triggers_fallback(self) -> None:
        """AccessDeniedException is treated the same as ParameterNotFound."""
        ssm = MagicMock()
        ssm.get_parameter.side_effect = MockClientError("AccessDeniedException")

        with _patch_edge_client(ssm):
            result = resolve_bff_urls(ssm, "dev", MockClientError)

        assert result.admin_api_url == _FALLBACK_ADMIN_API
        assert result.public_api_url == _FALLBACK_PUBLIC_API


# ---------------------------------------------------------------------------
# Env-override tests (inherited from resolve_secrets behaviour)
# ---------------------------------------------------------------------------


class TestResolveBffUrlsEnvOverride:
    """Verify environment variable overrides bypass SSM (via resolve_secrets)."""

    @patch.dict("os.environ", {
        "ADMIN_API_URL": "https://override-admin.example.com",
        "PUBLIC_API_URL": "https://override-public.example.com",
    })
    def test_env_overrides_skip_ssm(self) -> None:
        """Both URLs use env overrides; SSM must not be called."""
        ssm = MagicMock()

        with _patch_edge_client(ssm):
            result = resolve_bff_urls(ssm, "dev", MockClientError)

        assert result.admin_api_url == "https://override-admin.example.com"
        assert result.public_api_url == "https://override-public.example.com"
        ssm.get_parameter.assert_not_called()

    @patch.dict("os.environ", {"ADMIN_API_URL": ""})
    def test_empty_env_is_not_an_override(self) -> None:
        """An empty ADMIN_API_URL must still resolve from SSM."""
        ssm = _ssm_returning({
            "/bedrock-dev/admin-api-url": "https://admin.example.com",
            "/bedrock-dev/public-api-url": "https://api.example.com",
        })

        with _patch_edge_client(ssm):
            result = resolve_bff_urls(ssm, "dev", MockClientError)

        assert result.admin_api_url == "https://admin.example.com"
