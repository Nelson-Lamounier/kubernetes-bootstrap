"""Unit tests for stale PV cleanup step (wk/stale_pvs.py).

All subprocess calls are mocked — no Kubernetes or AWS interaction.
"""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from boot_helpers.config import BootConfig


# ── Helpers ────────────────────────────────────────────────────────────────

def _make_cfg(**overrides: str) -> BootConfig:
    """Create a BootConfig with test defaults."""
    defaults = {
        "AWS_REGION": "eu-west-1",
        "SSM_PREFIX": "/k8s/development",
        "MOUNT_POINT": "/data",
        "NODE_LABEL": "workload=monitoring",
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

class TestGetClusterNodeNames:
    """Test cluster node name discovery."""

    @patch("wk.stale_pvs.run_cmd")
    def test_returns_node_set(self, mock_run: MagicMock) -> None:
        """Should parse space-separated node names into a set."""
        from wk.stale_pvs import get_cluster_node_names

        mock_run.return_value = _ok(stdout="node-a node-b node-c")

        result = get_cluster_node_names()

        assert result == {"node-a", "node-b", "node-c"}

    @patch("wk.stale_pvs.run_cmd")
    def test_returns_empty_on_failure(self, mock_run: MagicMock) -> None:
        """Should return empty set when kubectl fails."""
        from wk.stale_pvs import get_cluster_node_names

        mock_run.return_value = _fail()

        result = get_cluster_node_names()

        assert result == set()


class TestFindStalePvs:
    """Test stale PV discovery logic."""

    @patch("wk.stale_pvs.run_cmd")
    def test_detects_stale_pv(self, mock_run: MagicMock) -> None:
        """Should identify PVs pinned to nodes not in the live set."""
        from wk.stale_pvs import find_stale_pvs

        pv_list = {
            "items": [{
                "metadata": {"name": "pv-grafana-data"},
                "spec": {
                    "claimRef": {
                        "namespace": "monitoring",
                        "name": "grafana-data",
                    },
                    "nodeAffinity": {
                        "required": {
                            "nodeSelectorTerms": [{
                                "matchExpressions": [{
                                    "key": "kubernetes.io/hostname",
                                    "values": ["dead-node-1"],
                                }],
                            }],
                        },
                    },
                },
            }],
        }
        mock_run.return_value = _ok(stdout=json.dumps(pv_list))

        result = find_stale_pvs({"live-node-1", "live-node-2"})

        assert len(result) == 1
        assert result[0]["pv_name"] == "pv-grafana-data"
        assert result[0]["pvc_name"] == "grafana-data"
        assert result[0]["dead_node"] == "dead-node-1"

    @patch("wk.stale_pvs.run_cmd")
    def test_ignores_live_nodes(self, mock_run: MagicMock) -> None:
        """Should not flag PVs pinned to live nodes."""
        from wk.stale_pvs import find_stale_pvs

        pv_list = {
            "items": [{
                "metadata": {"name": "pv-prometheus-data"},
                "spec": {
                    "claimRef": {
                        "namespace": "monitoring",
                        "name": "prometheus-data",
                    },
                    "nodeAffinity": {
                        "required": {
                            "nodeSelectorTerms": [{
                                "matchExpressions": [{
                                    "key": "kubernetes.io/hostname",
                                    "values": ["live-node-1"],
                                }],
                            }],
                        },
                    },
                },
            }],
        }
        mock_run.return_value = _ok(stdout=json.dumps(pv_list))

        result = find_stale_pvs({"live-node-1", "live-node-2"})

        assert len(result) == 0

    @patch("wk.stale_pvs.run_cmd")
    def test_ignores_non_monitoring_namespace(self, mock_run: MagicMock) -> None:
        """Should skip PVs in namespaces other than monitoring."""
        from wk.stale_pvs import find_stale_pvs

        pv_list = {
            "items": [{
                "metadata": {"name": "pv-default-data"},
                "spec": {
                    "claimRef": {
                        "namespace": "default",
                        "name": "some-data",
                    },
                    "nodeAffinity": {
                        "required": {
                            "nodeSelectorTerms": [{
                                "matchExpressions": [{
                                    "key": "kubernetes.io/hostname",
                                    "values": ["dead-node-1"],
                                }],
                            }],
                        },
                    },
                },
            }],
        }
        mock_run.return_value = _ok(stdout=json.dumps(pv_list))

        result = find_stale_pvs({"live-node-1"})

        assert len(result) == 0

    @patch("wk.stale_pvs.run_cmd")
    def test_handles_empty_pv_list(self, mock_run: MagicMock) -> None:
        """Should return empty list when no PVs exist."""
        from wk.stale_pvs import find_stale_pvs

        mock_run.return_value = _ok(stdout=json.dumps({"items": []}))

        result = find_stale_pvs({"live-node-1"})

        assert len(result) == 0

    @patch("wk.stale_pvs.run_cmd")
    def test_handles_kubectl_failure(self, mock_run: MagicMock) -> None:
        """Should return empty list when kubectl fails."""
        from wk.stale_pvs import find_stale_pvs

        mock_run.return_value = _fail()

        result = find_stale_pvs({"live-node-1"})

        assert len(result) == 0

    @patch("wk.stale_pvs.run_cmd")
    def test_handles_invalid_json(self, mock_run: MagicMock) -> None:
        """Should return empty list when JSON parsing fails."""
        from wk.stale_pvs import find_stale_pvs

        mock_run.return_value = _ok(stdout="not valid json")

        result = find_stale_pvs({"live-node-1"})

        assert len(result) == 0
