#!/usr/bin/env python3
"""
@format
Bootstrap Orchestrator

Runs the consolidated bootstrap scripts based on node mode.

Usage:
    # Control plane (default):
    python3 orchestrator.py

    # Worker node:
    python3 orchestrator.py --mode worker

    # Dry run (print step list without executing):
    python3 orchestrator.py --dry-run

The orchestrator delegates to control_plane.main() or worker.main()
which handle structured status logging and step sequencing internally.
"""

import argparse
import importlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import log_info


# =============================================================================
# Module Definitions
# =============================================================================

MODULES = {
    "control-plane": "control_plane",
    "worker": "worker",
}


# =============================================================================
# CLI
# =============================================================================

def main() -> None:
    parser = argparse.ArgumentParser(description="K8s Bootstrap Orchestrator")
    parser.add_argument(
        "--mode",
        choices=["control-plane", "worker"],
        default="control-plane",
        help="Bootstrap mode (default: control-plane)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print step list without executing",
    )

    args = parser.parse_args()
    module_name = MODULES[args.mode]

    if args.dry_run:
        log_info(f"DRY RUN — would execute: {module_name}.main()")
        log_info(f"Mode: {args.mode}")
        return

    log_info(f"Orchestrator starting: mode={args.mode}, module={module_name}")
    module = importlib.import_module(module_name)
    module.main()
    log_info("Orchestrator finished")


if __name__ == "__main__":
    main()
