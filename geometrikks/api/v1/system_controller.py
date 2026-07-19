"""System administration API: settings overview and scheduler control.

All /api routes are session-authenticated by middleware; the single admin
is the only user, so no extra guards are needed here.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from litestar import Controller, Request, get, post
from litestar.exceptions import NotFoundException
from litestar.status_codes import HTTP_202_ACCEPTED

from geometrikks.config.introspection import SystemSettingsResponse, build_settings_overview
from geometrikks.config.settings import get_settings
from geometrikks.server.scheduler_tracking import JobRunTracker, JobStatus

if TYPE_CHECKING:
    from apscheduler.job import Job
    from apscheduler.schedulers.asyncio import AsyncIOScheduler


@dataclass
class SchedulerJobView:
    id: str
    name: str
    trigger: str
    next_run_time: datetime | None
    running: bool
    last_run_time: datetime | None
    last_duration_seconds: float | None
    last_status: JobStatus | None
    last_error: str | None


@dataclass
class SchedulerJobsResponse:
    scheduler_enabled: bool
    scheduler_running: bool
    jobs: list[SchedulerJobView]


def _job_view(job: "Job", tracker: JobRunTracker) -> SchedulerJobView:
    info = tracker.get(job.id)
    return SchedulerJobView(
        id=job.id,
        name=job.name,
        trigger=str(job.trigger),
        next_run_time=job.next_run_time,
        running=info.running,
        last_run_time=info.last_start,
        last_duration_seconds=info.last_duration_seconds,
        last_status=info.last_status,
        last_error=info.last_error,
    )


class SystemController(Controller):
    """Settings overview and scheduler administration."""

    path = "/api/v1/system"
    tags = ["System"]

    @get("/settings")
    async def get_system_settings(self) -> SystemSettingsResponse:
        """Full settings tree with descriptions; secrets structurally redacted."""
        return build_settings_overview(get_settings())

    @get("/scheduler/jobs")
    async def get_scheduler_jobs(self, request: Request) -> SchedulerJobsResponse:
        """All scheduled jobs with next-run and tracked last-run state."""
        scheduler: AsyncIOScheduler | None = getattr(request.app.state, "scheduler", None)
        if scheduler is None:
            return SchedulerJobsResponse(
                scheduler_enabled=False, scheduler_running=False, jobs=[]
            )
        tracker: JobRunTracker = (
            getattr(request.app.state, "scheduler_tracker", None) or JobRunTracker()
        )
        return SchedulerJobsResponse(
            scheduler_enabled=get_settings().scheduler.enabled,
            scheduler_running=scheduler.running,
            jobs=[_job_view(job, tracker) for job in scheduler.get_jobs()],
        )

    @post("/scheduler/jobs/{job_id:str}/run", status_code=HTTP_202_ACCEPTED)
    async def run_scheduler_job(self, request: Request, job_id: str) -> SchedulerJobView:
        """Trigger a job ASAP by moving its next_run_time to now.

        The scheduler executes it through its normal machinery, so
        max_instances still prevents overlapping runs and the event tracker
        observes the execution. An interval trigger's cadence restarts from
        the manual run.
        """
        scheduler: AsyncIOScheduler | None = getattr(request.app.state, "scheduler", None)
        if scheduler is None or scheduler.get_job(job_id) is None:
            raise NotFoundException(detail=f"Unknown scheduler job: {job_id}")
        scheduler.modify_job(job_id, next_run_time=datetime.now(timezone.utc))
        tracker: JobRunTracker = (
            getattr(request.app.state, "scheduler_tracker", None) or JobRunTracker()
        )
        return _job_view(scheduler.get_job(job_id), tracker)
