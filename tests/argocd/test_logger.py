"""Unit tests for BootstrapLogger structured JSON logging."""
from __future__ import annotations

import json

from helpers.logger import BootstrapLogger


class TestBootstrapLogger:
    """Verify BootstrapLogger emits correct JSON lifecycle events."""

    def test_step_emits_start_and_success(self, capsys) -> None:
        """A successful step should emit start + success JSON events."""
        logger = BootstrapLogger()

        with logger.step("test_step"):
            pass  # simulate a no-op step

        captured = capsys.readouterr().out
        lines = [line for line in captured.strip().split("\n") if line.startswith("{")]

        assert len(lines) == 2, f"Expected 2 JSON events, got {len(lines)}"

        start_event = json.loads(lines[0])
        success_event = json.loads(lines[1])

        assert start_event["step"] == "test_step"
        assert start_event["status"] == "start"
        assert start_event["level"] == "info"

        assert success_event["step"] == "test_step"
        assert success_event["status"] == "success"
        assert "duration_ms" in success_event

    def test_step_emits_fail_on_exception(self, capsys) -> None:
        """A failing step should emit start + fail JSON events."""
        logger = BootstrapLogger()

        try:
            with logger.step("failing_step"):
                raise RuntimeError("something broke")
        except RuntimeError:
            pass

        captured = capsys.readouterr().out
        lines = [line for line in captured.strip().split("\n") if line.startswith("{")]

        assert len(lines) == 2

        fail_event = json.loads(lines[1])
        assert fail_event["step"] == "failing_step"
        assert fail_event["status"] == "fail"
        assert "something broke" in fail_event.get("msg", "")

    def test_skip_emits_single_event(self, capsys) -> None:
        """skip() should emit a single JSON event with status=skip."""
        logger = BootstrapLogger()
        logger.skip("optional_step", "not needed")

        captured = capsys.readouterr().out
        lines = [line for line in captured.strip().split("\n") if line.startswith("{")]

        assert len(lines) == 1

        skip_event = json.loads(lines[0])
        assert skip_event["step"] == "optional_step"
        assert skip_event["status"] == "skip"
        assert skip_event["msg"] == "not needed"

    def test_json_events_are_valid_json(self, capsys) -> None:
        """All emitted lines starting with '{' must be valid JSON."""
        logger = BootstrapLogger()

        with logger.step("json_check"):
            pass

        captured = capsys.readouterr().out
        for line in captured.strip().split("\n"):
            if line.startswith("{"):
                parsed = json.loads(line)  # Raises JSONDecodeError if invalid
                assert "ts" in parsed
                assert "step" in parsed

    def test_duration_is_non_negative(self, capsys) -> None:
        """The duration_ms field should be >= 0."""
        logger = BootstrapLogger()

        with logger.step("timed_step"):
            pass

        captured = capsys.readouterr().out
        lines = [line for line in captured.strip().split("\n") if line.startswith("{")]

        success_event = json.loads(lines[1])
        assert success_event["duration_ms"] >= 0
