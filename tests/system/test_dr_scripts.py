"""Static validation tests for DR shell scripts and YAML manifests.

These tests validate script syntax, safety features, and content
correctness — no AWS/K8s calls required.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
import yaml

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SYSTEM_DIR = Path(__file__).resolve().parents[2] / "system"
DR_DIR = SYSTEM_DIR / "dr"
ETCD_BACKUP_SH = DR_DIR / "etcd-backup.sh"
INSTALL_TIMER_SH = DR_DIR / "install-etcd-backup-timer.sh"


# ---------------------------------------------------------------------------
# Shell script syntax (bash -n)
# ---------------------------------------------------------------------------
class TestShellSyntax:
    """Validate shell scripts pass bash syntax checks."""

    @pytest.mark.parametrize(
        "script",
        [
            pytest.param(ETCD_BACKUP_SH, id="etcd-backup"),
            pytest.param(INSTALL_TIMER_SH, id="install-timer"),
        ],
    )
    def test_bash_syntax_valid(self, script: Path) -> None:
        """Script must pass `bash -n` (parse without executing)."""
        result = subprocess.run(
            ["bash", "-n", str(script)],
            capture_output=True, text=True,
        )
        assert result.returncode == 0, (
            f"Syntax error in {script.name}:\n{result.stderr}"
        )


# ---------------------------------------------------------------------------
# etcd-backup.sh — content assertions
# ---------------------------------------------------------------------------
class TestEtcdBackupContent:
    """Validate etcd-backup.sh contains required safety and correctness features."""

    @pytest.fixture(autouse=True)
    def _load_script(self) -> None:
        """Read the script content once per test class."""
        self.content = ETCD_BACKUP_SH.read_text()

    def test_has_strict_mode(self) -> None:
        """Script must use bash strict mode."""
        assert "set -euo pipefail" in self.content

    def test_snapshot_path_host_visible(self) -> None:
        """Snapshot must use /var/lib/etcd/snapshots/ (host-mounted path)."""
        assert "/var/lib/etcd/snapshots" in self.content

    def test_snapshot_not_in_tmp(self) -> None:
        """Snapshot must NOT use /tmp/ (invisible to host from container)."""
        # Check that SNAPSHOT_DIR is not set to /tmp
        assert 'SNAPSHOT_DIR="/tmp' not in self.content

    def test_uses_server_side_encryption(self) -> None:
        """S3 uploads must include server-side encryption."""
        assert "--sse AES256" in self.content

    def test_s3_prefix_is_dr_backups(self) -> None:
        """S3 prefix must be dr-backups/etcd for correct IAM scoping."""
        assert 'S3_PREFIX="dr-backups/etcd"' in self.content

    def test_etcdctl_resolution_function(self) -> None:
        """Must use run_etcdctl function for container/binary portability."""
        assert "run_etcdctl()" in self.content

    def test_validates_s3_bucket(self) -> None:
        """Must fail early if S3_BUCKET is unset."""
        assert 'S3_BUCKET=""' not in self.content
        assert '-z "${S3_BUCKET}"' in self.content

    def test_validates_etcd_certificates(self) -> None:
        """Must validate etcd cert files exist before snapshot."""
        assert "ETCD_CACERT=" in self.content
        assert "ETCD_CERT=" in self.content
        assert "ETCD_KEY=" in self.content

    def test_cleans_up_snapshot(self) -> None:
        """Must remove local snapshot after upload."""
        assert "rm -f" in self.content


# ---------------------------------------------------------------------------
# install-etcd-backup-timer.sh — content assertions
# ---------------------------------------------------------------------------
class TestInstallTimerContent:
    """Validate install-etcd-backup-timer.sh creates systemd units."""

    @pytest.fixture(autouse=True)
    def _load_script(self) -> None:
        """Read the script content once per test class."""
        self.content = INSTALL_TIMER_SH.read_text()

    def test_has_strict_mode(self) -> None:
        """Script must use bash strict mode."""
        assert "set -euo pipefail" in self.content

    def test_creates_service_unit(self) -> None:
        """Must create a .service systemd unit."""
        assert "etcd-backup.service" in self.content

    def test_creates_timer_unit(self) -> None:
        """Must create a .timer systemd unit."""
        assert "etcd-backup.timer" in self.content

    def test_enables_timer(self) -> None:
        """Must enable and start the timer."""
        assert "systemctl enable" in self.content


# ---------------------------------------------------------------------------
# YAML manifests — parseable and valid
# ---------------------------------------------------------------------------
class TestYamlManifests:
    """Validate all YAML files in system/ are parseable."""

    @staticmethod
    def _find_yaml_files() -> list[Path]:
        """Discover all .yaml files under system/."""
        return sorted(SYSTEM_DIR.rglob("*.yaml"))

    @staticmethod
    def _find_manifest_files() -> list[Path]:
        """Discover K8s manifest files (excludes Helm *-values.yaml)."""
        return sorted(
            f for f in SYSTEM_DIR.rglob("*.yaml")
            if not f.name.endswith("-values.yaml")
        )

    @pytest.mark.parametrize(
        "yaml_file",
        _find_yaml_files.__func__(),  # type: ignore[attr-defined]
        ids=lambda p: str(p.relative_to(SYSTEM_DIR)),
    )
    def test_yaml_is_parseable(self, yaml_file: Path) -> None:
        """YAML file must parse without errors."""
        content = yaml_file.read_text()
        docs = list(yaml.safe_load_all(content))
        assert len(docs) > 0, f"{yaml_file.name} is empty"

    @pytest.mark.parametrize(
        "yaml_file",
        _find_manifest_files.__func__(),  # type: ignore[attr-defined]
        ids=lambda p: str(p.relative_to(SYSTEM_DIR)),
    )
    def test_yaml_has_kind(self, yaml_file: Path) -> None:
        """Each K8s manifest document should have a 'kind' field."""
        content = yaml_file.read_text()
        for doc in yaml.safe_load_all(content):
            if doc is not None:
                assert "kind" in doc, (
                    f"{yaml_file.name}: Missing 'kind' field in document"
                )
