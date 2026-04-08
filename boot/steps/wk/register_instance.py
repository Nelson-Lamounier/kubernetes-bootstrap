"""Step 3b — Register ASG instance in SSM after a successful join.

After ``step_join_cluster`` succeeds, this step writes the EC2 instance-id
and hostname to SSM so external tools (``verify-cluster.sh``, observability
scripts) can discover ASG pool membership without querying the EC2 API.

SSM path written::

    {ssm_prefix}/nodes/{node_pool}/{instance_id}  →  hostname

Example::

    /k8s/development/nodes/general/i-0abc123def456789  →  ip-10-0-1-42.eu-west-1.compute.internal

Gate:
    Only runs when ``cfg.node_pool`` is non-empty (i.e. the ``NODE_POOL``
    environment variable was exported by the EC2 user-data block in
    ``worker-asg-stack.ts``).  Legacy statically-provisioned workers that
    lack ``NODE_POOL`` silently skip this step — no SSM write occurs.

Idempotent:
    If the SSM parameter already exists with the correct value the
    ``put_parameter`` call uses ``Overwrite=True``, so re-runs on instance
    replacement always refresh the record to the current hostname.
"""
from __future__ import annotations

import socket

import boto3

from common import (
    StepRunner,
    get_imds_value,
    log_info,
    log_warn,
)
from boot_helpers.config import BootConfig


def _resolve_hostname() -> str:
    """Resolve the EC2 private DNS hostname used as the Kubernetes node name.

    Resolution order:
    1. ``socket.getfqdn()`` — works when the hostname is set correctly by
       EC2 (the normal case).
    2. IMDS ``local-hostname`` — fallback for environments where the OS
       hostname has not yet propagated.

    Returns:
        The FQDN string, or empty string on failure.
    """
    try:
        fqdn = socket.getfqdn()
        if fqdn and fqdn != "localhost":
            return fqdn
    except OSError:
        pass
    return get_imds_value("local-hostname") or ""


def step_register_instance(cfg: BootConfig) -> None:
    """Step 3b: Register this ASG instance in SSM Parameter Store.

    Writes the instance-id → hostname mapping to SSM so external tools can
    discover pool membership without querying the EC2 API.  No-op for legacy
    workers where ``NODE_POOL`` is not set.

    SSM path: ``{ssm_prefix}/nodes/{node_pool}/{instance_id}``
    SSM value: EC2 private DNS hostname (Kubernetes node name)

    Args:
        cfg: Bootstrap configuration.  ``cfg.node_pool`` determines whether
            this step runs and which sub-path is used.
    """
    with StepRunner("register-instance") as step:
        if step.skipped:
            return

        # ── Gate: only run for ASG-managed pool nodes ──────────────────
        if not cfg.node_pool:
            log_info(
                "NODE_POOL not set — skipping SSM instance registration "
                "(legacy statically-provisioned worker)"
            )
            step.details["skipped_reason"] = "NODE_POOL not set"
            return

        # ── Resolve instance-id from IMDS ──────────────────────────────
        instance_id = get_imds_value("instance-id")
        if not instance_id:
            log_warn(
                "Could not retrieve instance-id from IMDS — "
                "skipping SSM registration"
            )
            step.details["skipped_reason"] = "IMDS instance-id unavailable"
            return

        hostname = _resolve_hostname()
        if not hostname:
            log_warn(
                "Could not resolve hostname — skipping SSM registration"
            )
            step.details["skipped_reason"] = "hostname unavailable"
            return

        # ── Write to SSM ───────────────────────────────────────────────
        ssm_path = f"{cfg.ssm_prefix}/nodes/{cfg.node_pool}/{instance_id}"
        log_info(
            f"Registering instance in SSM: {ssm_path} = {hostname}"
        )

        try:
            ssm = boto3.client("ssm", region_name=cfg.aws_region)
            ssm.put_parameter(
                Name=ssm_path,
                Value=hostname,
                Type="String",
                Overwrite=True,
                # Tag the parameter with pool identity so it can be filtered
                # by tag in the AWS console and CLI without inspecting the path.
                Tags=[
                    {"Key": "node-pool", "Value": cfg.node_pool},
                    {"Key": "environment", "Value": cfg.environment},
                ],
            )
            log_info(
                f"✓ Instance registered: {instance_id} → {hostname} "
                f"(pool={cfg.node_pool})"
            )
            step.details["instance_id"] = instance_id
            step.details["hostname"] = hostname
            step.details["node_pool"] = cfg.node_pool
            step.details["ssm_path"] = ssm_path
        except Exception as exc:  # noqa: BLE001
            # Registration failure is non-fatal — the node has already joined
            # the cluster.  Log clearly so CloudWatch captures the issue.
            log_warn(
                f"SSM instance registration failed (non-fatal): {exc}. "
                f"Pool discovery via 'aws ssm get-parameters-by-path "
                f"--path {cfg.ssm_prefix}/nodes/{cfg.node_pool}' will not "
                f"include this instance until the next bootstrap cycle."
            )
            step.details["registration_error"] = str(exc)
