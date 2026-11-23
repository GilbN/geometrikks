"""In-memory run tracking for APScheduler jobs.

APScheduler 3.x only knows next_run_time natively; this tracker derives
running state and last-run info from scheduler events. State is process
local and resets on restart by design.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Literal

from apscheduler.events import (
    EVENT_JOB_ERROR,
    EVENT_JOB_EXECUTED,
    EVENT_JOB_MISSED,
    EVENT_JOB_SUBMITTED,
)
from apscheduler.triggers.interval import IntervalTrigger

from geometrikks.server.logging import get_logger

if TYPE_CHECKING:
    from collections.abc import Iterable

    from apscheduler.events import JobEvent, JobExecutionEvent, JobSubmissionEvent
    from apscheduler.job import Job
    from apscheduler.schedulers.base import BaseScheduler

logger = get_logger(__name__)

JobStatus = Literal["success", "error", "missed"]

# A job that runs more often than this counts as failing only once its
# failed runs span this long, so one blip does not raise an advisory.
FAILING_GRACE = timedelta(minutes=10)


@dataclass
class JobRunInfo:
    running: bool = False
    last_start: datetime | None = None
    last_finish: datetime | None = None
    last_duration_seconds: float | None = None
    last_status: JobStatus | None = None
    last_error: str | None = None
    # The end of the first failed run since the last success.
    failing_since: datetime | None = None


class JobRunTracker:
    """Listens to scheduler events and keeps per-job run info in memory."""

    def __init__(self) -> None:
        self._runs: dict[str, JobRunInfo] = {}

    def attach(self, scheduler: BaseScheduler) -> None:
        """Subscribe to the scheduler's job lifecycle events."""
        scheduler.add_listener(self._on_submitted, EVENT_JOB_SUBMITTED)
        scheduler.add_listener(self._on_executed, EVENT_JOB_EXECUTED | EVENT_JOB_ERROR)
        scheduler.add_listener(self._on_missed, EVENT_JOB_MISSED)

    def get(self, job_id: str) -> JobRunInfo:
        """Run info for a job; defaults for jobs that have not fired yet."""
        return self._runs.get(job_id, JobRunInfo())

    def _info(self, job_id: str) -> JobRunInfo:
        return self._runs.setdefault(job_id, JobRunInfo())

    def _on_submitted(self, event: JobSubmissionEvent) -> None:
        info = self._info(event.job_id)
        info.running = True
        info.last_start = datetime.now(UTC)

    def _on_executed(self, event: JobExecutionEvent) -> None:
        info = self._info(event.job_id)
        now = datetime.now(UTC)
        info.running = False
        info.last_finish = now
        if info.last_start is not None:
            info.last_duration_seconds = (now - info.last_start).total_seconds()
        if event.exception is not None:
            info.last_status = "error"
            info.last_error = repr(event.exception)
            if info.failing_since is None:
                info.failing_since = now
            logger.error(
                "scheduler_job_failed",
                job_id=event.job_id,
                error=info.last_error,
                duration_seconds=info.last_duration_seconds,
            )
        else:
            info.last_status = "success"
            info.last_error = None
            info.failing_since = None
            logger.success(  # ty: ignore[unresolved-attribute]
                "scheduler_job_completed",
                job_id=event.job_id,
                duration_seconds=info.last_duration_seconds,
            )

    def _on_missed(self, event: JobEvent) -> None:
        info = self._info(event.job_id)
        # The Scheduler table shows last_error only under an error status.
        if info.last_status != "error":
            info.last_status = "missed"
        logger.warning("scheduler_job_missed", job_id=event.job_id)


def _counts_as_failing(info: JobRunInfo, job: Job) -> bool:
    if info.failing_since is None:
        return False
    if not isinstance(job.trigger, IntervalTrigger) or job.trigger.interval >= FAILING_GRACE:
        return True
    return info.last_finish is not None and info.last_finish - info.failing_since >= FAILING_GRACE


def failing_job_names(jobs: Iterable[Job], tracker: JobRunTracker) -> list[str]:
    """Names of the scheduler's jobs that count as failing, sorted by name."""
    return sorted(job.name for job in jobs if _counts_as_failing(tracker.get(job.id), job))
