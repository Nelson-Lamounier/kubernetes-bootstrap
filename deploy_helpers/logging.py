"""JSON structured logging for deploy scripts.

Emits one JSON object per line to stdout — parsed natively by
CloudWatch Logs when the SSM RunCommand output is streamed to
a CloudWatch log group.

Mirrors the logging pattern established in ``boot/steps/common.py``
so that all bootstrap and deploy scripts produce consistent,
machine-parseable output.

Usage::

    from deploy_helpers.logging import log_info, log_warn, log_error

    log_info("Resolving secrets", prefix="/nextjs/development")
    log_warn("Parameter not found", param="dynamodb-table-name")
    log_error("Deployment failed", error=str(exc))
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone


def log(level: str, message: str, **kwargs: object) -> None:
    """Emit a structured JSON log line to stdout.

    Args:
        level: Log level (INFO, WARN, ERROR).
        message: Human-readable log message.
        **kwargs: Arbitrary key-value pairs included in the JSON output.
    """
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "message": message,
        **kwargs,
    }
    print(json.dumps(entry, default=str), flush=True)


def log_info(message: str, **kwargs: object) -> None:
    """Emit an INFO-level structured log line."""
    log("INFO", message, **kwargs)


def log_warn(message: str, **kwargs: object) -> None:
    """Emit a WARN-level structured log line."""
    log("WARN", message, **kwargs)


def log_error(message: str, **kwargs: object) -> None:
    """Emit an ERROR-level structured log line."""
    log("ERROR", message, **kwargs)
