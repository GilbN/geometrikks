"""JobRunTracker: in-memory last-run/running state from APScheduler events."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from geometrikks.server.scheduler_tracking import JobRunInfo, JobRunTracker


@pytest.fixture(autouse=True)
def _configure_logging(tmp_path, monkeypatch):
    """Configure structlog so logger.success()/.error() work in _on_executed.

    Module-wide autouse: _on_executed now logs on every call, so every test
    in this file (not just the outcome-logging ones) needs the configured
    wrapper class, not just the .success() calls.
    """
    monkeypatch.setenv("LOG_DIR", str(tmp_path / "logs"))
    from geometrikks.config.settings import get_settings
    get_settings.cache_clear()
    from geometrikks.server.logging import create_logging_config
    config = create_logging_config(get_settings())
    config.configure()
    config.standard_lib_logging_config.configure()


def test_unknown_job_returns_defaults():
    tracker = JobRunTracker()
    info = tracker.get("nope")
    assert info == JobRunInfo()
    assert info.running is False
    assert info.last_status is None


def test_submit_then_success():
    tracker = JobRunTracker()
    tracker._on_submitted(SimpleNamespace(job_id="a"))
    assert tracker.get("a").running is True
    assert tracker.get("a").last_start is not None

    tracker._on_executed(SimpleNamespace(job_id="a", exception=None))
    info = tracker.get("a")
    assert info.running is False
    assert info.last_status == "success"
    assert info.last_error is None
    assert info.last_duration_seconds is not None
    assert info.last_duration_seconds >= 0


def test_submit_then_error():
    tracker = JobRunTracker()
    tracker._on_submitted(SimpleNamespace(job_id="a"))
    tracker._on_executed(SimpleNamespace(job_id="a", exception=RuntimeError("boom")))
    info = tracker.get("a")
    assert info.running is False
    assert info.last_status == "error"
    assert "boom" in info.last_error


def test_missed_event():
    tracker = JobRunTracker()
    tracker._on_missed(SimpleNamespace(job_id="a"))
    info = tracker.get("a")
    assert info.last_status == "missed"
    assert info.running is False


class TestJobOutcomeLogging:
    def test_success_logged_at_success_level(self, caplog):
        from geometrikks.server.logging import SUCCESS_LEVEL
        from geometrikks.server.scheduler_tracking import JobRunTracker

        tracker = JobRunTracker()

        class FakeSubmit:
            job_id = "job-a"

        class FakeExec:
            job_id = "job-a"
            exception = None

        with caplog.at_level(SUCCESS_LEVEL, logger="geometrikks.server.scheduler_tracking"):
            tracker._on_submitted(FakeSubmit())
            tracker._on_executed(FakeExec())
        assert any(r.levelno == SUCCESS_LEVEL for r in caplog.records)

    def test_error_logged(self, caplog):
        import logging as stdlib_logging
        from geometrikks.server.scheduler_tracking import JobRunTracker

        tracker = JobRunTracker()

        class FakeExec:
            job_id = "job-b"
            exception = RuntimeError("boom")

        with caplog.at_level(stdlib_logging.ERROR, logger="geometrikks.server.scheduler_tracking"):
            tracker._on_executed(FakeExec())
        assert any(r.levelno == stdlib_logging.ERROR for r in caplog.records)
