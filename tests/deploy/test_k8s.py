"""Tests for deploy_helpers.k8s module."""
from __future__ import annotations

import base64
from unittest.mock import MagicMock, patch

import pytest

# We need to mock the kubernetes module before importing k8s helpers.
# The k8s module uses a module-level _k8s_client variable that gets set
# when load_k8s() is called. For tests, we patch it directly.


# ---------------------------------------------------------------------------
# Mock kubernetes module
# ---------------------------------------------------------------------------

class MockApiException(Exception):
    """Lightweight mock of kubernetes.client.ApiException."""

    def __init__(self, status: int = 500) -> None:
        self.status = status
        super().__init__(f"Mock ApiException {status}")


class MockV1Namespace:
    """Mock of kubernetes.client.V1Namespace."""

    def __init__(self, metadata: object = None) -> None:
        self.metadata = metadata


class MockV1ObjectMeta:
    """Mock of kubernetes.client.V1ObjectMeta."""

    def __init__(self, name: str = "", namespace: str = "") -> None:
        self.name = name
        self.namespace = namespace


class MockV1Secret:
    """Mock of kubernetes.client.V1Secret."""

    def __init__(
        self,
        metadata: object = None,
        type: str = "Opaque",
        data: dict[str, str] | None = None,
    ) -> None:
        self.metadata = metadata
        self.type = type
        self.data = data


class MockK8sClient:
    """Mock of kubernetes.client module."""

    ApiException = MockApiException
    V1Namespace = MockV1Namespace
    V1ObjectMeta = MockV1ObjectMeta
    V1Secret = MockV1Secret
    CoreV1Api = MagicMock


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestEnsureNamespace:
    """Verify idempotent namespace creation."""

    def test_namespace_already_exists(self, mock_v1: MagicMock) -> None:
        """No-op when namespace already exists."""
        import deploy_helpers.k8s as k8s_mod

        k8s_mod._k8s_client = MockK8sClient()
        mock_v1.read_namespace.return_value = MagicMock()

        k8s_mod.ensure_namespace(mock_v1, "existing-ns")

        mock_v1.read_namespace.assert_called_once_with(name="existing-ns")
        mock_v1.create_namespace.assert_not_called()

    def test_namespace_created_on_404(self, mock_v1: MagicMock) -> None:
        """Creates namespace when 404 Not Found."""
        import deploy_helpers.k8s as k8s_mod

        k8s_mod._k8s_client = MockK8sClient()
        mock_v1.read_namespace.side_effect = MockApiException(status=404)

        k8s_mod.ensure_namespace(mock_v1, "new-ns")

        mock_v1.create_namespace.assert_called_once()

    def test_namespace_reraises_non_404(self, mock_v1: MagicMock) -> None:
        """Re-raises non-404 exceptions."""
        import deploy_helpers.k8s as k8s_mod

        k8s_mod._k8s_client = MockK8sClient()
        mock_v1.read_namespace.side_effect = MockApiException(status=403)

        with pytest.raises(MockApiException):
            k8s_mod.ensure_namespace(mock_v1, "forbidden-ns")


class TestUpsertSecret:
    """Verify idempotent secret create/replace."""

    def test_creates_new_secret(self, mock_v1: MagicMock) -> None:
        """Creates secret when it does not exist."""
        import deploy_helpers.k8s as k8s_mod

        k8s_mod._k8s_client = MockK8sClient()
        mock_v1.create_namespaced_secret.return_value = MagicMock()

        k8s_mod.upsert_secret(mock_v1, "test-secret", "test-ns", {"KEY": "value"})

        mock_v1.create_namespaced_secret.assert_called_once()
        call_kwargs = mock_v1.create_namespaced_secret.call_args
        assert call_kwargs.kwargs["namespace"] == "test-ns"

    def test_replaces_existing_on_409(self, mock_v1: MagicMock) -> None:
        """Falls back to replace on 409 Conflict."""
        import deploy_helpers.k8s as k8s_mod

        k8s_mod._k8s_client = MockK8sClient()
        mock_v1.create_namespaced_secret.side_effect = MockApiException(status=409)
        mock_v1.replace_namespaced_secret.return_value = MagicMock()

        k8s_mod.upsert_secret(mock_v1, "existing-secret", "test-ns", {"KEY": "new-value"})

        mock_v1.replace_namespaced_secret.assert_called_once()
        call_kwargs = mock_v1.replace_namespaced_secret.call_args
        assert call_kwargs.kwargs["name"] == "existing-secret"

    def test_reraises_non_409(self, mock_v1: MagicMock) -> None:
        """Re-raises non-409 exceptions."""
        import deploy_helpers.k8s as k8s_mod

        k8s_mod._k8s_client = MockK8sClient()
        mock_v1.create_namespaced_secret.side_effect = MockApiException(status=500)

        with pytest.raises(MockApiException):
            k8s_mod.upsert_secret(mock_v1, "broken-secret", "test-ns", {"KEY": "value"})

    def test_base64_encodes_values(self, mock_v1: MagicMock) -> None:
        """Verifies data values are base64-encoded."""
        import deploy_helpers.k8s as k8s_mod

        k8s_mod._k8s_client = MockK8sClient()
        mock_v1.create_namespaced_secret.return_value = MagicMock()

        k8s_mod.upsert_secret(mock_v1, "enc-secret", "test-ns", {"PASSWORD": "s3cr3t"})

        call_args = mock_v1.create_namespaced_secret.call_args
        secret_body = call_args.kwargs["body"]
        expected = base64.b64encode(b"s3cr3t").decode()
        assert secret_body.data["PASSWORD"] == expected
