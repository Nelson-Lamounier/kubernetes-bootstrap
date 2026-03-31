"""Control plane bootstrap step modules.

Each step is in its own file for testability and maintainability.
This package re-exports ``main()`` for the SSM orchestrator.

Usage::

    from cp import main
    main()  # Runs all control plane steps in order
"""
from __future__ import annotations

from boot_helpers.config import BootConfig

from cp.ebs_volume import step_mount_data_volume
from cp.dr_restore import step_restore_from_backup
from cp.kubeadm_init import step_init_kubeadm
from cp.calico import step_install_calico
from cp.ccm import step_install_ccm
from cp.kubectl_access import step_configure_kubectl
from cp.s3_sync import step_sync_manifests
from cp.argocd import step_bootstrap_argocd
from cp.verify import step_verify_cluster
from cp.etcd_backup import step_install_etcd_backup
from cp.token_rotator import step_install_token_rotator

__all__ = [
    "main",
    "step_mount_data_volume",
    "step_restore_from_backup",
    "step_init_kubeadm",
    "step_install_calico",
    "step_install_ccm",
    "step_configure_kubectl",
    "step_sync_manifests",
    "step_bootstrap_argocd",
    "step_verify_cluster",
    "step_install_etcd_backup",
    "step_install_token_rotator",
]


def main() -> None:
    """Run all control plane bootstrap steps in order.

    This is the entry point called by ``control_plane.py``.
    Step 1 (validate AMI) is called directly from ``common.py``.
    """
    cfg = BootConfig.from_env()

    step_mount_data_volume(cfg)     # Step 0
    step_restore_from_backup(cfg)   # Step 2 (DR restore)
    step_init_kubeadm(cfg)          # Step 3
    step_install_calico(cfg)        # Step 4
    step_install_ccm(cfg)           # Step 4b
    step_configure_kubectl(cfg)     # Step 5
    step_sync_manifests(cfg)        # Step 6
    step_bootstrap_argocd(cfg)      # Step 7
    step_verify_cluster(cfg)        # Step 8
    step_install_etcd_backup(cfg)   # Step 10
    step_install_token_rotator(cfg) # Step 11
