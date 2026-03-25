"""Structured JSON logger for CloudWatch Logs Insights."""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone


class BootstrapLogger:
    """Structured JSON logger for CloudWatch Logs Insights.

    Emits one JSON line per step lifecycle event (start/success/fail/warn/skip)
    alongside existing human-readable log() output. CloudWatch Logs Insights
    auto-detects the JSON and makes fields queryable.

    Usage as context manager::

        logger = BootstrapLogger()
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

        def __init__(self, logger: BootstrapLogger, step_name: str) -> None:
            self._logger = logger
            self._step = step_name
            self._start: float = 0.0

        def __enter__(self) -> BootstrapLogger._StepContext:
            self._start = time.monotonic()
            self._logger._emit(self._step, "info", "start")
            return self

        def __exit__(self, exc_type, exc_val, exc_tb) -> bool:
            elapsed_ms = int((time.monotonic() - self._start) * 1000)
            if exc_type is None:
                self._logger._emit(
                    self._step, "info", "success",
                    duration_ms=elapsed_ms,
                )
            else:
                self._logger._emit(
                    self._step, "error", "fail",
                    msg=str(exc_val),
                    duration_ms=elapsed_ms,
                )
            # Never swallow exceptions — let them propagate
            return False

    def __init__(self) -> None:
        self._step_count = 0

    def step(self, name: str) -> _StepContext:
        """Create a context manager for a named bootstrap step."""
        self._step_count += 1
        return self._StepContext(self, name)

    def warn(self, step: str, msg: str) -> None:
        """Emit a warning event for a step."""
        self._emit(step, "warn", "warn", msg=msg)

    def skip(self, step: str, msg: str) -> None:
        """Emit a skip event for a step."""
        self._emit(step, "info", "skip", msg=msg)

    def _emit(self, step: str, level: str, status: str, *,
              msg: str | None = None,
              duration_ms: int | None = None) -> None:
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
