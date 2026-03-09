#!/usr/bin/env python3
"""
@format
Step 01a — Associate Elastic IP

Associates the CDK-managed Elastic IP with the current instance.
Reads the EIP allocation ID from SSM, calls ec2:AssociateAddress,
and verifies the association via IMDS.

Runs BEFORE kubeadm init so the instance has its stable public IP
before any services depend on it.

Idempotent: verifies current public IP matches the EIP before
attempting association. Skips if already correct.

Expected environment variables:
    SSM_PREFIX  — SSM parameter prefix (e.g. /k8s/development)
    AWS_REGION  — AWS region
"""

import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import (
    StepRunner, run_cmd, ssm_get, log_info, log_warn, log_error,
)


# =============================================================================
# Configuration
# =============================================================================

SSM_PREFIX = os.environ.get("SSM_PREFIX", "/k8s/development")
AWS_REGION = os.environ.get("AWS_REGION", "eu-west-1")
MAX_RETRIES = 10
RETRY_INTERVAL = 3


# =============================================================================
# IMDS v2 Helper
# =============================================================================

def get_imds_value(path: str) -> str:
    """Fetch a value from EC2 Instance Metadata Service v2."""
    token = run_cmd(
        ["curl", "-sX", "PUT", "http://169.254.169.254/latest/api/token",
         "-H", "X-aws-ec2-metadata-token-ttl-seconds: 21600"],
        check=True,
    ).stdout.strip()

    result = run_cmd(
        ["curl", "-s", "-H", f"X-aws-ec2-metadata-token: {token}",
         f"http://169.254.169.254/latest/meta-data/{path}"],
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


# =============================================================================
# EIP Association
# =============================================================================

def associate_eip() -> None:
    """Associate the Elastic IP with the current instance.

    Flow:
        1. Read allocation ID from SSM
        2. Read expected EIP from SSM
        3. Get current public IP from IMDS
        4. Skip if already matches (idempotent)
        5. Associate and verify with retry
    """
    # Read EIP info from SSM (written by CDK base-stack)
    allocation_id = ssm_get(f"{SSM_PREFIX}/elastic-ip-allocation-id")
    if not allocation_id:
        log_warn(
            "No EIP allocation ID found in SSM "
            f"({SSM_PREFIX}/elastic-ip-allocation-id). "
            "Skipping EIP association."
        )
        return

    expected_eip = ssm_get(f"{SSM_PREFIX}/elastic-ip") or ""
    instance_id = get_imds_value("instance-id")
    current_ip = get_imds_value("public-ipv4")

    log_info(f"Instance ID:     {instance_id}")
    log_info(f"Current IP:      {current_ip}")
    log_info(f"Expected EIP:    {expected_eip}")
    log_info(f"Allocation ID:   {allocation_id}")

    # Idempotent: if already associated, skip
    if current_ip and expected_eip and current_ip == expected_eip:
        log_info("EIP already associated — nothing to do")
        return

    # Associate the EIP
    log_info(f"Associating EIP {allocation_id} with instance {instance_id}")
    result = run_cmd(
        ["aws", "ec2", "associate-address",
         "--instance-id", instance_id,
         "--allocation-id", allocation_id,
         "--region", AWS_REGION],
        check=False,
    )

    if result.returncode != 0:
        log_error(f"EIP association failed: {result.stderr}")
        raise RuntimeError(
            f"Failed to associate EIP {allocation_id}: {result.stderr}"
        )

    association = json.loads(result.stdout) if result.stdout else {}
    log_info(
        f"EIP association requested: "
        f"{association.get('AssociationId', 'unknown')}"
    )

    # Verify via IMDS with retry (IMDS metadata refresh takes a few seconds)
    for attempt in range(1, MAX_RETRIES + 1):
        time.sleep(RETRY_INTERVAL)
        refreshed_ip = get_imds_value("public-ipv4")
        log_info(
            f"Verification attempt {attempt}/{MAX_RETRIES}: "
            f"public IP = {refreshed_ip}"
        )

        if refreshed_ip == expected_eip:
            log_info(f"EIP association verified: {refreshed_ip}")
            return

    # Final check — if expected_eip was empty, accept whatever IMDS shows
    final_ip = get_imds_value("public-ipv4")
    if final_ip and final_ip != current_ip:
        log_info(f"Public IP changed to {final_ip} (EIP likely associated)")
        return

    log_warn(
        f"EIP verification timed out after {MAX_RETRIES * RETRY_INTERVAL}s. "
        f"Expected {expected_eip}, got {final_ip}. "
        "Continuing — association may still be propagating."
    )


# =============================================================================
# Main
# =============================================================================

def main() -> None:
    with StepRunner("associate-eip") as step:
        if step.skipped:
            return
        associate_eip()


if __name__ == "__main__":
    main()
