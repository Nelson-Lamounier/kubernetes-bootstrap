"""Unit tests for BootConfig dataclass."""
from __future__ import annotations

from unittest.mock import patch

from boot_helpers.config import BootConfig


class TestBootConfigDefaults:
    """Verify BootConfig defaults from environment variables."""

    def test_defaults_without_env(self) -> None:
        """BootConfig.from_env() should provide sensible defaults."""
        with patch.dict("os.environ", {}, clear=True):
            cfg = BootConfig.from_env()

        assert cfg.aws_region == "eu-west-1"
        assert cfg.ssm_prefix == "/k8s/development"
        assert cfg.environment == "development"
        assert cfg.mount_point == "/data"
        assert cfg.data_dir == "/data/kubernetes"
        assert cfg.pod_cidr == "192.168.0.0/16"
        assert cfg.service_cidr == "10.96.0.0/12"
        assert cfg.node_label == "role=worker"

    def test_env_override(self) -> None:
        """BootConfig should read from environment variables."""
        env = {
            "AWS_REGION": "us-east-1",
            "SSM_PREFIX": "/k8s/staging",
            "MOUNT_POINT": "/mnt/data",
            "K8S_VERSION": "1.30.0",
            "NODE_LABEL": "workload=monitoring",
            "VOLUME_ID": "vol-abc123",
            "S3_BUCKET": "my-bucket",
        }
        with patch.dict("os.environ", env, clear=True):
            cfg = BootConfig.from_env()

        assert cfg.aws_region == "us-east-1"
        assert cfg.ssm_prefix == "/k8s/staging"
        assert cfg.mount_point == "/mnt/data"
        assert cfg.k8s_version == "1.30.0"
        assert cfg.node_label == "workload=monitoring"
        assert cfg.volume_id == "vol-abc123"
        assert cfg.s3_bucket == "my-bucket"

    def test_environment_field(self) -> None:
        """Environment field should read from ENVIRONMENT env var."""
        env = {"ENVIRONMENT": "production"}
        with patch.dict("os.environ", env, clear=True):
            cfg = BootConfig.from_env()

        assert cfg.environment == "production"

    def test_data_dir_from_env(self) -> None:
        """data_dir should read from DATA_DIR env var."""
        env = {"DATA_DIR": "/mnt/ebs/kubernetes"}
        with patch.dict("os.environ", env, clear=True):
            cfg = BootConfig.from_env()

        assert cfg.data_dir == "/mnt/ebs/kubernetes"

    def test_optional_fields_default_empty(self) -> None:
        """Optional fields should default to empty strings."""
        with patch.dict("os.environ", {}, clear=True):
            cfg = BootConfig.from_env()

        assert cfg.volume_id == ""
        assert cfg.hosted_zone_id == ""
        assert cfg.s3_bucket == ""
        assert cfg.log_group_name == ""

    def test_admin_conf_property(self) -> None:
        """admin_conf property should return the kubeadm admin kubeconfig path."""
        with patch.dict("os.environ", {}, clear=True):
            cfg = BootConfig.from_env()

        assert cfg.admin_conf == "/etc/kubernetes/admin.conf"

    def test_kubeconfig_env_property(self) -> None:
        """kubeconfig_env property should return dict with KUBECONFIG."""
        with patch.dict("os.environ", {}, clear=True):
            cfg = BootConfig.from_env()

        assert cfg.kubeconfig_env == {"KUBECONFIG": "/etc/kubernetes/admin.conf"}
