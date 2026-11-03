"""System administration API: settings overview and scheduler control.

All /api routes are session-authenticated by middleware; the single admin
is the only user, so no extra guards are needed here.
"""

from __future__ import annotations

import platform

import msgspec
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError, version as dist_version
from typing import TYPE_CHECKING, Annotated, Literal

from litestar import Controller, Litestar, Request, get, post
from litestar.di import NamedDependency
from litestar.exceptions import NotFoundException
from litestar.params import PathParameter, SkipValidation
from litestar.status_codes import HTTP_202_ACCEPTED
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, AsyncSession

from geometrikks.config.introspection import (
    ComputedField,
    SystemSettingsResponse,
    build_settings_overview,
)
from geometrikks.config.settings import Settings
from geometrikks.domain.system import changelog, commit
from geometrikks.domain.analytics.asn_classification import (
    DATASET_LICENSE,
    DATASET_NAME,
    DATASET_URL,
    hosting_asn_count,
    hosting_asn_entries,
)
from geometrikks.domain.drop.schemas import DropListsAboutView, build_drop_lists_about
from geometrikks.domain.drop.snapshot import ensure_drop_snapshot
from geometrikks.server import runtime
from geometrikks.server.logging import get_logger
from geometrikks.server.scheduler_tracking import JobRunTracker, JobStatus
from geometrikks.server.schema_wait import bundled_head_revision, bundled_revision_doc
from geometrikks.lib.utils import GeoIPInfoView, geoip_info
from geometrikks.lib.versioning import display_version
from geometrikks.services.release_check import release_check_enabled

if TYPE_CHECKING:
    from apscheduler.job import Job

logger = get_logger(__name__)


class SchedulerJobView(msgspec.Struct, rename="camel"):
    """One scheduled job. The last-run fields cover runs since this process started."""

    id: Annotated[str, msgspec.Meta(description="The job id that the run endpoint takes, such as `geoip-refresh`.")]
    name: str
    trigger: Annotated[str, msgspec.Meta(description="When the job runs, as APScheduler describes its trigger.")]
    next_run_time: Annotated[
        datetime | None, msgspec.Meta(description="Null when no next run is scheduled.")
    ]
    running: Annotated[bool, msgspec.Meta(description="Whether a run is in progress.")]
    last_run_time: Annotated[datetime | None, msgspec.Meta(description="When the last run started.")]
    last_duration_seconds: Annotated[float | None, msgspec.Meta(description="How long the last run took, in seconds.")]
    last_status: Annotated[
        JobStatus | None,
        msgspec.Meta(
            description="`missed` means a run came due but could not start in time, so the scheduler skipped it."
        ),
    ]
    last_error: Annotated[str | None, msgspec.Meta(description="The error of the last run when it failed.")]


SchedulerStatus = Literal["running", "disabled", "unavailable"]


class SchedulerJobsResponse(msgspec.Struct, rename="camel"):
    """The scheduler and its jobs."""

    scheduler_enabled: Annotated[
        bool,
        msgspec.Meta(
            description=(
                "Whether the scheduler is turned on in this process. False with SCHEDULER_ENABLED=false and "
                "whenever the process has no scheduler, such as after a start without the database."
            )
        ),
    ]
    scheduler_running: bool
    jobs: list[SchedulerJobView]
    # "unavailable" means DB-degraded mode never started the scheduler.
    status: Annotated[
        SchedulerStatus,
        msgspec.Meta(
            description=(
                "`disabled` with SCHEDULER_ENABLED=false. `unavailable` when the app started without its "
                "database and has no scheduler."
            )
        ),
    ] = "running"


REPO_URL = "https://github.com/GilbN/geometrikks"


class AboutAppView(msgspec.Struct, rename="camel"):
    """The running app."""

    name: str
    version: str
    environment: Annotated[
        str, msgspec.Meta(description="APP_ENVIRONMENT, one of `development`, `staging` or `production`.")
    ]
    container: Annotated[bool, msgspec.Meta(description="Whether the app runs from the GeoMetrikks container image.")]
    image_tag: Annotated[str | None, msgspec.Meta(description="The container image tag. Null outside a container.")]
    started_at: Annotated[datetime | None, msgspec.Meta(description="When this process started.")]
    # Changes whenever the shipped changelog does; the UI keys "new since
    # you last looked" on it. None when the install has no changelog.
    changelog_digest: Annotated[
        str | None,
        msgspec.Meta(
            description=(
                "A short hash of the bundled CHANGELOG.md that changes whenever the changelog does. "
                "Null when the install has no changelog."
            )
        ),
    ]
    commit: Annotated[str | None, msgspec.Meta(description="The git commit the app was built from, when known.")]


class RuntimeVersionsView(msgspec.Struct, rename="camel"):
    """The Python runtime and the versions of key libraries."""

    python_version: str
    litestar_version: str | None
    apscheduler_version: str | None


class DatabaseVersionsView(msgspec.Struct, rename="camel"):
    """The database server, its extensions and the schema version.

    Everything except `migrationHead` is null when the database is unreachable.
    """

    postgres_version: str | None
    timescaledb_version: str | None
    postgis_version: str | None
    # The alembic revision the database is on versus the one this build
    # ships. They only differ after a degraded start, a rollback, or an
    # agent running behind a newer head.
    migration_revision: Annotated[
        str | None,
        msgspec.Meta(description="The migration the database schema is on. Null before the first migration ran."),
    ]
    migration_name: Annotated[
        str | None, msgspec.Meta(description="The title of that migration, when this build knows it.")
    ]
    migration_head: Annotated[
        str,
        msgspec.Meta(
            description=(
                "The newest migration this build ships. It differs from `migrationRevision` only after a start "
                "without the database, a rollback, or on an agent older than the head."
            )
        ),
    ]


class AboutLinksView(msgspec.Struct, rename="camel"):
    """Links to the GeoMetrikks repository and its issue tracker."""

    repository: str
    issues: str


class AsnClassificationView(msgspec.Struct, rename="camel"):
    """The bundled list of hosting ASNs that sorts ASNs into hosting and other."""

    dataset: str
    entries: Annotated[int, msgspec.Meta(description="How many ASNs the list holds.")]
    license: str
    source_url: str


class HostingAsnEntryView(msgspec.Struct, rename="camel"):
    """One ASN that counts as a hosting provider."""

    asn: int
    entity: Annotated[str, msgspec.Meta(description="The organization behind the ASN, as the list names it.")]


class AsnClassificationListResponse(msgspec.Struct, rename="camel"):
    """The bundled list of hosting ASNs, with its source and license."""

    dataset: str
    source_url: str
    license: str
    entries: list[HostingAsnEntryView]


class AboutResponse(msgspec.Struct, rename="camel"):
    """Version, runtime and database details for the About page.

    `geoip` describes the GeoLite2 City database and `geoipAsn` the ASN database. `dropLists` is null
    with DROP_ENABLED=false, or when the database cannot answer.
    """

    app: AboutAppView
    runtime: RuntimeVersionsView
    database: DatabaseVersionsView
    geoip: GeoIPInfoView
    links: AboutLinksView
    # asn_enabled distinguishes a disabled feature from a missing database.
    geoip_asn: GeoIPInfoView | None = None
    geoip_asn_enabled: Annotated[
        bool,
        msgspec.Meta(description="Whether ASN lookups are on. With it false, `geoipAsn` may still describe a file."),
    ] = False
    asn_classification: AsnClassificationView | None = None
    # None when DROP_ENABLED is off.
    drop_lists: DropListsAboutView | None = None


ReleaseCheckStatus = Literal["off", "pending", "checked"]


class LatestReleaseView(msgspec.Struct, rename="camel"):
    """The newest GitHub release above the running version."""

    version: str
    display_version: Annotated[str, msgspec.Meta(description="The version in tag style, such as `v0.22.0-dev.4`.")]
    url: Annotated[str, msgspec.Meta(description="The release page on GitHub.")]
    published_at: datetime
    # Releases above the running version, this one included.
    newer_release_count: Annotated[
        int, msgspec.Meta(description="How many releases are newer than the running version, this one included.")
    ]
    # False when the release check stopped paging before reaching the running version.
    newer_release_count_exact: Annotated[
        bool,
        msgspec.Meta(
            description=(
                "False when the check stopped paging before it reached the running version, so the count is a minimum."
            )
        ),
    ]


class ReleaseCheckResponse(msgspec.Struct, rename="camel"):
    """The result of the last check for a newer release. `latest` is null when none is newer."""

    # "off": this process never checks. "pending": no successful check yet.
    status: Annotated[
        ReleaseCheckStatus,
        msgspec.Meta(
            description="`off` when this process never checks, `pending` until a check succeeds, then `checked`."
        ),
    ]
    # Only a release newer than the running version, else None.
    latest: LatestReleaseView | None
    checked_at: Annotated[datetime | None, msgspec.Meta(description="When the last successful check ran.")]


def _dist_version(name: str) -> str | None:
    try:
        return dist_version(name)
    except PackageNotFoundError:
        return None


async def _drop_lists_about(engine: AsyncEngine, *, enabled: bool) -> DropListsAboutView | None:
    """DROP state for About; None when disabled or the database cannot answer."""
    if not enabled:
        return None
    try:
        async with AsyncSession(engine) as session:
            drop_snapshot = await ensure_drop_snapshot(session, enabled=True)
    except Exception:
        # About must render in DB-degraded mode
        logger.warning("drop_lists_about_unavailable", exc_info=True)
        return None
    return build_drop_lists_about(drop_snapshot, enabled=True)


async def _database_versions(engine: AsyncEngine) -> DatabaseVersionsView:
    """Server, extension and migration versions; nulls when the DB is unreachable."""
    head = bundled_head_revision()
    try:
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
            revision = await _migration_revision(conn)
        ext = {name: ver for name, ver in rows}
        return DatabaseVersionsView(
            postgres_version=pg,
            timescaledb_version=ext.get("timescaledb"),
            postgis_version=ext.get("postgis"),
            migration_revision=revision,
            migration_name=bundled_revision_doc(revision) if revision else None,
            migration_head=head,
        )
    except Exception:
        # About must render in DB-degraded mode
        return DatabaseVersionsView(
            postgres_version=None,
            timescaledb_version=None,
            postgis_version=None,
            migration_revision=None,
            migration_name=None,
            migration_head=head,
        )


async def _migration_revision(conn: AsyncConnection) -> str | None:
    """``alembic_versions`` row, or None before the first migration ran."""
    exists = (
        await conn.execute(text("SELECT to_regclass('alembic_versions') IS NOT NULL"))
    ).scalar_one()
    if not exists:
        return None
    return (await conn.execute(text("SELECT version_num FROM alembic_versions"))).scalar_one_or_none()


class HypertableStatsView(msgspec.Struct, rename="camel"):
    """Size and row estimates for one of the large time series tables."""

    name: Annotated[str, msgspec.Meta(description="`geo_events`, `access_logs` or `access_log_debug`.")]
    approx_rows: Annotated[int | None, msgspec.Meta(description="TimescaleDB's estimate of the row count.")]
    total_bytes: Annotated[
        int | None,
        msgspec.Meta(description="The table's size on disk, indexes included, in bytes."),
    ]
    # Compression stats; nulls until the compression policy has compressed
    # at least one chunk.
    before_compression_bytes: Annotated[
        int | None,
        msgspec.Meta(
            description="Bytes the compressed chunks took before compression. Null until a chunk is compressed."
        ),
    ]
    after_compression_bytes: Annotated[
        int | None,
        msgspec.Meta(description="Bytes the compressed chunks take now. Null until a chunk is compressed."),
    ]


class DatabaseInfoResponse(msgspec.Struct, rename="camel"):
    """Database size, versions, retention and table stats for the Status page."""

    reachable: bool
    size_bytes: Annotated[int | None, msgspec.Meta(description="The whole database on disk, in bytes.")]
    postgres_version: str | None
    timescaledb_version: str | None
    retention_days: Annotated[int, msgspec.Meta(description="Days to keep raw geo events and access log lines.")]
    debug_retention_days: Annotated[int, msgspec.Meta(description="Days to keep the access log debug lines.")]
    hypertables: Annotated[
        list[HypertableStatsView], msgspec.Meta(description="Empty when the database is unreachable.")
    ]


HYPERTABLE_NAMES = ("geo_events", "access_logs", "access_log_debug")


async def _database_stats(engine: AsyncEngine) -> tuple[int | None, list[HypertableStatsView]]:
    """Database size and per-hypertable stats; (None, []) when unreachable.

    Uses TimescaleDB catalog-backed functions (approximate_row_count,
    hypertable_size, hypertable_compression_stats), so this stays fast at
    tens of millions of rows.
    """
    try:
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

    self_location = runtime.get_self_location(app)
    if self_location is not None and self_location.source == "external_ip":
        overlay[("map", "server_latitude")] = ComputedField(self_location.latitude, "external_ip")
        overlay[("map", "server_longitude")] = ComputedField(self_location.longitude, "external_ip")

    overlay[("geoip", "available")] = ComputedField(
        runtime.is_geoip_available(app),
        "runtime",
        "Whether a usable GeoLite2 database is loaded",
    )
    overlay[("geoip", "asn_available")] = ComputedField(
        runtime.is_asn_available(app),
        "runtime",
        "Whether a usable GeoLite2 ASN database is loaded",
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

    @get(
        "/settings",
        summary="Get every setting with its environment variable",
        description=(
            "Returns the whole configuration in sections, with each setting's value, default, description "
            "and environment variable. A secret that is set shows as `******` and one that is not shows as "
            "null. Some rows add a value worked out at runtime, such as the auto-detected server location."
        ),
    )
    async def get_system_settings(
        self, request: Request, settings: NamedDependency[SkipValidation[Settings]]
    ) -> SystemSettingsResponse:
        """Full settings tree with descriptions; secrets structurally redacted.

        Overlays runtime-resolved values (auto-detected server location, GeoIP
        availability, CrowdSec effective status) that the raw config omits.
        """
        overlay = _computed_settings_overlay(settings, request.app)
        return build_settings_overview(settings, computed=overlay)

    @get(
        "/about",
        summary="Get version, runtime and database details",
        description=(
            "Returns the app version and image, the Python and library versions, the PostgreSQL, TimescaleDB "
            "and PostGIS versions, the schema migration, and the state of the GeoLite2 databases and DROP "
            "lists. When the database is unreachable, every database field is null except `migrationHead`, "
            "the newest migration this build ships."
        ),
    )
    async def get_about(
        self,
        request: Request,
        settings: NamedDependency[SkipValidation[Settings]],
        db_engine: NamedDependency[SkipValidation[AsyncEngine]],
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
                changelog_digest=changelog.read_changelog().digest,
                commit=commit.resolve_commit(),
            ),
            runtime=RuntimeVersionsView(
                python_version=platform.python_version(),
                litestar_version=_dist_version("litestar"),
                apscheduler_version=_dist_version("apscheduler"),
            ),
            database=await _database_versions(db_engine),
            geoip=geoip_info(s.geoip.db_path),
            links=AboutLinksView(repository=REPO_URL, issues=f"{REPO_URL}/issues"),
            geoip_asn=geoip_info(s.geoip.asn_db_path),
            geoip_asn_enabled=s.geoip.asn_enabled,
            asn_classification=AsnClassificationView(
                dataset=DATASET_NAME,
                entries=hosting_asn_count(),
                license=DATASET_LICENSE,
                source_url=DATASET_URL,
            ),
            drop_lists=await _drop_lists_about(db_engine, enabled=s.drop.enabled),
        )

    @get(
        "/asn-classification",
        summary="List the ASNs that count as hosting providers",
        description=(
            "Returns the bundled list that puts an ASN in the hosting category on the ASN views, with its "
            "source and license. All of its roughly 700 entries come in one response."
        ),
    )
    async def get_asn_classification(self) -> AsnClassificationListResponse:
        """The vendored hosting-ASN list behind the category badges.

        Around 700 entries, so it ships whole and the About page filters
        client-side.
        """
        return AsnClassificationListResponse(
            dataset=DATASET_NAME,
            source_url=DATASET_URL,
            license=DATASET_LICENSE,
            entries=[
                HostingAsnEntryView(asn=asn, entity=entity)
                for asn, entity in hosting_asn_entries()
            ],
        )

    @get(
        "/changelog",
        summary="List the releases in the changelog",
        description=(
            "Returns every release in the bundled CHANGELOG.md, newest first, with its sections and entries. "
            "Entry text keeps its inline markdown. The list is empty when the install has no changelog."
        ),
    )
    async def get_changelog(self) -> changelog.ChangelogResponse:
        """Every release in CHANGELOG.md, newest first, for the Changelog page."""
        return changelog.ChangelogResponse(releases=changelog.read_changelog().releases)

    @get(
        "/release-check",
        summary="Get the newest release above the running version",
        description=(
            "Reports the last check against GitHub Releases. `status` is `off` with APP_UPDATE_CHECK=false, "
            "with SCHEDULER_ENABLED=false, on agents and on local builds. This endpoint never calls GitHub "
            "itself."
        ),
    )
    async def get_release_check(
        self, request: Request, settings: NamedDependency[SkipValidation[Settings]]
    ) -> ReleaseCheckResponse:
        """The newest GitHub release above the running version, once one is known."""
        if not release_check_enabled(settings):
            return ReleaseCheckResponse(status="off", latest=None, checked_at=None)
        release_checker = runtime.get_release_checker(request.app)
        if release_checker is None or release_checker.checked_at is None:
            return ReleaseCheckResponse(status="pending", latest=None, checked_at=None)
        github_release = release_checker.latest
        return ReleaseCheckResponse(
            status="checked",
            latest=None
            if github_release is None
            else LatestReleaseView(
                version=str(github_release.version),
                display_version=display_version(str(github_release.version)),
                url=github_release.url,
                published_at=github_release.published_at,
                newer_release_count=release_checker.newer_release_count,
                newer_release_count_exact=release_checker.newer_release_count_exact,
            ),
            checked_at=release_checker.checked_at,
        )

    @get(
        "/database",
        summary="Get the database size, retention and table stats",
        description=(
            "Returns the database size, the PostgreSQL and TimescaleDB versions, the retention days, and row "
            "and size estimates for the geo_events, access_logs and access_log_debug tables. With the "
            "database unreachable it still answers 200, with `reachable` false and the stats null or empty."
        ),
    )
    async def get_database_info(
        self,
        settings: NamedDependency[SkipValidation[Settings]],
        db_engine: NamedDependency[SkipValidation[AsyncEngine]],
    ) -> DatabaseInfoResponse:
        """Size, versions, retention and hypertable stats for the Status page.

        Renders nulls instead of failing in DB-degraded mode: the plugin's
        db_engine provider hands out the engine without connecting, so
        failures surface at query time inside the try/except blocks.
        """
        s = settings
        versions = await _database_versions(db_engine)
        size_bytes, hypertables = await _database_stats(db_engine)
        return DatabaseInfoResponse(
            reachable=size_bytes is not None,
            size_bytes=size_bytes,
            postgres_version=versions.postgres_version,
            timescaledb_version=versions.timescaledb_version,
            retention_days=s.analytics.raw_retention_days,
            debug_retention_days=s.analytics.debug_retention_days,
            hypertables=hypertables,
        )

    @get(
        "/scheduler/jobs",
        summary="List the scheduler jobs",
        description=(
            "Returns every scheduled job with its trigger, its next run and the outcome of its last run since "
            "this process started."
        ),
    )
    async def get_scheduler_jobs(
        self, request: Request, settings: NamedDependency[SkipValidation[Settings]]
    ) -> SchedulerJobsResponse:
        """All scheduled jobs with next-run and tracked last-run state."""
        scheduler = runtime.get_scheduler(request.app)
        if scheduler is None:
            return SchedulerJobsResponse(
                scheduler_enabled=False,
                scheduler_running=False,
                jobs=[],
                status="unavailable",
            )
        tracker = runtime.get_scheduler_tracker(request.app)
        return SchedulerJobsResponse(
            scheduler_enabled=settings.scheduler.enabled,
            scheduler_running=scheduler.running,
            jobs=[_job_view(job, tracker) for job in scheduler.get_jobs()],
            status="running" if settings.scheduler.enabled else "disabled",
        )

    @post(
        "/scheduler/jobs/{job_id:str}/run",
        status_code=HTTP_202_ACCEPTED,
        summary="Run a scheduler job now",
        description=(
            "Moves the job's next run to now and answers 202 right away, before the job finishes. A job that "
            "is already running does not start a second time, and an interval job counts its next run from "
            "this one. An unknown job id gets a 404, and so does every id while this process has no "
            "scheduler. Needs a Read/write API key or a browser session."
        ),
    )
    async def run_scheduler_job(
        self,
        request: Request,
        job_id: Annotated[str, PathParameter(description="The job's `id` from the job list, such as `geoip-refresh`.")],
    ) -> SchedulerJobView:
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
