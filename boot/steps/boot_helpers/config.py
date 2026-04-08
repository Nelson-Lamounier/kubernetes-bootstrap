"""Bootstrap configuration dataclass — single source of truth for all env vars.

Consolidates the scattered ``os.environ.get()`` calls from ``common.py``,
``control_plane.py``, and ``worker.py`` into a single typed dataclass.

All fields have sensible defaults for the development environment.
Override via environment variables set by EC2 user-data (``/etc/profile.d/k8s-env.sh``)
or SSM Automation parameters.

Usage::

    from boot_helpers.config import BootConfig

    cfg = BootConfig.from_env()
    print(cfg.ssm_prefix)   # /k8s/development
    print(cfg.aws_region)   # eu-west-1
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass
class BootConfig:
    """Bootstrap configuration populated from environment variables.

    All fields have sensible defaults for the development environment.

    Attributes:
        ssm_prefix: SSM Parameter Store prefix (e.g. ``/k8s/development``).
        aws_region: AWS region for API calls.
        k8s_version: Kubernetes version for ``kubeadm init``.
        data_dir: kubeadm data directory on the EBS volume.
        pod_cidr: Pod network CIDR for Calico.
        service_cidr: Service subnet CIDR.
        hosted_zone_id: Route 53 hosted zone for API DNS.
        api_dns_name: DNS name for the K8s API server.
        s3_bucket: S3 bucket containing bootstrap content.
        mount_point: Local mount point for the data volume.
        calico_version: Calico CNI version.
        environment: Deployment environment name.
        node_label: Kubernetes node label (worker nodes only).
        node_pool: ASG pool identity — ``general``, ``monitoring``, or empty
            string for legacy statically-provisioned workers.  Set by the EC2
            user-data block in ``worker-asg-stack.ts``.  Used to gate the SSM
            instance-id registration step and drive pool-aware verification.
        log_group_name: CloudWatch log group name.
        join_max_retries: Maximum retries for kubeadm join.
        join_retry_interval: Seconds between join retries.
    """

    ssm_prefix: str = field(
        default_factory=lambda: os.environ.get("SSM_PREFIX", "/k8s/development"),
    )
    aws_region: str = field(
        default_factory=lambda: os.environ.get("AWS_REGION", "eu-west-1"),
    )
    k8s_version: str = field(
        default_factory=lambda: os.environ.get("K8S_VERSION", "1.35.1"),
    )
    data_dir: str = field(
        default_factory=lambda: os.environ.get("DATA_DIR", "/data/kubernetes"),
    )
    pod_cidr: str = field(
        default_factory=lambda: os.environ.get("POD_CIDR", "192.168.0.0/16"),
    )
    service_cidr: str = field(
        default_factory=lambda: os.environ.get("SERVICE_CIDR", "10.96.0.0/12"),
    )
    hosted_zone_id: str = field(
        default_factory=lambda: os.environ.get("HOSTED_ZONE_ID", ""),
    )
    api_dns_name: str = field(
        default_factory=lambda: os.environ.get("API_DNS_NAME", "k8s-api.k8s.internal"),
    )
    s3_bucket: str = field(
        default_factory=lambda: os.environ.get("S3_BUCKET", ""),
    )
    mount_point: str = field(
        default_factory=lambda: os.environ.get("MOUNT_POINT", "/data"),
    )
    calico_version: str = field(
        default_factory=lambda: os.environ.get("CALICO_VERSION", "v3.29.3"),
    )
    environment: str = field(
        default_factory=lambda: os.environ.get("ENVIRONMENT", "development"),
    )
    node_label: str = field(
        default_factory=lambda: os.environ.get("NODE_LABEL", "role=worker"),
    )
    node_pool: str = field(
        # Exported by worker-asg-stack.ts user-data as ``general`` or
        # ``monitoring``.  Empty string for legacy statically-provisioned
        # workers that do not carry the NODE_POOL variable.
        default_factory=lambda: os.environ.get("NODE_POOL", ""),
    )
    log_group_name: str = field(
        default_factory=lambda: os.environ.get("LOG_GROUP_NAME", ""),
    )
    # Timeout budget constraint: each retry cycle costs ~155s
    # (120s join timeout + ~5s kubeadm reset + 30s sleep).
    # SSM Automation step timeout is 900s, so max safe retries = 5
    # (5 × 155s = 775s, leaving ~125s headroom for S3 sync + setup).
    join_max_retries: int = field(
        default_factory=lambda: int(os.environ.get("JOIN_MAX_RETRIES", "5")),
    )
    join_retry_interval: int = field(
        default_factory=lambda: int(os.environ.get("JOIN_RETRY_INTERVAL", "30")),
    )

    @classmethod
    def from_env(cls) -> BootConfig:
        """Create a BootConfig from the current environment variables."""
        return cls()

    @property
    def admin_conf(self) -> str:
        """Path to the kubeadm admin kubeconfig."""
        return "/etc/kubernetes/admin.conf"

    @property
    def kubeconfig_env(self) -> dict[str, str]:
        """Environment dict with KUBECONFIG set for kubectl commands."""
        return {"KUBECONFIG": self.admin_conf}
