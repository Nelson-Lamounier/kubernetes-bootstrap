"""Unit tests for the worker join_cluster step (wk/join_cluster.py).

All subprocess calls are mocked — no AWS or system interaction.
"""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from boot_helpers.config import BootConfig


# ── Helpers ────────────────────────────────────────────────────────────────

def _make_cfg(**overrides: str) -> BootConfig:
    """Create a BootConfig with test defaults."""
    defaults = {
        "AWS_REGION": "eu-west-1",
        "SSM_PREFIX": "/k8s/development",
        "MOUNT_POINT": "/data",
        "NODE_LABEL": "role=application",
        "JOIN_MAX_RETRIES": "3",
        "JOIN_RETRY_INTERVAL": "0",
    }
    defaults.update(overrides)
    with patch.dict("os.environ", defaults, clear=True):
        return BootConfig.from_env()


def _ok(stdout: str = "", stderr: str = "") -> SimpleNamespace:
    """Simulate a successful subprocess result."""
    return SimpleNamespace(returncode=0, stdout=stdout, stderr=stderr)


def _fail(stdout: str = "", stderr: str = "") -> SimpleNamespace:
    """Simulate a failed subprocess result."""
    return SimpleNamespace(returncode=1, stdout=stdout, stderr=stderr)


# ── Tests ──────────────────────────────────────────────────────────────────

class TestComputeLocalCaHash:
    """Test local CA hash computation."""

    @patch("wk.join_cluster.run_cmd")
    def test_returns_sha256_hash(self, mock_run: MagicMock) -> None:
        """Should return sha256:<hex> format."""
        from wk.join_cluster import compute_local_ca_hash

        mock_run.return_value = _ok(stdout="abc123def456\n")

        result = compute_local_ca_hash()

        assert result == "sha256:abc123def456"

    @patch("wk.join_cluster.run_cmd")
    def test_returns_empty_on_failure(self, mock_run: MagicMock) -> None:
        """Should return empty string when openssl fails."""
        from wk.join_cluster import compute_local_ca_hash

        mock_run.return_value = _fail()

        result = compute_local_ca_hash()

        assert result == ""


class TestCheckCaMismatch:
    """Test CA certificate mismatch detection."""

    @patch("wk.join_cluster.Path")
    def test_no_mismatch_when_no_ca_cert(self, mock_path_cls: MagicMock) -> None:
        """Should return False if no local CA cert exists."""
        from wk.join_cluster import check_ca_mismatch

        # CA_CERT_PATH does not exist
        ca_instance = MagicMock()
        ca_instance.exists.return_value = False
        kubelet_instance = MagicMock()

        mock_path_cls.side_effect = [ca_instance, kubelet_instance]

        cfg = _make_cfg()
        result = check_ca_mismatch(cfg)

        assert result is False

    @patch("wk.join_cluster.ssm_get")
    @patch("wk.join_cluster.compute_local_ca_hash")
    @patch("wk.join_cluster.Path")
    def test_no_mismatch_when_hashes_match(
        self,
        mock_path_cls: MagicMock,
        mock_hash: MagicMock,
        mock_ssm: MagicMock,
    ) -> None:
        """Should return False when local and SSM hashes match."""
        from wk.join_cluster import check_ca_mismatch

        ca_instance = MagicMock()
        ca_instance.exists.return_value = True
        kubelet_instance = MagicMock()
        kubelet_instance.exists.return_value = True
        mock_path_cls.side_effect = [ca_instance, kubelet_instance]

        mock_hash.return_value = "sha256:matching_hash"
        mock_ssm.return_value = "sha256:matching_hash"

        cfg = _make_cfg()
        result = check_ca_mismatch(cfg)

        assert result is False

    @patch("wk.join_cluster.run_cmd")
    @patch("wk.join_cluster.ssm_get")
    @patch("wk.join_cluster.compute_local_ca_hash")
    @patch("wk.join_cluster.Path")
    def test_mismatch_triggers_reset(
        self,
        mock_path_cls: MagicMock,
        mock_hash: MagicMock,
        mock_ssm: MagicMock,
        mock_run: MagicMock,
    ) -> None:
        """Should detect mismatch, run kubeadm reset, and return True."""
        from wk.join_cluster import check_ca_mismatch

        ca_instance = MagicMock()
        ca_instance.exists.side_effect = [True, True]  # initial check + final unlink check
        kubelet_instance = MagicMock()
        kubelet_instance.exists.side_effect = [True, True]  # initial check + final unlink check
        mock_path_cls.side_effect = [ca_instance, kubelet_instance]

        mock_hash.return_value = "sha256:old_hash"
        mock_ssm.return_value = "sha256:new_hash"
        mock_run.return_value = _ok()

        cfg = _make_cfg()
        result = check_ca_mismatch(cfg)

        assert result is True
        # kubeadm reset should have been called
        mock_run.assert_called()


class TestResolveControlPlaneEndpoint:
    """Test SSM endpoint resolution."""

    @patch("wk.join_cluster.ssm_get")
    @patch("wk.join_cluster.time.sleep")
    def test_returns_endpoint_on_first_try(
        self, mock_sleep: MagicMock, mock_ssm: MagicMock,
    ) -> None:
        """Should return the endpoint immediately when SSM has it."""
        from wk.join_cluster import resolve_control_plane_endpoint

        mock_ssm.return_value = "k8s-api.k8s.internal:6443"

        cfg = _make_cfg()
        result = resolve_control_plane_endpoint(cfg)

        assert result == "k8s-api.k8s.internal:6443"
        mock_sleep.assert_not_called()

    @patch("wk.join_cluster.CP_MAX_WAIT_SECONDS", 10)
    @patch("wk.join_cluster.ssm_get")
    @patch("wk.join_cluster.time.sleep")
    def test_raises_when_timeout(
        self, mock_sleep: MagicMock, mock_ssm: MagicMock,
    ) -> None:
        """Should raise RuntimeError when endpoint never appears."""
        from wk.join_cluster import resolve_control_plane_endpoint

        mock_ssm.return_value = None

        cfg = _make_cfg()
        with pytest.raises(RuntimeError, match="not found in SSM"):
            resolve_control_plane_endpoint(cfg)


class TestWaitForKubelet:
    """Test kubelet readiness check."""

    @patch("wk.join_cluster.Path")
    @patch("wk.join_cluster.run_cmd")
    @patch("wk.join_cluster.time.sleep")
    def test_detects_active_kubelet(
        self, mock_sleep: MagicMock, mock_run: MagicMock, mock_path: MagicMock,
    ) -> None:
        """Should detect kubelet active on first check."""
        from wk.join_cluster import wait_for_kubelet

        # Simulate kubelet config file exists (kubeadm join completed)
        mock_path.return_value.exists.return_value = True
        mock_run.return_value = _ok()

        wait_for_kubelet()

        mock_sleep.assert_not_called()

    @patch("wk.join_cluster.Path")
    @patch("wk.join_cluster.run_cmd")
    @patch("wk.join_cluster.time.sleep")
    def test_waits_then_detects(
        self, mock_sleep: MagicMock, mock_run: MagicMock, mock_path: MagicMock,
    ) -> None:
        """Should wait and retry until kubelet becomes active."""
        from wk.join_cluster import wait_for_kubelet

        # Simulate kubelet config file exists (kubeadm join completed)
        mock_path.return_value.exists.return_value = True
        mock_run.side_effect = [_fail(), _fail(), _ok()]

        wait_for_kubelet()

        assert mock_sleep.call_count == 2

