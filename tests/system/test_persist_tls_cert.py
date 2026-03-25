"""Unit tests for persist-tls-cert.py — backup/restore K8s Secrets via SSM.

All external calls (subprocess, boto3) are mocked — runs fully offline.
"""
from __future__ import annotations

import base64
import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Import the module despite its hyphenated filename
# ---------------------------------------------------------------------------
_SCRIPT_PATH = (
    Path(__file__).resolve().parents[2]
    / "system"
    / "cert-manager"
    / "persist-tls-cert.py"
)


def _load_module() -> ModuleType:
    """Dynamically import persist-tls-cert.py (hyphenated name)."""
    spec = importlib.util.spec_from_file_location("persist_tls_cert", _SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["persist_tls_cert"] = mod
    spec.loader.exec_module(mod)
    return mod


ptc = _load_module()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
SAMPLE_TLS_DATA = {
    "tls.crt": base64.b64encode(b"-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----").decode(),
    "tls.key": base64.b64encode(b"-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----").decode(),
}

SAMPLE_OPAQUE_DATA = {
    "tls.key": base64.b64encode(b"-----BEGIN EC PRIVATE KEY-----\nACME\n-----END EC PRIVATE KEY-----").decode(),
}


@pytest.fixture()
def mock_ssm() -> MagicMock:
    """Return a mocked SSM client."""
    return MagicMock()


# ---------------------------------------------------------------------------
# ssm_param_path
# ---------------------------------------------------------------------------
class TestSsmParamPath:
    """Validate SSM parameter path construction."""

    def test_default_prefix(self) -> None:
        """Should build path from the module-level SSM_PREFIX."""
        result = ptc.ssm_param_path("ops-tls-cert")
        assert result.endswith("/tls/ops-tls-cert")

    def test_contains_secret_name(self) -> None:
        """Path must include the secret name."""
        result = ptc.ssm_param_path("letsencrypt-account-key")
        assert "letsencrypt-account-key" in result


# ---------------------------------------------------------------------------
# backup_cert
# ---------------------------------------------------------------------------
class TestBackupCert:
    """Tests for the backup (K8s Secret → SSM) workflow."""

    def _kubectl_output(self, data: dict[str, str], secret_type: str) -> str:
        """Build the jsonpath stdout that kubectl would produce."""
        return f"{json.dumps(data)},{secret_type}"

    @patch.object(ptc, "get_ssm_client")
    @patch("subprocess.run")
    def test_backup_success(
        self, mock_run: MagicMock, mock_get_ssm: MagicMock, mock_ssm: MagicMock,
    ) -> None:
        """Happy path: kubectl returns data, SSM stores it."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=self._kubectl_output(SAMPLE_TLS_DATA, "kubernetes.io/tls"),
        )
        mock_get_ssm.return_value = mock_ssm

        result = ptc.backup_cert("ops-tls-cert", "kube-system")

        assert result is True
        mock_ssm.put_parameter.assert_called_once()
        call_kwargs = mock_ssm.put_parameter.call_args
        assert call_kwargs.kwargs["Type"] == "SecureString"

    @patch("subprocess.run")
    def test_backup_secret_not_found(self, mock_run: MagicMock) -> None:
        """kubectl fails → returns False, no SSM call."""
        mock_run.return_value = MagicMock(
            returncode=1, stdout="", stderr="NotFound",
        )

        result = ptc.backup_cert("missing-secret", "kube-system")

        assert result is False

    @patch("subprocess.run")
    def test_backup_dry_run(self, mock_run: MagicMock) -> None:
        """Dry-run should skip the SSM write."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=self._kubectl_output(SAMPLE_TLS_DATA, "kubernetes.io/tls"),
        )

        result = ptc.backup_cert("ops-tls-cert", "kube-system", dry_run=True)

        assert result is True

    @patch("subprocess.run")
    def test_backup_empty_data(self, mock_run: MagicMock) -> None:
        """Empty secret data → returns False."""
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=self._kubectl_output({}, "kubernetes.io/tls"),
        )

        result = ptc.backup_cert("empty-secret", "kube-system")

        assert result is False

    @patch.object(ptc, "get_ssm_client")
    @patch("subprocess.run")
    def test_backup_ssm_client_error(
        self, mock_run: MagicMock, mock_get_ssm: MagicMock, mock_ssm: MagicMock,
    ) -> None:
        """SSM put_parameter raises ClientError → handled gracefully."""
        from botocore.exceptions import ClientError

        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=self._kubectl_output(SAMPLE_TLS_DATA, "kubernetes.io/tls"),
        )
        mock_get_ssm.return_value = mock_ssm
        mock_ssm.put_parameter.side_effect = ClientError(
            {"Error": {"Code": "AccessDeniedException", "Message": "denied"}},
            "PutParameter",
        )

        result = ptc.backup_cert("ops-tls-cert", "kube-system")

        assert result is False


# ---------------------------------------------------------------------------
# restore_cert
# ---------------------------------------------------------------------------
class TestRestoreCert:
    """Tests for the restore (SSM → K8s Secret) workflow."""

    @patch("subprocess.run")
    def test_restore_already_exists(self, mock_run: MagicMock) -> None:
        """Secret exists → skip restore, return True."""
        mock_run.return_value = MagicMock(returncode=0)

        result = ptc.restore_cert("ops-tls-cert", "kube-system")

        assert result is True
        # Only the existence check call — no SSM or create
        mock_run.assert_called_once()

    @patch("subprocess.run")
    def test_restore_dry_run(self, mock_run: MagicMock) -> None:
        """Dry-run: secret doesn't exist, but stops before SSM read."""
        mock_run.return_value = MagicMock(returncode=1, stderr="NotFound")

        result = ptc.restore_cert("ops-tls-cert", "kube-system", dry_run=True)

        assert result is True

    @patch.object(ptc, "get_ssm_client")
    @patch("subprocess.run")
    def test_restore_tls_success(
        self, mock_run: MagicMock, mock_get_ssm: MagicMock, mock_ssm: MagicMock,
    ) -> None:
        """SSM read → temp files → kubectl create secret tls → success."""
        payload = json.dumps({"data": SAMPLE_TLS_DATA, "type": "kubernetes.io/tls"})
        mock_get_ssm.return_value = mock_ssm
        mock_ssm.get_parameter.return_value = {
            "Parameter": {"Value": payload},
        }

        # Call sequence: 1) check exists (fail), 2) ns create, 3) ns apply, 4) create secret
        call_count = 0

        def subprocess_side_effect(*args: Any, **kwargs: Any) -> MagicMock:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                # Secret doesn't exist
                return MagicMock(returncode=1, stderr="NotFound")
            # All subsequent calls succeed
            return MagicMock(returncode=0, stdout="namespace/kube-system created")

        mock_run.side_effect = subprocess_side_effect

        result = ptc.restore_cert("ops-tls-cert", "kube-system")

        assert result is True

    @patch.object(ptc, "get_ssm_client")
    @patch("subprocess.run")
    def test_restore_opaque_success(
        self, mock_run: MagicMock, mock_get_ssm: MagicMock, mock_ssm: MagicMock,
    ) -> None:
        """SSM read → kubectl create secret generic → success."""
        payload = json.dumps({"data": SAMPLE_OPAQUE_DATA, "type": "Opaque"})
        mock_get_ssm.return_value = mock_ssm
        mock_ssm.get_parameter.return_value = {
            "Parameter": {"Value": payload},
        }

        call_count = 0

        def subprocess_side_effect(*args: Any, **kwargs: Any) -> MagicMock:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return MagicMock(returncode=1, stderr="NotFound")
            return MagicMock(returncode=0, stdout="ok")

        mock_run.side_effect = subprocess_side_effect

        result = ptc.restore_cert("ops-tls-cert", "kube-system")

        assert result is True

    @patch.object(ptc, "get_ssm_client")
    @patch("subprocess.run")
    def test_restore_ssm_not_found(
        self, mock_run: MagicMock, mock_get_ssm: MagicMock, mock_ssm: MagicMock,
    ) -> None:
        """SSM ParameterNotFound → graceful failure."""
        from botocore.exceptions import ClientError

        mock_run.return_value = MagicMock(returncode=1, stderr="NotFound")
        mock_get_ssm.return_value = mock_ssm
        mock_ssm.get_parameter.side_effect = ClientError(
            {"Error": {"Code": "ParameterNotFound", "Message": "not found"}},
            "GetParameter",
        )

        result = ptc.restore_cert("ops-tls-cert", "kube-system")

        assert result is False


# ---------------------------------------------------------------------------
# _restore_tls_secret — edge cases
# ---------------------------------------------------------------------------
class TestRestoreTlsMissingFields:
    """Validate _restore_tls_secret handles incomplete data."""

    def test_missing_tls_crt(self) -> None:
        """Missing tls.crt → returns False."""
        result = ptc._restore_tls_secret(
            "bad-secret", "kube-system", {"tls.key": SAMPLE_TLS_DATA["tls.key"]},
        )
        assert result is False

    def test_missing_tls_key(self) -> None:
        """Missing tls.key → returns False."""
        result = ptc._restore_tls_secret(
            "bad-secret", "kube-system", {"tls.crt": SAMPLE_TLS_DATA["tls.crt"]},
        )
        assert result is False

    def test_empty_data(self) -> None:
        """Empty data dict → returns False."""
        result = ptc._restore_tls_secret("bad-secret", "kube-system", {})
        assert result is False
