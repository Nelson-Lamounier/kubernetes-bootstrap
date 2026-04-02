"""Unit tests for the kubeadm init step (cp/kubeadm_init.py).

Covers the ensure_bootstrap_token(), ensure_kube_proxy(), and
ensure_coredns() guards that repair missing cluster infrastructure
after a DR restore where kubeadm init was skipped.

All subprocess calls are mocked — no AWS or system interaction.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

import pytest

from boot_helpers.config import BootConfig


# ── Helpers ────────────────────────────────────────────────────────────────

def _ok(stdout: str = "", stderr: str = "") -> SimpleNamespace:
    """Simulate a successful subprocess result."""
    return SimpleNamespace(returncode=0, stdout=stdout, stderr=stderr)


def _fail(stdout: str = "", stderr: str = "") -> SimpleNamespace:
    """Simulate a failed subprocess result."""
    return SimpleNamespace(returncode=1, stdout=stdout, stderr=stderr)


def _cfg() -> BootConfig:
    """Create a test BootConfig with default values."""
    return BootConfig(
        pod_cidr="192.168.0.0/16",
        service_cidr="10.96.0.0/12",
    )


# ── ensure_kube_proxy ─────────────────────────────────────────────────────

class TestEnsureKubeProxy:
    """Tests for the kube-proxy DaemonSet guard."""

    @patch("cp.kubeadm_init.run_cmd")
    def test_skips_when_daemonset_already_present(
        self, mock_run: MagicMock,
    ) -> None:
        """Should short-circuit when kubectl get daemonset reports kube-proxy."""
        from cp.kubeadm_init import ensure_kube_proxy

        mock_run.return_value = _ok(
            stdout="NAME         DESIRED   CURRENT   READY   AGE\n"
                   "kube-proxy   1         1         1       10m\n"
        )

        ensure_kube_proxy(_cfg())

        # Only one call: the kubectl get daemonset check
        assert mock_run.call_count == 1
        cmd_args = mock_run.call_args[0][0]
        assert "daemonset" in cmd_args
        assert "kube-proxy" in cmd_args

    @patch("cp.kubeadm_init.time.sleep", return_value=None)
    @patch("cp.kubeadm_init.get_imds_value", return_value="10.0.1.42")
    @patch("cp.kubeadm_init.run_cmd")
    def test_deploys_when_daemonset_missing(
        self,
        mock_run: MagicMock,
        mock_imds: MagicMock,
        mock_sleep: MagicMock,
    ) -> None:
        """Should run kubeadm init phase addon kube-proxy when missing."""
        from cp.kubeadm_init import ensure_kube_proxy

        mock_run.side_effect = [
            _fail(stderr="Error from server (NotFound)"),  # kubectl get → not found
            _ok(),                                         # kubeadm init phase addon
            _ok(stdout="kube-proxy-abc12   1/1   Running   0   5s"),  # pod check
        ]

        ensure_kube_proxy(_cfg())

        # Verify the kubeadm command was called with correct arguments
        kubeadm_call = mock_run.call_args_list[1]
        cmd = kubeadm_call[0][0]
        assert cmd[0] == "kubeadm"
        assert "kube-proxy" in cmd
        assert "--apiserver-advertise-address=10.0.1.42" in cmd
        assert "--pod-network-cidr=192.168.0.0/16" in cmd

    @patch("cp.kubeadm_init.get_imds_value", return_value="")
    @patch("cp.kubeadm_init.run_cmd")
    def test_raises_when_imds_fails(
        self,
        mock_run: MagicMock,
        mock_imds: MagicMock,
    ) -> None:
        """Should raise RuntimeError if private IP cannot be retrieved."""
        from cp.kubeadm_init import ensure_kube_proxy

        mock_run.return_value = _fail(stderr="NotFound")

        with pytest.raises(RuntimeError, match="Cannot deploy kube-proxy"):
            ensure_kube_proxy(_cfg())


# ── ensure_coredns ────────────────────────────────────────────────────────

class TestEnsureCoreDNS:
    """Tests for the CoreDNS Deployment guard."""

    @patch("cp.kubeadm_init.run_cmd")
    def test_skips_when_deployment_already_present(
        self, mock_run: MagicMock,
    ) -> None:
        """Should short-circuit when kubectl get deployment reports coredns."""
        from cp.kubeadm_init import ensure_coredns

        mock_run.return_value = _ok(
            stdout="NAME      READY   UP-TO-DATE   AVAILABLE   AGE\n"
                   "coredns   2/2     2            2           10m\n"
        )

        ensure_coredns(_cfg())

        assert mock_run.call_count == 1
        cmd_args = mock_run.call_args[0][0]
        assert "deployment" in cmd_args
        assert "coredns" in cmd_args

    @patch("cp.kubeadm_init.run_cmd")
    def test_deploys_when_deployment_missing(
        self, mock_run: MagicMock,
    ) -> None:
        """Should run kubeadm init phase addon coredns when missing."""
        from cp.kubeadm_init import ensure_coredns

        mock_run.side_effect = [
            _fail(stderr="Error from server (NotFound)"),  # kubectl get → not found
            _ok(),                                         # kubeadm init phase addon
        ]

        ensure_coredns(_cfg())

        kubeadm_call = mock_run.call_args_list[1]
        cmd = kubeadm_call[0][0]
        assert cmd[0] == "kubeadm"
        assert "coredns" in cmd
        assert "--service-cidr=10.96.0.0/12" in cmd


# ── ensure_bootstrap_token ────────────────────────────────────────────────

class TestEnsureBootstrapToken:
    """Tests for the bootstrap-token phase guard."""

    @patch("cp.kubeadm_init.run_cmd")
    def test_skips_when_cluster_info_exists(
        self, mock_run: MagicMock,
    ) -> None:
        """Should short-circuit when cluster-info ConfigMap is present."""
        from cp.kubeadm_init import ensure_bootstrap_token

        mock_run.return_value = _ok(
            stdout="NAME           DATA   AGE\n"
                   "cluster-info   3      5d\n"
        )

        ensure_bootstrap_token()

        assert mock_run.call_count == 1
        cmd_args = mock_run.call_args[0][0]
        assert "configmap" in cmd_args
        assert "cluster-info" in cmd_args

    @patch("cp.kubeadm_init.run_cmd")
    def test_runs_all_restore_phases_when_missing(
        self, mock_run: MagicMock,
    ) -> None:
        """Should run upload-config (kubeadm + kubelet) then bootstrap-token."""
        from cp.kubeadm_init import ensure_bootstrap_token

        mock_run.side_effect = [
            _fail(stderr="Error from server (NotFound)"),  # ConfigMap missing
            _ok(),  # kubeadm init phase upload-config kubeadm
            _ok(),  # kubeadm init phase upload-config kubelet
            _ok(),  # kubeadm init phase bootstrap-token
        ]

        ensure_bootstrap_token()

        assert mock_run.call_count == 4

        # Verify upload-config kubeadm
        upload_kubeadm_cmd = mock_run.call_args_list[1][0][0]
        assert "upload-config" in upload_kubeadm_cmd
        assert "kubeadm" in upload_kubeadm_cmd

        # Verify upload-config kubelet
        upload_kubelet_cmd = mock_run.call_args_list[2][0][0]
        assert "upload-config" in upload_kubelet_cmd
        assert "kubelet" in upload_kubelet_cmd

        # Verify bootstrap-token
        bootstrap_cmd = mock_run.call_args_list[3][0][0]
        assert "bootstrap-token" in bootstrap_cmd


# ── handle_second_run integration ─────────────────────────────────────────

class TestHandleSecondRunGuards:
    """Verify that handle_second_run calls all guards."""

    @patch("cp.kubeadm_init.ensure_coredns")
    @patch("cp.kubeadm_init.ensure_kube_proxy")
    @patch("cp.kubeadm_init.ensure_bootstrap_token")
    @patch("cp.kubeadm_init.publish_kubeconfig_to_ssm")
    @patch("cp.kubeadm_init.ssm_put")
    @patch("cp.kubeadm_init.update_dns_record")
    @patch("cp.kubeadm_init.get_imds_value", return_value="10.0.1.42")
    @patch("cp.kubeadm_init.run_cmd")
    def test_calls_all_ensure_guards_during_second_run(
        self,
        mock_run: MagicMock,
        mock_imds: MagicMock,
        mock_dns: MagicMock,
        mock_ssm: MagicMock,
        mock_publish: MagicMock,
        mock_ensure_bt: MagicMock,
        mock_ensure_kp: MagicMock,
        mock_ensure_dns: MagicMock,
    ) -> None:
        """All three guards must be called in order: bootstrap-token, kube-proxy, coredns."""
        from cp.kubeadm_init import handle_second_run

        # Simulate: id ssm-user fails (no ssm-user), kubectl get nodes succeeds,
        # then label_control_plane_node calls hostname + kubectl label
        mock_run.side_effect = [
            _fail(),  # id ssm-user
            _ok(stdout="NAME   STATUS   ROLES   AGE   VERSION"),  # kubectl get nodes
            _ok(stdout="ip-10-0-1-42.eu-west-1.compute.internal"),  # hostname -f
            _ok(),  # kubectl label node
        ]

        cfg = _cfg()
        handle_second_run(cfg)

        # Verify all three guards were called
        mock_ensure_bt.assert_called_once()
        mock_ensure_kp.assert_called_once_with(cfg)
        mock_ensure_dns.assert_called_once_with(cfg)
