"""JobRunTracker: in-memory last-run/running state from APScheduler events."""
from __future__ import annotations

from types import SimpleNamespace
from typing import TYPE_CHECKING, cast

import pytest

from geometrikks.server.scheduler_tracking import JobRunInfo, JobRunTracker

if TYPE_CHECKING:
    from apscheduler.events import JobEvent, JobExecutionEvent, JobSubmissionEvent


@pytest.fixture()
def configured_logging(tmp_path, monkeypatch):
    """Configure structlog with the SuccessBoundLogger wrapper class.

    Opt-in (not autouse): only tests that exercise the `.success()` branch
    of `_on_executed` need this. An unconfigured stdlib logger already
    supports `.error()`/`.warning()`, and `config.configure()` mutates
    process-global structlog state with no teardown, so it should only run
    where it is actually needed (see tests/test_logging_pipeline.py for the
    same convention).
    """
    monkeypatch.setenv("LOG_DIR", str(tmp_path / "logs"))
    from geometrikks.config.settings import get_settings
    get_settings.cache_clear()
    from geometrikks.server.logging import create_logging_config
    config = create_logging_config(get_settings())
    config.configure()
    assert config.standard_lib_logging_config is not None
    config.standard_lib_logging_config.configure()


def test_unknown_job_returns_defaults():
    tracker = JobRunTracker()
    info = tracker.get("nope")
    assert info == JobRunInfo()
    assert info.running is False
    assert info.last_status is None


def test_submit_then_success(configured_logging):
    tracker = JobRunTracker()
    tracker._on_submitted(cast("JobSubmissionEvent", SimpleNamespace(job_id="a")))
    assert tracker.get("a").running is True
    assert tracker.get("a").last_start is not None

    tracker._on_executed(cast("JobExecutionEvent", SimpleNamespace(job_id="a", exception=None)))
    info = tracker.get("a")
    assert info.running is False
    assert info.last_status == "success"
    assert info.last_error is None
    assert info.last_duration_seconds is not None
    assert info.last_duration_seconds >= 0


def test_submit_then_error():
    tracker = JobRunTracker()
    tracker._on_submitted(cast("JobSubmissionEvent", SimpleNamespace(job_id="a")))
    tracker._on_executed(
        cast("JobExecutionEvent", SimpleNamespace(job_id="a", exception=RuntimeError("boom")))
    )
    info = tracker.get("a")
    assert info.running is False
    assert info.last_status == "error"
    assert info.last_error is not None
    assert "boom" in info.last_error


def test_missed_event():
    tracker = JobRunTracker()
    tracker._on_missed(cast("JobEvent", SimpleNamespace(job_id="a")))
    info = tracker.get("a")
    assert info.last_status == "missed"
    assert info.running is False


class TestJobOutcomeLogging:
    @pytest.fixture(autouse=True)
    def _configure(self, configured_logging):
        # .success() needs the configured wrapper class.
        pass

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
            tracker._on_submitted(cast("JobSubmissionEvent", FakeSubmit()))
            tracker._on_executed(cast("JobExecutionEvent", FakeExec()))
        assert any(r.levelno == SUCCESS_LEVEL for r in caplog.records)

    def test_error_logged(self, caplog):
        import logging as stdlib_logging
        from geometrikks.server.scheduler_tracking import JobRunTracker

        tracker = JobRunTracker()

        class FakeExec:
            job_id = "job-b"
            exception = RuntimeError("boom")

        with caplog.at_level(stdlib_logging.ERROR, logger="geometrikks.server.scheduler_tracking"):
            tracker._on_executed(cast("JobExecutionEvent", FakeExec()))
        assert any(r.levelno == stdlib_logging.ERROR for r in caplog.records)
