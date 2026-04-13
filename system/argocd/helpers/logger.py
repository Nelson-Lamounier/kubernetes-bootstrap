"""Structured JSON logger for CloudWatch Logs Insights with SSM step-status markers."""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from typing import Optional


class BootstrapLogger:
    """Structured JSON logger for CloudWatch Logs Insights.

    Emits one JSON line per step lifecycle event (start/success/fail/warn/skip)
    alongside existing human-readable log() output. CloudWatch Logs Insights
    auto-detects the JSON and makes fields queryable.

    Optionally writes a JSON status blob to SSM Parameter Store at::

        ``{ssm_prefix}/bootstrap/status/argocd/{step_name}``

    on every lifecycle event when ``ssm_prefix`` and ``aws_region`` are provided.
    SSM writes are best-effort — a failure never blocks the bootstrap.

    Usage as context manager::

        logger = BootstrapLogger(ssm_prefix=cfg.ssm_prefix, aws_region=cfg.aws_region)
        with logger.step("install_argocd"):
            install_argocd(cfg)

    Emits on entry::

        {"ts":"...","step":"install_argocd","level":"info","status":"start"}

    Emits on exit::

        {"ts":"...","step":"install_argocd","level":"info","status":"success","duration_ms":4523}

    Or on failure::

        {"ts":"...","step":"install_argocd","level":"error","status":"fail","msg":"...","duration_ms":4523}
    """

    class _StepContext:
        """Context manager for a single bootstrap step."""

        def __init__(
            self,
            logger: "BootstrapLogger",
            step_name: str,
        ) -> None:
            self._logger = logger
            self._step = step_name
            self._start: float = 0.0

        def __enter__(self) -> "BootstrapLogger._StepContext":
            self._start = time.monotonic()
            self._logger._emit(self._step, "info", "start")
            self._logger._write_ssm_status(self._step, "running")
            return self

        def __exit__(self, exc_type, exc_val, exc_tb) -> bool:
            elapsed_ms = int((time.monotonic() - self._start) * 1000)
            elapsed_s = round(elapsed_ms / 1000, 2)
            if exc_type is None:
                self._logger._emit(
                    self._step, "info", "success",
                    duration_ms=elapsed_ms,
                )
                self._logger._write_ssm_status(
                    self._step, "success", elapsed_s=elapsed_s,
                )
            else:
                error_msg = str(exc_val)
                self._logger._emit(
                    self._step, "error", "fail",
                    msg=error_msg,
                    duration_ms=elapsed_ms,
                )
                self._logger._write_ssm_status(
                    self._step, "failed",
                    elapsed_s=elapsed_s,
                    error=error_msg,
                )
            # Never swallow exceptions — let them propagate
            return False

    def __init__(
        self,
        *,
        ssm_prefix: Optional[str] = None,
        aws_region: Optional[str] = None,
    ) -> None:
        """Initialise the logger.

        Args:
            ssm_prefix:  SSM parameter prefix (e.g. ``/k8s/development``).
                         When provided, step-status markers are written to
                         ``{ssm_prefix}/bootstrap/status/argocd/{step_name}``.
            aws_region:  AWS region for SSM writes (e.g. ``eu-west-1``).
        """
        self._step_count = 0
        self._ssm_prefix = ssm_prefix
        self._aws_region = aws_region

    def step(self, name: str) -> _StepContext:
        """Create a context manager for a named bootstrap step."""
        self._step_count += 1
        return self._StepContext(self, name)

    def warn(self, step: str, msg: str) -> None:
        """Emit a warning event for a step."""
        self._emit(step, "warn", "warn", msg=msg)

    def skip(self, step: str, msg: str) -> None:
        """Emit a skip event for a step and write an SSM skipped marker."""
        self._emit(step, "info", "skip", msg=msg)
        self._write_ssm_status(step, "skipped")

    def _emit(
        self,
        step: str,
        level: str,
        status: str,
        *,
        msg: Optional[str] = None,
        duration_ms: Optional[int] = None,
    ) -> None:
        """Write a single JSON line to stdout."""
        event: dict[str, object] = {
            "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "step": step,
            "level": level,
            "status": status,
        }
        if msg is not None:
            event["msg"] = msg
        if duration_ms is not None:
            event["duration_ms"] = duration_ms
        print(json.dumps(event), flush=True)

    def _write_ssm_status(
        self,
        step: str,
        status: str,
        *,
        elapsed_s: float = 0.0,
        error: str = "",
    ) -> None:
        """Write step status JSON to SSM Parameter Store (best-effort).

        Writes to ``{ssm_prefix}/bootstrap/status/argocd/{step}``.
        No-ops silently when ``ssm_prefix`` or ``aws_region`` are not set.
        SSM errors are printed as warnings and never propagated.

        Args:
            step:      Step name key.
            status:    One of ``"running"``, ``"success"``, ``"failed"``, ``"skipped"``.
            elapsed_s: Elapsed seconds (populated on exit events).
            error:     Error message string (populated on failure only).
        """
        if not self._ssm_prefix or not self._aws_region:
            return

        param_name = f"{self._ssm_prefix}/bootstrap/status/argocd/{step}"
        payload: dict[str, object] = {
            "script": "bootstrap_argocd",
            "step": step,
            "status": status,
            "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        if elapsed_s:
            payload["elapsed_s"] = elapsed_s
        if error:
            # Truncate to 3 KB — SSM Standard tier limit is 4 KB total
            payload["error"] = error[:3000]

        try:
            import boto3

            boto3.client("ssm", region_name=self._aws_region).put_parameter(
                Name=param_name,
                Value=json.dumps(payload),
                Type="String",
                Overwrite=True,
            )
        except Exception as exc:  # noqa: BLE001
            # Non-fatal — log to stdout (captured by CloudWatch) and continue
            print(
                json.dumps({
                    "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "level": "warn",
                    "step": step,
                    "msg": f"SSM step-status write failed (non-fatal): {exc}",
                }),
                flush=True,
            )
