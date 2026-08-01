"""System administration API: settings overview and scheduler control.

All /api routes are session-authenticated by middleware; the single admin
is the only user, so no extra guards are needed here.
"""

from __future__ import annotations

import platform

import msgspec
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError, version as dist_version
from typing import TYPE_CHECKING

from litestar import Controller, Litestar, Request, get, post
from litestar.di import NamedDependency
from litestar.exceptions import NotFoundException
from litestar.params import FromPath, SkipValidation
from litestar.status_codes import HTTP_202_ACCEPTED
from sqlalchemy import text

from geometrikks.config.introspection import (
    ComputedField,
    SystemSettingsResponse,
    build_settings_overview,
)
from geometrikks.config.settings import Settings
from geometrikks.server import runtime
from geometrikks.server.logging import get_logger
from geometrikks.server.scheduler_tracking import JobRunTracker, JobStatus
from geometrikks.lib.utils import GeoIPInfoView, geoip_info

if TYPE_CHECKING:
    from apscheduler.job import Job

logger = get_logger(__name__)


class SchedulerJobView(msgspec.Struct, rename="camel"):
    id: str
    name: str
    trigger: str
    next_run_time: datetime | None
    running: bool
    last_run_time: datetime | None
    last_duration_seconds: float | None
    last_status: JobStatus | None
    last_error: str | None


class SchedulerJobsResponse(msgspec.Struct, rename="camel"):
    scheduler_enabled: bool
    scheduler_running: bool
    jobs: list[SchedulerJobView]


REPO_URL = "https://github.com/GilbN/geometrikks"


class AboutAppView(msgspec.Struct, rename="camel"):
    name: str
    version: str
    environment: str
    container: bool
    image_tag: str | None
    started_at: datetime | None


class RuntimeVersionsView(msgspec.Struct, rename="camel"):
    python_version: str
    litestar_version: str | None
    apscheduler_version: str | None


class DatabaseVersionsView(msgspec.Struct, rename="camel"):
    postgres_version: str | None
    timescaledb_version: str | None
    postgis_version: str | None


class AboutLinksView(msgspec.Struct, rename="camel"):
    repository: str
    issues: str


class AboutResponse(msgspec.Struct, rename="camel"):
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


async def _database_versions(app: Litestar) -> DatabaseVersionsView:
    """Server and extension versions; nulls when the DB is unreachable."""
    from geometrikks.server.plugins import get_app_db_config

    try:
        engine = get_app_db_config(app).get_engine()
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


class HypertableStatsView(msgspec.Struct, rename="camel"):
    name: str
    approx_rows: int | None
    total_bytes: int | None
    # Compression stats; nulls until the compression policy has compressed
    # at least one chunk.
    before_compression_bytes: int | None
    after_compression_bytes: int | None


class DatabaseInfoResponse(msgspec.Struct, rename="camel"):
    reachable: bool
    size_bytes: int | None
    postgres_version: str | None
    timescaledb_version: str | None
    retention_days: int
    debug_retention_days: int
    hypertables: list[HypertableStatsView]


HYPERTABLE_NAMES = ("geo_events", "access_logs", "access_log_debug")


async def _database_stats(app: Litestar) -> tuple[int | None, list[HypertableStatsView]]:
    """Database size and per-hypertable stats; (None, []) when unreachable.

    Uses TimescaleDB catalog-backed functions (approximate_row_count,
    hypertable_size, hypertable_compression_stats), so this stays fast at
    tens of millions of rows.
    """
    from geometrikks.server.plugins import get_app_db_config

    try:
        engine = get_app_db_config(app).get_engine()
        async with engine.connect() as conn:
            size = (
                await conn.execute(text("SELECT pg_database_size(current_database())"))
            ).scalar_one()
            tables: list[HypertableStatsView] = []
            for name in HYPERTABLE_NAMES:
                try:
                    approx = (
                        await conn.execute(
                            text("SELECT approximate_row_count(CAST(:t AS regclass))"),
                            {"t": name},
                        )
                    ).scalar()
                    total = (
                        await conn.execute(
                            text("SELECT hypertable_size(CAST(:t AS regclass))"),
                            {"t": name},
                        )
                    ).scalar()
                    compression = (
                        await conn.execute(
                            text(
                                "SELECT before_compression_total_bytes, "
                                "after_compression_total_bytes "
                                "FROM hypertable_compression_stats(CAST(:t AS regclass))"
                            ),
                            {"t": name},
                        )
                    ).first()
                    tables.append(
                        HypertableStatsView(
                            name=name,
                            approx_rows=approx,
                            total_bytes=total,
                            before_compression_bytes=compression[0] if compression else None,
                            after_compression_bytes=compression[1] if compression else None,
                        )
                    )
                except Exception:
                    logger.warning("Hypertable stats unavailable for %s", name)
            return size, tables
    except Exception:
        # The Status page must render in DB-degraded mode
        return None, []


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


def _computed_settings_overlay(
    settings: Settings, app: Litestar
) -> dict[tuple[str, str], ComputedField]:
    """Runtime-resolved values the raw config does not expose."""
    overlay: dict[tuple[str, str], ComputedField] = {}

    home = runtime.get_map_home_location(app)
    if home is not None and home.source == "external_ip":
        overlay[("map", "home_latitude")] = ComputedField(home.latitude, "external_ip")
        overlay[("map", "home_longitude")] = ComputedField(home.longitude, "external_ip")

    overlay[("geoip", "available")] = ComputedField(
        runtime.is_geoip_available(app),
        "runtime",
        "Whether a usable GeoLite2 database is loaded",
    )

    overlay[("crowdsec", "enabled")] = ComputedField(settings.crowdsec.enabled, "runtime")
    overlay[("crowdsec", "write_enabled")] = ComputedField(
        settings.crowdsec.write_enabled, "runtime"
    )
    return overlay


class SystemController(Controller):
    """Settings overview and scheduler administration."""

    path = "/system"
    tags = ["System"]

    @get("/settings")
    async def get_system_settings(
        self, request: Request, settings: NamedDependency[SkipValidation[Settings]]
    ) -> SystemSettingsResponse:
        """Full settings tree with descriptions; secrets structurally redacted.

        Overlays runtime-resolved values (auto-detected map home, GeoIP
        availability, CrowdSec effective status) that the raw config omits.
        """
        overlay = _computed_settings_overlay(settings, request.app)
        return build_settings_overview(settings, computed=overlay)

    @get("/about")
    async def get_about(
        self, request: Request, settings: NamedDependency[SkipValidation[Settings]]
    ) -> AboutResponse:
        """App, runtime, database, and GeoIP metadata for the About page."""
        s = settings
        return AboutResponse(
            app=AboutAppView(
                name=s.name,
                version=s.version,
                environment=s.environment,
                container=s.runtime == "container",
                image_tag=s.image_tag if s.runtime == "container" else None,
                started_at=runtime.get_started_at(request.app),
            ),
            runtime=RuntimeVersionsView(
                python_version=platform.python_version(),
                litestar_version=_dist_version("litestar"),
                apscheduler_version=_dist_version("apscheduler"),
            ),
            database=await _database_versions(request.app),
            geoip=geoip_info(s.geoip.db_path),
            links=AboutLinksView(repository=REPO_URL, issues=f"{REPO_URL}/issues"),
        )

    @get("/database")
    async def get_database_info(
        self, request: Request, settings: NamedDependency[SkipValidation[Settings]]
    ) -> DatabaseInfoResponse:
        """Size, versions, retention and hypertable stats for the Status page.

        Renders nulls instead of failing in DB-degraded mode.
        """
        s = settings
        versions = await _database_versions(request.app)
        size_bytes, hypertables = await _database_stats(request.app)
        return DatabaseInfoResponse(
            reachable=size_bytes is not None,
            size_bytes=size_bytes,
            postgres_version=versions.postgres_version,
            timescaledb_version=versions.timescaledb_version,
            retention_days=s.analytics.raw_retention_days,
            debug_retention_days=s.analytics.debug_retention_days,
            hypertables=hypertables,
        )

    @get("/scheduler/jobs")
    async def get_scheduler_jobs(
        self, request: Request, settings: NamedDependency[SkipValidation[Settings]]
    ) -> SchedulerJobsResponse:
        """All scheduled jobs with next-run and tracked last-run state."""
        scheduler = runtime.get_scheduler(request.app)
        if scheduler is None:
            return SchedulerJobsResponse(
                scheduler_enabled=False, scheduler_running=False, jobs=[]
            )
        tracker = runtime.get_scheduler_tracker(request.app)
        return SchedulerJobsResponse(
            scheduler_enabled=settings.scheduler.enabled,
            scheduler_running=scheduler.running,
            jobs=[_job_view(job, tracker) for job in scheduler.get_jobs()],
        )

    @post("/scheduler/jobs/{job_id:str}/run", status_code=HTTP_202_ACCEPTED)
    async def run_scheduler_job(self, request: Request, job_id: FromPath[str]) -> SchedulerJobView:
        """Trigger a job ASAP by moving its next_run_time to now.

        The scheduler executes it through its normal machinery, so
        max_instances still prevents overlapping runs and the event tracker
        observes the execution. An interval trigger's cadence restarts from
        the manual run.
        """
        scheduler = runtime.get_scheduler(request.app)
        if scheduler is None or scheduler.get_job(job_id) is None:
            raise NotFoundException(detail=f"Unknown scheduler job: {job_id}")
        logger.info("scheduler_job_triggered_manually", job_id=job_id)
        scheduler.modify_job(job_id, next_run_time=datetime.now(timezone.utc))
        return _job_view(scheduler.get_job(job_id), runtime.get_scheduler_tracker(request.app))
