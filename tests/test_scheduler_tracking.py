"""JobRunTracker: in-memory last-run/running state from APScheduler events."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import TYPE_CHECKING, cast

import pytest

from geometrikks.server.scheduler_tracking import (
    JobRunInfo,
    JobRunTracker,
    failing_job_names,
)

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


def _fail(tracker: JobRunTracker, job_id: str) -> None:
    tracker._on_executed(
        cast("JobExecutionEvent", SimpleNamespace(job_id=job_id, exception=RuntimeError("boom")))
    )


def _succeed(tracker: JobRunTracker, job_id: str) -> None:
    tracker._on_executed(cast("JobExecutionEvent", SimpleNamespace(job_id=job_id, exception=None)))


def test_failing_since_set_on_first_error_and_kept_on_the_next():
    tracker = JobRunTracker()
    _fail(tracker, "a")
    first = tracker.get("a").failing_since
    assert first is not None
    _fail(tracker, "a")
    assert tracker.get("a").failing_since == first


def test_failing_since_cleared_on_success(configured_logging):
    tracker = JobRunTracker()
    _fail(tracker, "a")
    _succeed(tracker, "a")
    assert tracker.get("a").failing_since is None


def test_missed_run_after_an_error_keeps_the_error():
    tracker = JobRunTracker()
    _fail(tracker, "a")
    first = tracker.get("a").failing_since
    tracker._on_missed(cast("JobEvent", SimpleNamespace(job_id="a")))
    info = tracker.get("a")
    assert info.last_status == "error"
    assert info.last_error is not None
    assert info.failing_since == first


def test_missed_run_after_a_success_is_missed(configured_logging):
    tracker = JobRunTracker()
    _succeed(tracker, "a")
    tracker._on_missed(cast("JobEvent", SimpleNamespace(job_id="a")))
    assert tracker.get("a").last_status == "missed"


def _job(job_id: str, name: str, interval: timedelta):
    from apscheduler.triggers.interval import IntervalTrigger

    return SimpleNamespace(id=job_id, name=name, trigger=IntervalTrigger(seconds=interval.total_seconds()))


def _failing(tracker: JobRunTracker, job_id: str, *, first: datetime, last: datetime) -> None:
    info = tracker._info(job_id)
    info.last_status = "error"
    info.last_error = "RuntimeError('boom')"
    info.failing_since = first
    info.last_finish = last


T0 = datetime(2026, 11, 15, 10, 58, tzinfo=UTC)


def test_no_failing_jobs_gives_no_names():
    tracker = JobRunTracker()
    assert failing_job_names([_job("daily", "Daily", timedelta(days=1))], tracker) == []


def test_daily_job_counts_on_its_first_failure():
    tracker = JobRunTracker()
    _failing(tracker, "daily", first=T0, last=T0)
    assert failing_job_names([_job("daily", "Daily", timedelta(days=1))], tracker) == ["Daily"]


def test_ten_minute_job_counts_on_its_first_failure():
    tracker = JobRunTracker()
    _failing(tracker, "loc", first=T0, last=T0)
    assert failing_job_names([_job("loc", "Location", timedelta(minutes=10))], tracker) == ["Location"]


def test_frequent_job_waits_until_its_failed_runs_span_ten_minutes():
    tracker = JobRunTracker()
    jobs = [_job("minutely", "Minutely", timedelta(minutes=1))]
    _failing(tracker, "minutely", first=T0, last=T0 + timedelta(minutes=5))
    assert failing_job_names(jobs, tracker) == []
    _failing(tracker, "minutely", first=T0, last=T0 + timedelta(minutes=10))
    assert failing_job_names(jobs, tracker) == ["Minutely"]


def test_names_are_sorted_by_name():
    tracker = JobRunTracker()
    jobs = [_job("b", "Zeta", timedelta(days=1)), _job("a", "Alpha", timedelta(hours=6))]
    _failing(tracker, "a", first=T0, last=T0)
    _failing(tracker, "b", first=T0, last=T0)
    assert failing_job_names(jobs, tracker) == ["Alpha", "Zeta"]


def test_a_job_that_succeeds_leaves_the_list(configured_logging):
    tracker = JobRunTracker()
    jobs = [_job("a", "Alpha", timedelta(hours=6)), _job("b", "Beta", timedelta(days=1))]
    _failing(tracker, "a", first=T0, last=T0)
    _failing(tracker, "b", first=T0, last=T0)
    _succeed(tracker, "a")
    assert failing_job_names(jobs, tracker) == ["Beta"]


def test_a_job_the_scheduler_no_longer_has_is_ignored():
    tracker = JobRunTracker()
    _failing(tracker, "gone", first=T0, last=T0)
    assert failing_job_names([], tracker) == []
