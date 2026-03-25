"""Step 4 — Associate Elastic IP (app-worker only).

On Day-1 and Day-2+ SSM Automation re-runs, self-associates the EIP
to this instance. The EipFailover Lambda handles ASG replacement
events independently — this step covers initial/manual bootstrap.

Gated to app-worker nodes only via ``NODE_LABEL`` check. The monitoring
worker does not need an EIP (no external ingress traffic).

Idempotent: re-associating an already-associated EIP is a no-op.
"""
from __future__ import annotations

from common import (
    StepRunner,
    get_imds_value,
    log_error,
    log_info,
    run_cmd,
    ssm_get,
)
from boot_helpers.config import BootConfig

# ── Constants ──────────────────────────────────────────────────────────────

APP_WORKER_LABEL = "role=application"


# ── Step ───────────────────────────────────────────────────────────────────

def step_associate_eip(cfg: BootConfig) -> None:
    """Step 4: Associate Elastic IP to this instance (app-worker only).

    Args:
        cfg: Bootstrap configuration.
    """
    with StepRunner("associate-eip") as step:
        if step.skipped:
            return

        # Gate: only app-worker nodes get the EIP
        if cfg.node_label != APP_WORKER_LABEL:
            log_info(
                f"Skipping EIP association — NODE_LABEL={cfg.node_label} "
                f"(only {APP_WORKER_LABEL} receives the EIP)"
            )
            step.details["skipped_reason"] = f"not an app-worker (label={cfg.node_label})"
            return

        # 1. Resolve own instance ID from IMDS
        instance_id = get_imds_value("instance-id")
        if not instance_id:
            from common import log_warn
            log_warn("Could not resolve instance ID from IMDS — skipping EIP association")
            step.details["skipped_reason"] = "IMDS unavailable"
            return
        log_info(f"Instance ID: {instance_id}")
        step.details["instance_id"] = instance_id

        # 2. Resolve EIP allocation ID from SSM
        eip_ssm_path = f"{cfg.ssm_prefix}/elastic-ip-allocation-id"
        alloc_id = ssm_get(eip_ssm_path)
        if not alloc_id:
            from common import log_warn
            log_warn(f"EIP allocation ID not found at {eip_ssm_path} — skipping")
            step.details["skipped_reason"] = f"SSM param missing: {eip_ssm_path}"
            return
        log_info(f"EIP Allocation ID: {alloc_id}")
        step.details["allocation_id"] = alloc_id

        # 3. Associate EIP to this instance
        log_info(f"Associating EIP {alloc_id} to instance {instance_id}...")
        result = run_cmd(
            [
                "aws", "ec2", "associate-address",
                "--allocation-id", alloc_id,
                "--instance-id", instance_id,
                "--allow-reassociation",
                "--region", cfg.aws_region,
            ],
            check=False,
            timeout=30,
        )

        if result.returncode == 0:
            log_info(f"✓ EIP {alloc_id} associated to {instance_id}")
            step.details["status"] = "associated"
        else:
            log_error(
                f"EIP association failed (exit {result.returncode}): "
                f"{result.stderr.strip() or result.stdout.strip()}"
            )
            raise RuntimeError(
                f"Failed to associate EIP {alloc_id} to {instance_id}. "
                f"Ensure the instance role has ec2:AssociateAddress permission."
            )
