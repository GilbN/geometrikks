"""APScheduler configuration for background tasks.

CAGG Refresh Strategy:
- TimescaleDB continuous aggregates are automatically refreshed by background workers
  via policies configured in timescale.py.

- The scheduler handles supplementary tasks:
  1. GeoLocation.last_hit refresh (updates regular table from hypertable data)
  2. Manual CAGG refresh for backfilling or forcing updates
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING, Callable

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from sqlalchemy.ext.asyncio import AsyncEngine

from geometrikks.server.logging import get_logger
from geometrikks.server.timescale import ALL_CAGGS

if TYPE_CHECKING:
    from litestar import Litestar
    from sqlalchemy.ext.asyncio import AsyncSession

    from geometrikks.config.settings import Settings
    from geometrikks.services.crowdsec.stream import CrowdSecStreamPoller

logger = get_logger(__name__)


# =============================================================================
# Refresh Functions - Can be called manually or scheduled
# =============================================================================


async def refresh_location_last_hits_job(
    session_factory: "Callable[[], AsyncSession]",
) -> None:
    """Update GeoLocation.last_hit from actual GeoEvent timestamps.

    Creates fresh session and AggregationService for this job run.

    Args:
        session_factory: SQLAlchemy async session factory.
    """
    from geometrikks.services.aggregation.service import AggregationService

    async with session_factory() as session:
        service = AggregationService(session=session)
        updated: int = await service.refresh_location_last_hits()
        await session.commit()

        if updated > 0:
            logger.info("Refreshed last_hit for %d locations", updated)


async def _execute_call_outside_transaction(
    session_factory: "Callable[[], AsyncSession]", sql: str, *args: object
) -> None:
    """Execute a CALL statement outside of any transaction.

    PostgreSQL CALL statements (like refresh_continuous_aggregate) cannot
    run inside a transaction block. Positional args are bound by asyncpg.
    The engine comes from the job's session factory so scheduled work runs
    against the same database the app was composed with.
    """
    session = session_factory()
    try:
        engine = session.bind
    finally:
        await session.close()
    if not isinstance(engine, AsyncEngine):
        raise RuntimeError("Session factory has no bound engine for CALL statement")
    async with engine.connect() as conn:
        raw_conn = await conn.get_raw_connection()
        driver_conn = raw_conn.driver_connection
        if driver_conn is None:
            raise RuntimeError("No driver connection available for CALL statement")
        await driver_conn.execute(sql, *args)


async def refresh_continuous_aggregate_job(
    session_factory: "Callable[[], AsyncSession]",
    cagg_name: str,
    start: datetime | None = None,
    end: datetime | None = None,
) -> None:
    """Manually refresh a TimescaleDB continuous aggregate.

    Timestamps are bound as asyncpg parameters; the CAGG name is validated
    against the ALL_CAGGS allowlist (identifiers cannot be parameters).

    Args:
        session_factory: SQLAlchemy async session factory; supplies the engine.
        cagg_name: Name of the continuous aggregate to refresh.
        start: Start of refresh window (None = beginning of time).
        end: End of refresh window (None = now).
    """
    if cagg_name not in ALL_CAGGS:
        raise ValueError(f"Unknown CAGG name: {cagg_name}")

    await _execute_call_outside_transaction(
        session_factory,
        f"CALL refresh_continuous_aggregate('{cagg_name}', $1::timestamptz, $2::timestamptz)",
        start,
        end,
    )
    logger.info("Refreshed continuous aggregate: %s", cagg_name)


async def refresh_all_caggs_job(
    session_factory: "Callable[[], AsyncSession]",
) -> None:
    """Refresh all continuous aggregates.

    Useful for catching up any data that might have been missed or
    after bulk data imports.

    Note: CALL statements must run outside transactions.

    Args:
        session_factory: SQLAlchemy async session factory.
    """
    failed: list[str] = []
    for cagg_name in ALL_CAGGS:
        try:
            await _execute_call_outside_transaction(
                session_factory,
                f"CALL refresh_continuous_aggregate('{cagg_name}', NULL, NULL)",
            )
            logger.info("cagg_refreshed", cagg_name=cagg_name)
        except Exception as exc:
            logger.warning(
                "cagg_refresh_failed", cagg_name=cagg_name, error=str(exc)
            )
            failed.append(cagg_name)

    if failed:
        raise RuntimeError(
            f"{len(failed)} of {len(ALL_CAGGS)} aggregates failed to refresh: "
            + ", ".join(failed)
        )
    logger.info("all_caggs_refresh_complete", count=len(ALL_CAGGS))


async def refresh_site_home_job(
    session_factory: "Callable[[], AsyncSession]",
    settings: "Settings",
    app: "Litestar | None" = None,
) -> None:
    """Re-detect this process's home and refresh its site_homes rows.

    Homelab IPs change; agents run for weeks. A UI head tails nothing and
    records no events under its own hostname, so it has nothing to write.
    A successful detection updates this process's map state and clears its
    undetected-home advisory. Database writes remain ingestion-only.
    """
    from geometrikks.lib.advisories import MAP_HOME_UNDETECTED
    from geometrikks.server import runtime
    from geometrikks.services.geoip.home import resolve_home_location
    from geometrikks.services.geoip.site_homes import upsert_auto_homes

    home = await resolve_home_location(
        settings.map,
        settings.geoip,
        geoip_available=settings.geoip.db_path.exists(),
    )
    if app is not None and home is not None:
        app.state.map_home_location = home
        runtime.get_advisories(app).clear(MAP_HOME_UNDETECTED.id)
    if settings.logparser.enabled:
        await upsert_auto_homes(
            session_factory, settings.logparser.resolved_hostnames(), home
        )


async def proxy_scan_job(
    session_factory: "Callable[[], AsyncSession]", app: "Litestar | None"
) -> None:
    """Scan access_logs for CDN peer sources the head does not tail.

    The exclusion set is resolved at run time: parsers can appear after
    registration, and a LOGPARSER_ENABLED=false head has none at all.
    """
    from geometrikks.domain.system.proxy_scan import run_proxy_scan
    from geometrikks.server import runtime

    service = runtime.get_ingestion_service(app) if app is not None else None
    exclude = {p.hostname for p in service.parsers} if service is not None else set()
    await run_proxy_scan(session_factory, exclude)


async def refresh_geoip_job(settings: "Settings", app: "Litestar | None") -> None:
    """Refresh the GeoLite2 databases, then reload the ingestion readers when
    a file on disk no longer matches what the readers have open.

    The staleness check (not a download-succeeded flag) also picks up files
    replaced out-of-band, e.g. by an external geoipupdate against a mounted
    mmdb. The manual /scheduler/jobs/geoip-refresh/run endpoint executes this
    same callable, so it doubles as the "pick up my replaced file now" path.

    With app=None the job degrades to refresh-only (hand-built scheduler test
    doubles that predate the app parameter).
    """
    from geometrikks.services.geoip import downloader

    # Module lookup, not a captured reference: tests monkeypatch this.
    # force: a run of this job (scheduled or the Settings Run button) means
    # "fetch a fresh copy now"; the staleness gate stays for startup only.
    result = await downloader.refresh_geoip_databases(settings.geoip, force=True)

    if app is not None:
        from geometrikks.lib.utils import geoip_info
        from geometrikks.server import runtime

        # /health and the settings overlay read these; a successful download after
        # a degraded start must flip them without a restart.
        app.state.geoip_available = geoip_info(settings.geoip.db_path).available
        if settings.geoip.asn_enabled:
            app.state.asn_available = geoip_info(settings.geoip.asn_db_path).available

        service = runtime.get_ingestion_service(app)
        if service is not None and service.readers_stale():
            await service.reload_readers()

    if result.errors:
        raise RuntimeError("GeoLite2 refresh failed: " + "; ".join(result.errors))


async def create_scheduler(
    session_factory: "Callable[[], AsyncSession]",
    settings: "Settings",
    crowdsec_poller: "CrowdSecStreamPoller | None" = None,
    mode: str = "full",
    *,
    app: "Litestar | None" = None,
) -> AsyncIOScheduler:
    """Create and configure the APScheduler instance.

    Scheduled Jobs (mode="full"):
    - Location last_hit refresh: Every 5 minutes (configurable)
    - Full CAGG refresh: Every 6 hours (catches up any missed data)
    - GeoLite2 refresh: weekly by default
    - Proxy peer scan: every 5 minutes, when APP_PROXY_ADVISORY is on
    - CrowdSec decision-stream poll, when the integration is on

    An agent instance (mode="agent") only tails logs into a schema the
    primary instance owns, so it registers just the GeoLite2 refresh and the
    site-home refresh: the other jobs are either primary-only maintenance
    (CAGGs, location last_hit, proxy peer scan) or CrowdSec, which agents
    never wire up.

    Note: TimescaleDB continuous aggregate policies also run in the background
    for automatic incremental refreshes. The scheduled jobs here supplement those.

    Args:
        session_factory: SQLAlchemy async session factory for creating job sessions.
        settings: Application settings for job configuration.
        mode: "full" or "agent"; controls which jobs are registered.
        app: The composed app; the geoip-refresh job resolves the ingestion
            service through it at run time (it does not exist yet at
            registration). None degrades that job to refresh-only.

    Returns:
        Configured AsyncIOScheduler (not yet started).
    """
    scheduler = AsyncIOScheduler(timezone=timezone.utc)

    if not settings.scheduler.enabled:
        logger.info("Scheduler disabled via settings")
        return scheduler

    if mode != "agent":
        # Location last_hit refresh (default: every 5 minutes)
        # This updates the regular geo_locations table with data from the geo_events hypertable
        scheduler.add_job(
            refresh_location_last_hits_job,
            IntervalTrigger(
                minutes=settings.scheduler.location_refresh_interval_minutes,
            ),
            id="location-refresh",
            name="Refresh GeoLocation.last_hit timestamps",
            args=[session_factory],
            replace_existing=True,
        )
        logger.info(
            "Scheduled location refresh every %d minute(s)",
            settings.scheduler.location_refresh_interval_minutes,
        )

        # Full CAGG refresh (every 6 hours)
        # This ensures all continuous aggregates are in sync
        # Useful for catching up any data that might have been missed
        scheduler.add_job(
            refresh_all_caggs_job,
            IntervalTrigger(hours=6),
            id="cagg-full-refresh",
            name="Full refresh of all CAGGs",
            args=[session_factory],
            replace_existing=True,
        )
        logger.info("Scheduled full CAGG refresh every 6 hours")

    # Weekly GeoLite2 refresh, City + ASN editions in one job (only meaningful
    # when credentials are set; the ensure functions no-op safely otherwise),
    # followed by an ingestion reader reload when the files changed.
    # Runs in every mode: an agent still needs its own local databases kept
    # current. One job id: the Settings UI looks up "geoip-refresh" by name.
    scheduler.add_job(
        refresh_geoip_job,
        IntervalTrigger(days=settings.geoip.refresh_days),
        id="geoip-refresh",
        name="Refresh GeoLite2 databases from MaxMind",
        args=[settings, app],
        replace_existing=True,
    )
    logger.info("Scheduled GeoLite2 refresh every %d day(s)", settings.geoip.refresh_days)

    # A composed UI head needs this job to refresh its process-local map home.
    # Hand-built schedulers without an app still skip the job when they ingest
    # nothing because neither app state nor site_homes can change.
    if settings.logparser.enabled or app is not None:
        scheduler.add_job(
            refresh_site_home_job,
            IntervalTrigger(hours=settings.map.home_refresh_hours),
            id="site-home-refresh",
            name="Re-detect this instance's site home location",
            args=[session_factory, settings, app],
            replace_existing=True,
        )
        logger.info(
            "Scheduled site home refresh every %d hour(s)", settings.map.home_refresh_hours
        )

    # Head-only: agents report their own parser findings on their own
    # /health; the scan exists to pull remote sources onto the head.
    if mode != "agent" and settings.app.proxy_advisory:
        scheduler.add_job(
            proxy_scan_job,
            IntervalTrigger(minutes=5),
            id="proxy-peer-scan",
            name="Scan access logs for CDN peer sources",
            args=[session_factory, app],
            replace_existing=True,
        )
        logger.info("Scheduled proxy peer scan every 5 minutes")

    # CrowdSec decision-stream poll: feeds live ban/unban updates to the
    # /ws/crowdsec subscribers. Only registered when the integration is on;
    # agents never receive a poller (crowdsec_lifespan no-ops for them).
    if mode != "agent" and crowdsec_poller is not None:
        scheduler.add_job(
            crowdsec_poller.poll,
            IntervalTrigger(seconds=settings.crowdsec.stream_poll_interval),
            id="crowdsec-stream-poll",
            name="Poll CrowdSec decision stream",
            max_instances=1,
            replace_existing=True,
            misfire_grace_time=10,  # seconds
        )
        logger.info(
            "Scheduled CrowdSec decision-stream poll every %.0fs",
            settings.crowdsec.stream_poll_interval,
        )

    return scheduler
