"""Subprocess execution with structured logging.

Wraps ``subprocess.run`` with JSON-structured logging so that every
command execution is visible in CloudWatch Logs with its exit code
and duration.

Usage::

    from deploy_helpers.runner import run_cmd

    run_cmd(["aws", "s3", "sync", src, dst, "--region", "eu-west-1"])
"""

from __future__ import annotations

import subprocess
import time
from dataclasses import dataclass

from deploy_helpers.logging import log_error, log_info


@dataclass
class CmdResult:
    """Result of a subprocess execution."""

    returncode: int
    stdout: str
    stderr: str
    command: str
    duration_seconds: float


def run_cmd(
    cmd: list[str],
    *,
    check: bool = True,
    timeout: int = 300,
    capture: bool = True,
) -> CmdResult:
    """Execute a command with structured logging and timing.

    Args:
        cmd: Command as a list of arguments.
        check: Raise ``SystemExit`` on non-zero exit code.
        timeout: Seconds before killing the process.
        capture: Capture stdout/stderr. Set False to stream live.

    Returns:
        CmdResult with exit code, output, and timing.

    Raises:
        SystemExit: If ``check=True`` and command exits non-zero.
        subprocess.TimeoutExpired: If command exceeds ``timeout``.
    """
    cmd_str = " ".join(cmd)
    log_info("Running command", command=cmd_str)

    start = time.monotonic()

    try:
        result = subprocess.run(
            cmd,
            capture_output=capture,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        duration = time.monotonic() - start
        log_error(
            "Command timed out",
            command=cmd_str,
            timeout_seconds=timeout,
            duration_seconds=round(duration, 2),
        )
        raise

    duration = round(time.monotonic() - start, 2)

    cmd_result = CmdResult(
        returncode=result.returncode,
        stdout=result.stdout if capture else "",
        stderr=result.stderr if capture else "",
        command=cmd_str,
        duration_seconds=duration,
    )

    if result.returncode != 0:
        log_error(
            "Command failed",
            command=cmd_str,
            exit_code=result.returncode,
            duration_seconds=duration,
            stderr=(cmd_result.stderr[:500] if capture else ""),
        )
        if check:
            raise SystemExit(result.returncode)
    else:
        log_info(
            "Command succeeded",
            command=cmd_str,
            duration_seconds=duration,
        )

    return cmd_result
