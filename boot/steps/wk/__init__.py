"""Worker node bootstrap step modules.

Each step is in its own file for testability and maintainability.
This package re-exports ``main()`` for the SSM orchestrator.

Usage::

    from wk import main
    main()  # Runs all worker steps in order
"""
from __future__ import annotations

from common import step_install_cloudwatch_agent, step_validate_ami
from boot_helpers.config import BootConfig

from wk.join_cluster import step_join_cluster
from wk.register_instance import step_register_instance
from wk.stale_pvs import step_clean_stale_pvs
from wk.verify_membership import step_verify_cluster_membership

__all__ = [
    "main",
    "step_join_cluster",
    "step_register_instance",
    "step_clean_stale_pvs",
    "step_verify_cluster_membership",
]


def main() -> None:
    """Run all worker node bootstrap steps in order.

    This is the entry point called by ``worker.py``.
    """
    cfg = BootConfig.from_env()

    step_validate_ami()                    # Step 1 (from common)
    step_join_cluster(cfg)                 # Step 2
    step_register_instance(cfg)            # Step 3b — SSM pool membership record
    step_install_cloudwatch_agent()        # Step 3 (from common)
    step_clean_stale_pvs(cfg)              # Step 4
    step_verify_cluster_membership(cfg)    # Step 5
