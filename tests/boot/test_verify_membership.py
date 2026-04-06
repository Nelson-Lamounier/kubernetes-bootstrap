"""Unit tests for the worker verify_membership step (wk/verify_membership.py).

All subprocess calls are mocked — no AWS or system interaction.
"""
from __future__ import annotations

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
        "NODE_LABEL": "workload=frontend,environment=development",
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


# ── Tests: _parse_label_string ─────────────────────────────────────────────

class TestParseLabelString:
    """Test label string parsing."""

    def test_parses_single_label(self) -> None:
        """Should parse a single key=value pair."""
        from wk.verify_membership import _parse_label_string

        result = _parse_label_string("workload=frontend")

        assert result == {"workload": "frontend"}

    def test_parses_multiple_labels(self) -> None:
        """Should parse comma-separated key=value pairs."""
        from wk.verify_membership import _parse_label_string

        result = _parse_label_string("workload=frontend,environment=development")

        assert result == {"workload": "frontend", "environment": "development"}

    def test_handles_empty_string(self) -> None:
        """Should return empty dict for empty string."""
        from wk.verify_membership import _parse_label_string

        result = _parse_label_string("")

        assert result == {}

    def test_handles_whitespace(self) -> None:
        """Should strip whitespace from keys and values."""
        from wk.verify_membership import _parse_label_string

        result = _parse_label_string(" workload = frontend , environment = dev ")

        assert result == {"workload": "frontend", "environment": "dev"}


# ── Tests: _is_node_registered ─────────────────────────────────────────────

class TestIsNodeRegistered:
    """Test node registration check."""

    @patch("wk.verify_membership.run_cmd")
    def test_returns_true_when_node_exists(self, mock_run: MagicMock) -> None:
        """Should return True when kubectl finds the node."""
        from wk.verify_membership import _is_node_registered

        mock_run.return_value = _ok(
            stdout="ip-10-0-0-245.eu-west-1.compute.internal   Ready   <none>   5m"
        )

        assert _is_node_registered("ip-10-0-0-245.eu-west-1.compute.internal") is True

    @patch("wk.verify_membership.run_cmd")
    def test_returns_false_when_not_found(self, mock_run: MagicMock) -> None:
        """Should return False when kubectl fails."""
        from wk.verify_membership import _is_node_registered

        mock_run.return_value = _fail(stderr="Error from server (NotFound)")

        assert _is_node_registered("ip-10-0-0-245.eu-west-1.compute.internal") is False


# ── Tests: _fix_labels ─────────────────────────────────────────────────────

class TestFixLabels:
    """Test label correction logic."""

    @patch("wk.verify_membership.run_cmd")
    def test_corrects_mismatched_label(self, mock_run: MagicMock) -> None:
        """Should apply kubectl label for mismatched labels."""
        from wk.verify_membership import _fix_labels

        mock_run.return_value = _ok(stdout="node/test-node labeled")

        corrected = _fix_labels(
            "test-node",
            expected={"workload": "frontend", "environment": "development"},
            actual={"workload": "monitoring", "environment": "development"},
        )

        assert corrected == ["workload=frontend"]
        mock_run.assert_called_once()

    @patch("wk.verify_membership.run_cmd")
    def test_no_action_when_labels_match(self, mock_run: MagicMock) -> None:
        """Should return empty list when labels already match."""
        from wk.verify_membership import _fix_labels

        corrected = _fix_labels(
            "test-node",
            expected={"workload": "frontend"},
            actual={"workload": "frontend"},
        )

        assert corrected == []
        mock_run.assert_not_called()

    @patch("wk.verify_membership.run_cmd")
    def test_corrects_missing_label(self, mock_run: MagicMock) -> None:
        """Should apply label when it is absent from the node."""
        from wk.verify_membership import _fix_labels

        mock_run.return_value = _ok(stdout="node/test-node labeled")

        corrected = _fix_labels(
            "test-node",
            expected={"workload": "frontend"},
            actual={},
        )

        assert corrected == ["workload=frontend"]


# ── Tests: step_verify_cluster_membership ──────────────────────────────────

class TestStepVerifyClusterMembership:
    """Test the full step orchestration."""

    @patch("wk.verify_membership._fix_labels")
    @patch("wk.verify_membership._get_current_labels")
    @patch("wk.verify_membership._is_node_registered")
    @patch("wk.verify_membership._get_hostname")
    def test_no_action_when_registered_and_labels_correct(
        self,
        mock_hostname: MagicMock,
        mock_registered: MagicMock,
        mock_labels: MagicMock,
        mock_fix: MagicMock,
    ) -> None:
        """Should return early when node is healthy."""
        from wk.verify_membership import step_verify_cluster_membership

        mock_hostname.return_value = "ip-10-0-0-245.eu-west-1.compute.internal"
        mock_registered.return_value = True
        mock_labels.return_value = {
            "workload": "frontend",
            "environment": "development",
        }

        cfg = _make_cfg()
        step_verify_cluster_membership(cfg)

        mock_fix.assert_not_called()

    @patch("wk.verify_membership._fix_labels")
    @patch("wk.verify_membership._get_current_labels")
    @patch("wk.verify_membership._is_node_registered")
    @patch("wk.verify_membership._get_hostname")
    def test_fixes_label_drift(
        self,
        mock_hostname: MagicMock,
        mock_registered: MagicMock,
        mock_labels: MagicMock,
        mock_fix: MagicMock,
    ) -> None:
        """Should correct labels when they don't match NODE_LABEL."""
        from wk.verify_membership import step_verify_cluster_membership

        mock_hostname.return_value = "ip-10-0-0-245.eu-west-1.compute.internal"
        mock_registered.return_value = True
        mock_labels.return_value = {
            "workload": "monitoring",
            "environment": "development",
        }
        mock_fix.return_value = ["workload=frontend"]

        cfg = _make_cfg()
        step_verify_cluster_membership(cfg)

        mock_fix.assert_called_once()

    @patch("wk.verify_membership._get_hostname")
    def test_skips_when_hostname_unavailable(
        self,
        mock_hostname: MagicMock,
    ) -> None:
        """Should skip when hostname cannot be resolved."""
        from wk.verify_membership import step_verify_cluster_membership

        mock_hostname.return_value = ""

        cfg = _make_cfg()
        step_verify_cluster_membership(cfg)

    @patch("wk.verify_membership.join_cluster")
    @patch("wk.verify_membership.wait_for_kubelet")
    @patch("wk.verify_membership.wait_for_api_server_reachable")
    @patch("wk.verify_membership.resolve_control_plane_endpoint")
    @patch("wk.verify_membership.run_cmd")
    @patch("wk.verify_membership.check_ca_mismatch")
    @patch("wk.verify_membership._is_node_registered")
    @patch("wk.verify_membership._get_hostname")
    def test_triggers_rejoin_when_not_registered(
        self,
        mock_hostname: MagicMock,
        mock_registered: MagicMock,
        mock_ca_check: MagicMock,
        mock_run: MagicMock,
        mock_resolve: MagicMock,
        mock_wait_api: MagicMock,
        mock_wait_kubelet: MagicMock,
        mock_join: MagicMock,
    ) -> None:
        """Should trigger CA check and re-join when node is not registered."""
        from wk.verify_membership import step_verify_cluster_membership

        mock_hostname.return_value = "ip-10-0-0-245.eu-west-1.compute.internal"
        mock_registered.return_value = False
        mock_ca_check.return_value = True
        mock_run.return_value = _ok()
        mock_resolve.return_value = "k8s-api.k8s.internal:6443"

        cfg = _make_cfg()
        step_verify_cluster_membership(cfg)

        mock_ca_check.assert_called_once_with(cfg)
        mock_resolve.assert_called_once_with(cfg)
        mock_join.assert_called_once()
