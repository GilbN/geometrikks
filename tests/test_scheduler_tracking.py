"""JobRunTracker: in-memory last-run/running state from APScheduler events."""
from __future__ import annotations

from types import SimpleNamespace

from geometrikks.server.scheduler_tracking import JobRunInfo, JobRunTracker


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
