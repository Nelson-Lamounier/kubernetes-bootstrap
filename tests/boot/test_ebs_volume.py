"""Unit tests for the EBS volume step (cp/ebs_volume.py).

All subprocess calls are mocked — no AWS or system interaction.
"""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest


# ── Helpers ────────────────────────────────────────────────────────────────

def _ok(stdout: str = "", stderr: str = "") -> SimpleNamespace:
    """Simulate a successful subprocess result."""
    return SimpleNamespace(returncode=0, stdout=stdout, stderr=stderr)


def _fail(stdout: str = "", stderr: str = "") -> SimpleNamespace:
    """Simulate a failed subprocess result."""
    return SimpleNamespace(returncode=1, stdout=stdout, stderr=stderr)


# ── Tests ──────────────────────────────────────────────────────────────────

class TestResolveNvmeDevice:
    """Test NVMe device resolution logic."""

    def test_returns_xvdf_when_exists(self) -> None:
        """Should return /dev/xvdf if it exists."""
        from cp.ebs_volume import resolve_nvme_device, DATA_DEVICE_NAME

        with patch("cp.ebs_volume.Path") as mock_path_cls:
            mock_path_cls.return_value.exists.return_value = True
            result = resolve_nvme_device()

        assert result == DATA_DEVICE_NAME

    def test_returns_nvme_device_when_xvdf_missing(self) -> None:
        """Should find /dev/nvme1n1 when /dev/xvdf does not exist."""
        from cp.ebs_volume import resolve_nvme_device

        with (
            patch("cp.ebs_volume.Path") as mock_path_cls,
            patch("cp.ebs_volume.glob.glob", return_value=["/dev/nvme1n1", "/dev/nvme2n1"]),
        ):
            mock_path_cls.return_value.exists.return_value = False
            result = resolve_nvme_device()

        assert result == "/dev/nvme1n1"

    def test_returns_empty_when_no_device(self) -> None:
        """Should return empty string when no device found."""
        from cp.ebs_volume import resolve_nvme_device

        with (
            patch("cp.ebs_volume.Path") as mock_path_cls,
            patch("cp.ebs_volume.glob.glob", return_value=[]),
        ):
            mock_path_cls.return_value.exists.return_value = False
            result = resolve_nvme_device()

        assert result == ""


class TestFormatIfNeeded:
    """Test filesystem formatting check."""

    @patch("cp.ebs_volume.run_cmd")
    def test_skips_format_when_fs_exists(self, mock_run: MagicMock) -> None:
        """Should not format if blkid reports an existing filesystem."""
        from cp.ebs_volume import format_if_needed

        mock_run.return_value = _ok(stdout="ext4\n")
        result = format_if_needed("/dev/nvme1n1")

        assert result is False
        assert mock_run.call_count == 1

    @patch("cp.ebs_volume.run_cmd")
    def test_formats_when_no_fs(self, mock_run: MagicMock) -> None:
        """Should format with ext4 when blkid returns empty."""
        from cp.ebs_volume import format_if_needed

        mock_run.side_effect = [
            _ok(stdout=""),     # blkid: no filesystem
            _ok(),              # mkfs: success
        ]

        result = format_if_needed("/dev/nvme1n1")

        assert result is True
        assert mock_run.call_count == 2


class TestEnsureDataDirectories:
    """Test data directory creation."""

    def test_creates_subdirectories(self, tmp_path: Path) -> None:
        """Should create kubernetes, k8s-bootstrap, app-deploy dirs."""
        from cp.ebs_volume import ensure_data_directories

        mount_point = str(tmp_path / "data")
        ensure_data_directories(mount_point)

        assert (tmp_path / "data" / "kubernetes").is_dir()
        assert (tmp_path / "data" / "k8s-bootstrap").is_dir()
        assert (tmp_path / "data" / "app-deploy").is_dir()

    @patch("cp.ebs_volume.run_cmd")
    def test_chown_and_chmod_applied_to_app_deploy(
        self, mock_run: MagicMock, tmp_path: Path
    ) -> None:
        """Should chown root:ssm-user and chmod g+w on app-deploy subtree."""
        from cp.ebs_volume import ensure_data_directories

        mock_run.return_value = _ok()
        mount_point = str(tmp_path / "data")

        ensure_data_directories(mount_point)

        app_deploy = str(tmp_path / "data" / "app-deploy")
        calls = [list(c.args[0]) for c in mock_run.call_args_list]
        assert ["chown", "-R", "root:ssm-user", app_deploy] in calls
        assert ["chmod", "-R", "g+w", app_deploy] in calls

    @patch("cp.ebs_volume.run_cmd")
    def test_chown_failure_is_non_fatal(
        self, mock_run: MagicMock, tmp_path: Path
    ) -> None:
        """Permission fixup failures must not abort the bootstrap step."""
        from cp.ebs_volume import ensure_data_directories

        # Simulate chown failing (e.g. ssm-user not yet created on first boot)
        mock_run.return_value = _fail(stderr="invalid group 'ssm-user'")
        mount_point = str(tmp_path / "data")

        # Must complete without raising
        ensure_data_directories(mount_point)

        assert (tmp_path / "data" / "app-deploy").is_dir()
