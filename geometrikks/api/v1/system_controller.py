"""System administration API: settings overview and scheduler control.

All /api routes are session-authenticated by middleware; the single admin
is the only user, so no extra guards are needed here.
"""

from __future__ import annotations

import platform
from dataclasses import dataclass
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError, version as dist_version
from pathlib import Path
from typing import TYPE_CHECKING

import maxminddb
from litestar import Controller, Request, get, post
from litestar.exceptions import NotFoundException
from litestar.status_codes import HTTP_202_ACCEPTED
from sqlalchemy import text

from geometrikks.config.introspection import SystemSettingsResponse, build_settings_overview
from geometrikks.config.settings import get_settings
from geometrikks.server.logging import get_logger
from geometrikks.server.scheduler_tracking import JobRunTracker, JobStatus
from geometrikks.lib.utils import GeoIPInfoView, geoip_info

if TYPE_CHECKING:
    from apscheduler.job import Job
    from apscheduler.schedulers.asyncio import AsyncIOScheduler

logger = get_logger(__name__)


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


REPO_URL = "https://github.com/GilbN/geometrikks"


@dataclass
class AboutAppView:
    name: str
    version: str
    environment: str
    container: bool
    image_tag: str | None
    started_at: datetime | None


@dataclass
class RuntimeVersionsView:
    python_version: str
    litestar_version: str | None
    apscheduler_version: str | None


@dataclass
class DatabaseVersionsView:
    postgres_version: str | None
    timescaledb_version: str | None
    postgis_version: str | None


@dataclass
class AboutLinksView:
    repository: str
    issues: str


@dataclass
class AboutResponse:
    app: AboutAppView
    runtime: RuntimeVersionsView
    database: DatabaseVersionsView
    geoip: GeoIPInfoView
    links: AboutLinksView


def _dist_version(name: str) -> str | None:
    try:
        return dist_version(name)
    except PackageNotFoundError:
        return None


async def _database_versions() -> DatabaseVersionsView:
    """Server and extension versions; nulls when the DB is unreachable."""
    from geometrikks.server.plugins import get_sqlalchemy_config

    try:
        engine = get_sqlalchemy_config().get_engine()
        async with engine.connect() as conn:
            pg = (await conn.execute(text("SHOW server_version"))).scalar_one()
            rows = (
                await conn.execute(
                    text(
                        "SELECT extname, extversion FROM pg_extension "
                        "WHERE extname IN ('timescaledb', 'postgis')"
                    )
                )
            ).all()
        ext = {name: ver for name, ver in rows}
        return DatabaseVersionsView(
            postgres_version=pg,
            timescaledb_version=ext.get("timescaledb"),
            postgis_version=ext.get("postgis"),
        )
    except Exception:
        # About must render in DB-degraded mode
        return DatabaseVersionsView(
            postgres_version=None, timescaledb_version=None, postgis_version=None
        )


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

    @get("/about")
    async def get_about(self, request: Request) -> AboutResponse:
        """App, runtime, database, and GeoIP metadata for the About page."""
        s = get_settings()
        return AboutResponse(
            app=AboutAppView(
                name=s.name,
                version=s.version,
                environment=s.environment,
                container=s.runtime == "container",
                image_tag=s.image_tag if s.runtime == "container" else None,
                started_at=getattr(request.app.state, "started_at", None),
            ),
            runtime=RuntimeVersionsView(
                python_version=platform.python_version(),
                litestar_version=_dist_version("litestar"),
                apscheduler_version=_dist_version("apscheduler"),
            ),
            database=await _database_versions(),
            geoip=geoip_info(s.geoip.db_path),
            links=AboutLinksView(repository=REPO_URL, issues=f"{REPO_URL}/issues"),
        )

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
        logger.info("scheduler_job_triggered_manually", job_id=job_id)
        scheduler.modify_job(job_id, next_run_time=datetime.now(timezone.utc))
        tracker: JobRunTracker = (
            getattr(request.app.state, "scheduler_tracker", None) or JobRunTracker()
        )
        return _job_view(scheduler.get_job(job_id), tracker)
