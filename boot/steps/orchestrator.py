#!/usr/bin/env python3
"""
@format
Bootstrap Orchestrator

Runs a sequence of step scripts locally with structured JSON output.
Each step is executed in-process (import + call main()) for speed.

Usage:
    # Control plane (default):
    python3 orchestrator.py

    # Worker node:
    python3 orchestrator.py --mode worker

    # Specific steps only:
    python3 orchestrator.py --steps 01_validate_ami 02_init_kubeadm

    # Dry run (print step list without executing):
    python3 orchestrator.py --dry-run

The orchestrator writes structured status to /tmp/bootstrap-status.json
after each step, and publishes to SSM for remote monitoring.
"""

import argparse
import importlib
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import (
    StepStatus, write_status, ssm_put, log_info, log_error,
    SSM_PREFIX, STATUS_FILE,
)

# =============================================================================
# Step Definitions
# =============================================================================

# Steps are imported and executed in order.
# Each module must have a main() function.

CONTROL_PLANE_STEPS = [
    "01_validate_ami",
    "02_init_kubeadm",
    "03_install_calico",
    "04_configure_kubectl",
    "05_sync_manifests",
    "06_bootstrap_argocd",
    "07_verify_cluster",
]

WORKER_STEPS = [
    "01_validate_ami",
    "join_cluster",
]


# =============================================================================
# Orchestrator
# =============================================================================

def run_steps(step_names: list[str], *, dry_run: bool = False) -> bool:
    """
    Execute steps sequentially. Returns True if all succeeded.

    Args:
        step_names: List of module names (without .py) to execute.
        dry_run: Print step list without executing.
    """
    start_time = time.monotonic()
    statuses: list[StepStatus] = []
    all_ok = True

    log_info(f"Bootstrap orchestrator starting with {len(step_names)} steps")
    log_info(f"Steps: {', '.join(step_names)}")

    if dry_run:
        log_info("DRY RUN — printing step list without execution")
        for i, name in enumerate(step_names, 1):
            log_info(f"  {i}. {name}")
        return True

    for i, name in enumerate(step_names, 1):
        log_info(f"\n{'='*60}")
        log_info(f"Step {i}/{len(step_names)}: {name}")
        log_info(f"{'='*60}")

        step_start = time.monotonic()
        status = StepStatus(
            step_name=name,
            status="running",
            started_at=datetime.now(timezone.utc).isoformat(),
        )

        try:
            # Import and execute
            module = importlib.import_module(name)
            module.main()

            status.status = "success"
            log_info(f"Step {name}: SUCCESS")

        except Exception as e:
            status.status = "failed"
            status.error = str(e)
            all_ok = False
            log_error(f"Step {name}: FAILED — {e}")

        finally:
            duration = time.monotonic() - step_start
            status.duration_seconds = round(duration, 2)
            status.completed_at = datetime.now(timezone.utc).isoformat()
            statuses.append(status)
            write_status(statuses)

        # Publish progress to SSM for remote monitoring
        try:
            ssm_put(
                f"{SSM_PREFIX}/bootstrap/step-status",
                json.dumps({
                    "step": name,
                    "index": i,
                    "total": len(step_names),
                    "status": status.status,
                    "duration": status.duration_seconds,
                }),
            )
        except Exception:
            pass  # Non-fatal: SSM publish failure shouldn't stop bootstrap

        # Stop on failure
        if not all_ok:
            log_error(
                f"Aborting orchestrator — step '{name}' failed. "
                f"Completed {i-1}/{len(step_names)} steps successfully."
            )
            break

    total_duration = round(time.monotonic() - start_time, 2)
    log_info(f"\n{'='*60}")
    log_info(
        f"Orchestrator finished: "
        f"{'ALL PASSED' if all_ok else 'FAILED'} "
        f"({total_duration}s)"
    )
    log_info(f"Status written to: {STATUS_FILE}")

    return all_ok


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
        "--steps",
        nargs="*",
        help="Specific steps to run (overrides --mode)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print step list without executing",
    )

    args = parser.parse_args()

    if args.steps:
        step_names = args.steps
    elif args.mode == "worker":
        step_names = WORKER_STEPS
    else:
        step_names = CONTROL_PLANE_STEPS

    ok = run_steps(step_names, dry_run=args.dry_run)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
