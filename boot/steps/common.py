#!/usr/bin/env python3
"""
@format
Common utilities for K8s bootstrap step scripts.

Provides structured logging, subprocess execution, SSM helpers, and
idempotency guards used by all step scripts.

Usage from a step script:
    from common import StepRunner, run_cmd, ssm_get, ssm_put, log
"""

import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Union


# =============================================================================
# Configuration
# =============================================================================

STATUS_FILE = Path("/tmp/bootstrap-status.json")
SSM_PREFIX = os.environ.get("SSM_PREFIX", "/k8s/development")
AWS_REGION = os.environ.get("AWS_REGION", "eu-west-1")


# =============================================================================
# Structured Logging
# =============================================================================

def log(level: str, message: str, **kwargs) -> None:
    """Emit a structured log line to stdout."""
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "message": message,
        **kwargs,
    }
    print(json.dumps(entry), flush=True)


def log_info(message: str, **kwargs) -> None:
    log("INFO", message, **kwargs)


def log_warn(message: str, **kwargs) -> None:
    log("WARN", message, **kwargs)


def log_error(message: str, **kwargs) -> None:
    log("ERROR", message, **kwargs)


# =============================================================================
# Command Execution
# =============================================================================

@dataclass
class CmdResult:
    """Result of a subprocess execution."""
    returncode: int
    stdout: str
    stderr: str
    command: str
    duration_seconds: float


def run_cmd(
    cmd: Union[List[str], str],
    *,
    shell: bool = False,
    check: bool = True,
    timeout: int = 300,
    env: Optional[dict] = None,
    capture: bool = True,
) -> CmdResult:
    """
    Execute a command with structured logging and timing.

    Args:
        cmd: Command as list of args or string (if shell=True).
        shell: Run through shell interpreter.
        check: Raise on non-zero exit code.
        timeout: Seconds before killing the process.
        env: Additional environment variables (merged with os.environ).
        capture: Capture stdout/stderr (False to stream live).

    Returns:
        CmdResult with exit code, output, and timing.

    Raises:
        subprocess.CalledProcessError: If check=True and command fails.
    """
    cmd_str = cmd if isinstance(cmd, str) else " ".join(cmd)
    log_info(f"Running: {cmd_str}")

    merged_env = {**os.environ, **(env or {})}
    start = time.monotonic()

    try:
        result = subprocess.run(
            cmd,
            shell=shell,
            capture_output=capture,
            text=True,
            timeout=timeout,
            env=merged_env,
        )
    except subprocess.TimeoutExpired as e:
        duration = time.monotonic() - start
        log_error(f"Command timed out after {timeout}s", command=cmd_str)
        raise

    duration = time.monotonic() - start

    cmd_result = CmdResult(
        returncode=result.returncode,
        stdout=result.stdout if capture else "",
        stderr=result.stderr if capture else "",
        command=cmd_str,
        duration_seconds=round(duration, 2),
    )

    if result.returncode != 0:
        log_error(
            f"Command failed (exit {result.returncode})",
            command=cmd_str,
            duration=cmd_result.duration_seconds,
            stderr=cmd_result.stderr[:500] if capture else "",
        )
        if check:
            raise subprocess.CalledProcessError(
                result.returncode, cmd,
                output=result.stdout, stderr=result.stderr,
            )
    else:
        log_info(
            f"Command succeeded",
            command=cmd_str,
            duration=cmd_result.duration_seconds,
        )

    return cmd_result


# =============================================================================
# SSM Parameter Store Helpers
# =============================================================================

def ssm_get(name: str, *, decrypt: bool = False) -> Optional[str]:
    """
    Get an SSM parameter value. Returns None if not found.

    Args:
        name: Full parameter name (e.g. /k8s/development/join-token).
        decrypt: Use --with-decryption for SecureString parameters.
    """
    cmd = [
        "aws", "ssm", "get-parameter",
        "--name", name,
        "--query", "Parameter.Value",
        "--output", "text",
        "--region", AWS_REGION,
    ]
    if decrypt:
        cmd.append("--with-decryption")

    try:
        result = run_cmd(cmd, check=False)
        if result.returncode == 0 and result.stdout.strip() not in ("None", ""):
            return result.stdout.strip()
    except Exception:
        pass
    return None


def ssm_put(name: str, value: str, *, param_type: str = "String") -> None:
    """
    Write an SSM parameter (creates or overwrites).

    Args:
        name: Full parameter name.
        value: Parameter value.
        param_type: SSM parameter type (String, SecureString, StringList).
    """
    run_cmd([
        "aws", "ssm", "put-parameter",
        "--name", name,
        "--value", value,
        "--type", param_type,
        "--overwrite",
        "--region", AWS_REGION,
    ])


# =============================================================================
# Idempotency Guards
# =============================================================================

def is_already_done(marker_file: str) -> bool:
    """Check if a step has already completed (marker file exists)."""
    return Path(marker_file).exists()


def mark_done(marker_file: str) -> None:
    """Create a marker file indicating step completion."""
    Path(marker_file).touch()


# =============================================================================
# Step Status Reporting
# =============================================================================

@dataclass
class StepStatus:
    """Status of a single bootstrap step."""
    step_name: str
    status: str  # "running", "success", "failed", "skipped"
    started_at: str = ""
    completed_at: str = ""
    duration_seconds: float = 0.0
    error: str = ""
    details: dict = field(default_factory=dict)


def write_status(statuses: list[StepStatus]) -> None:
    """Write step statuses to the status file (JSON)."""
    data = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "steps": [asdict(s) for s in statuses],
    }
    STATUS_FILE.write_text(json.dumps(data, indent=2))


# =============================================================================
# Step Runner
# =============================================================================

class StepRunner:
    """
    Context manager for running a bootstrap step with timing and status reporting.

    Usage:
        with StepRunner("validate-ami") as step:
            # ... step logic ...
            step.details["binaries_found"] = ["kubeadm", "kubelet"]

        # On success: step.status = "success"
        # On exception: step.status = "failed", step.error = str(exception)
    """

    def __init__(self, step_name: str, *, skip_if: Optional[str] = None):
        """
        Args:
            step_name: Human-readable step name for logging.
            skip_if: Path to marker file — if it exists, step is skipped.
        """
        self.step_name = step_name
        self.skip_if = skip_if
        self._status = StepStatus(step_name=step_name, status="running")
        self._start_time = 0.0
        self.details: dict = {}

    def __enter__(self):
        # Check idempotency guard
        if self.skip_if and is_already_done(self.skip_if):
            log_info(f"Step '{self.step_name}' already completed — skipping",
                     marker=self.skip_if)
            self._status.status = "skipped"
            return self

        log_info(f"=== Starting step: {self.step_name} ===")
        self._status.started_at = datetime.now(timezone.utc).isoformat()
        self._start_time = time.monotonic()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self._status.status == "skipped":
            return False  # Don't suppress exceptions (none expected)

        duration = time.monotonic() - self._start_time
        self._status.duration_seconds = round(duration, 2)
        self._status.completed_at = datetime.now(timezone.utc).isoformat()
        self._status.details = self.details

        if exc_type is not None:
            self._status.status = "failed"
            self._status.error = str(exc_val)
            log_error(
                f"Step '{self.step_name}' FAILED in {duration:.1f}s",
                error=str(exc_val),
            )
            return False  # Propagate exception

        self._status.status = "success"
        log_info(f"Step '{self.step_name}' completed in {duration:.1f}s")

        # Mark done if idempotency marker is configured
        if self.skip_if:
            mark_done(self.skip_if)

        return False

    @property
    def skipped(self) -> bool:
        return self._status.status == "skipped"

    @property
    def status(self) -> StepStatus:
        return self._status
