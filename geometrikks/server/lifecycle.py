"""Application lifecycle as focused lifespan context managers.

Each concern owns both its startup and its cleanup in one async context
manager. :class:`LifecyclePlugin` registers :data:`LIFESPAN` with Litestar,
which enters the managers in order on an ``AsyncExitStack`` and exits them
in reverse:

- teardown order is the exact reverse of startup (ingestion stops first,
  the scheduler second, the CrowdSec client closes after both), and
- a failure during startup unwinds only the managers that already started,
  so partial startup no longer leaks running services.

The plugin, not the ``lifespan=`` constructor argument, is what puts these
managers after the ones other plugins register. ChannelsPlugin appends its
own lifespan during ``on_app_init``; had ours been passed to the
constructor they would sit ahead of it, exit first, and ingestion's final
flush would publish into a channels plugin that had already torn down its
queue.

Degraded modes are decided once: :func:`database_lifespan` records
``app.state.db_available`` and the scheduler and ingestion managers no-op
when it is False. Missing GeoLite2 puts the app in geo-degraded mode
(API/UI up, ingestion inert) without failing startup.
"""

from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Protocol

from sqlalchemy import text
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from litestar.plugins import InitPlugin

from geometrikks.config.settings import get_settings
from geometrikks.lib.utils import retries_disabled
from geometrikks.server.logging import get_logger
from geometrikks.server.migrations import migrate_database
from geometrikks.server import runtime
from geometrikks.server.plugins import get_app_db_config
from geometrikks.server.schema_wait import wait_for_schema
from geometrikks.server.timescale import setup_timescaledb

from geometrikks.services.crowdsec import CrowdSecService
from geometrikks.services.crowdsec.stream import CrowdSecStreamPoller
from geometrikks.services.geoip.downloader import ensure_asn_database, ensure_geoip_database
from geometrikks.services.geoip.home import resolve_home_location
from geometrikks.services.geoip.site_homes import reconcile_override_homes, upsert_auto_homes
from geometrikks.services.ingestion import LogIngestionService
from geometrikks.services.logparser.logparser import LogParser
from geometrikks.services.logparser.peer_window import PeerWindow
from geometrikks.server.scheduler import create_scheduler
from geometrikks.server.scheduler_tracking import JobRunTracker

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator

    from geometrikks.config.settings import Settings
    from litestar import Litestar
    from litestar.config.app import AppConfig

logger = get_logger(__name__)

_PROBE_RETRY_DELAY = 2.0


class _Clock(Protocol):
    def monotonic(self) -> float: ...

    async def sleep(self, seconds: float) -> None: ...


class _SystemClock:
    @staticmethod
    def monotonic() -> float:
        return time.monotonic()

    @staticmethod
    async def sleep(seconds: float) -> None:
        await asyncio.sleep(seconds)


_SYSTEM_CLOCK = _SystemClock()


def _resolve_settings(app: "Litestar") -> "Settings":
    """The settings the app was composed with.

    create_app() stores its composed settings on state; the fallback keeps
    hand-built test apps that attach these managers directly working.
    """
    return getattr(app.state, "settings", None) or get_settings()


async def _db_available(app: "Litestar", timeout: float = 10.0) -> bool:
    """Run one bounded database connection probe."""
    try:
        async def _probe():
            async with get_app_db_config(app).get_engine().connect() as conn:
                await conn.execute(text("SELECT 1"))

        await asyncio.wait_for(_probe(), timeout=timeout)
        return True
    except Exception as e:
        logger.debug("database_probe_failed", error=str(e))
        return False


async def _wait_for_database(
    app: "Litestar", wait_seconds: float, *, _clock: _Clock = _SYSTEM_CLOCK
) -> bool:
    """Probe until the database answers or the startup window expires."""
    if wait_seconds == 0 or retries_disabled():
        available = await _db_available(app)
        if not available:
            logger.warning(
                "database_startup_wait_expired",
                wait_seconds=wait_seconds,
                retrying_in_background=True,
            )
        return available

    deadline = _clock.monotonic() + wait_seconds
    while True:
        remaining = deadline - _clock.monotonic()
        if remaining <= 0:
            logger.warning(
                "database_startup_wait_expired",
                wait_seconds=wait_seconds,
                retrying_in_background=True,
            )
            return False
        if await _db_available(app, timeout=min(10.0, remaining)):
            return True
        remaining = deadline - _clock.monotonic()
        if remaining <= 0:
            logger.warning(
                "database_startup_wait_expired",
                wait_seconds=wait_seconds,
                retrying_in_background=True,
            )
            return False
        await _clock.sleep(min(_PROBE_RETRY_DELAY, remaining))


@asynccontextmanager
async def core_state_lifespan(app: "Litestar") -> "AsyncGenerator[None]":
    """Process start time and the log broadcaster's event loop binding.

    Runs first so /about reports uptime even when later managers degrade.
    """
    app.state.started_at = datetime.now(timezone.utc)
    runtime.get_advisories(app)

    from geometrikks.server.logging import log_broadcaster
    log_broadcaster.bind_loop(asyncio.get_running_loop())

    settings = _resolve_settings(app)
    if settings.api.log_level is not None:
        logger.warning(
            "API_LOG_LEVEL is deprecated and will be removed in a future "
            "release; set LOG_LEVEL instead."
        )
    yield


@asynccontextmanager
async def geoip_lifespan(app: "Litestar") -> "AsyncGenerator[None]":
    """GeoLite2 download/refresh and home-location detection.

    Runs before the DB gate: geo enrichment does not need the database, and
    /health must report geoip state accurately even in DB-degraded mode.
    Missing credentials or database degrade the feature, never startup.
    """
    settings = _resolve_settings(app)
    geoip_available: bool = await ensure_geoip_database(settings.geoip)
    app.state.geoip_available = geoip_available
    # ASN is optional enrichment: its availability is tracked separately and
    # never influences geo-degraded mode.
    app.state.asn_available = await ensure_asn_database(settings.geoip)
    app.state.map_home_location = await resolve_home_location(
        settings.map,
        settings.geoip,
        geoip_available=geoip_available,
    )
    if not geoip_available:
        logger.warning(
            "Geo-degraded mode: no usable GeoLite2 database. With MaxMind "
            "credentials configured, the scheduled refresh retries and starts "
            "ingestion automatically once a database is downloaded; otherwise "
            "restart after setting MAXMINDDB_USER_ID/MAXMINDDB_LICENSE_KEY."
        )
    yield


@asynccontextmanager
async def crowdsec_lifespan(app: "Litestar") -> "AsyncGenerator[None]":
    """CrowdSec LAPI client and decision-stream poller wiring.

    The LAPI client needs no database, so this runs before the DB gate;
    missing config degrades the feature instead of failing startup. The
    database manager may later null the poller in DB-degraded mode (the poll
    job runs on the scheduler, which never starts without a database).

    Teardown closes the LAPI client; it exits after the scheduler and
    ingestion managers, so nothing that could still use the client outlives it.

    No-ops entirely in agent mode: the primary instance owns bans, so an
    agent wires no LAPI client and no poller regardless of CROWDSEC_ settings.
    """
    settings = _resolve_settings(app)
    if settings.is_agent:
        app.state.crowdsec_service = None
        app.state.crowdsec_stream_poller = None
        yield
        return

    service: CrowdSecService | None = None
    # The finally covers the setup phase too: if wiring fails after the LAPI
    # client exists (e.g. poller construction), the client is still closed.
    try:
        if settings.crowdsec.enabled:
            service = CrowdSecService(settings.crowdsec)
            app.state.crowdsec_service = service
            app.state.crowdsec_stream_poller = CrowdSecStreamPoller(service)
            logger.info(
                "CrowdSec integration enabled (write=%s)", settings.crowdsec.write_enabled
            )
        else:
            app.state.crowdsec_service = None
            app.state.crowdsec_stream_poller = None
        yield
    finally:
        crowdsec_service = runtime.get_crowdsec_service(app) or service
        if crowdsec_service:
            await crowdsec_service.aclose()


@asynccontextmanager
async def database_lifespan(app: "Litestar") -> "AsyncGenerator[None]":
    """Database gate: availability probe, migrations, TimescaleDB objects.

    - If the DB is unavailable, record ``db_available = False`` and serve in
      degraded mode (no migrations; scheduler and ingestion never start).
    - If the DB is reachable but migration fails, that failure propagates
      and fails startup deliberately: a reachable DB with a broken schema is
      an error to surface, not an outage to degrade around.

    Engine disposal belongs to the SQLAlchemy plugin, so there is no teardown.

    Agent mode never migrates and never touches TimescaleDB objects -- the
    primary instance owns the schema. It waits for that schema to reach (or
    pass) the head this build was compiled against instead.
    """
    settings = _resolve_settings(app)

    if settings.is_agent:
        engine = get_app_db_config(app).get_engine()
        result = await wait_for_schema(engine)
        app.state.schema_wait_result = result
        if result == "timeout":
            app.state.db_available = False
            logger.error(
                "Timed out waiting for the database schema to be ready; "
                "starting in degraded mode."
            )
        else:
            app.state.db_available = True
            session_maker = get_app_db_config(app).create_session_maker()
            # Home was resolved by geoip_lifespan (runs before this manager);
            # a failure here is presentation data, not a startup blocker.
            try:
                await upsert_auto_homes(
                    session_maker,
                    settings.logparser.resolved_hostnames(),
                    runtime.get_map_home_location(app),
                )
            except Exception:
                logger.warning(
                    "site_homes startup write failed; map falls back to the "
                    "default home",
                    exc_info=True,
                )
        yield
        return

    if not await _wait_for_database(app, settings.database.startup_wait_seconds):
        app.state.db_available = False
        if runtime.get_crowdsec_poller(app) is not None:
            # The poll job runs on the scheduler, which never starts without a
            # database; a live poller would leave /ws/crowdsec clients hanging
            # instead of closing 1013 so they fall back to periodic refetch.
            app.state.crowdsec_stream_poller = None
            logger.warning(
                "CrowdSec live updates disabled: the scheduler does not run "
                "in DB-degraded mode."
            )
        yield
        return

    app.state.db_available = True
    engine = get_app_db_config(app).get_engine()

    # Schema is owned by alembic (migrations/versions). A failed upgrade
    # raises and fails startup deliberately. Multi-process deployments run
    # migrations as a separate step instead (litestar database upgrade) and
    # disable this; TimescaleDB setup below still requires the schema to be
    # at head and fails startup if the external step was skipped.
    if settings.database.migrate_on_startup:
        await migrate_database(engine, settings)
    else:
        logger.info(
            "Startup migrations disabled (DB_MIGRATE_ON_STARTUP=false); "
            "expecting an external 'litestar database upgrade' step."
        )

    # TimescaleDB objects (hypertables, CAGGs, policies) deliberately stay
    # out of alembic: the DDL is idempotent, timescale-version-sensitive,
    # and alembic autogenerate can neither model nor diff them.
    await setup_timescaledb(engine, settings.analytics)

    session_maker = get_app_db_config(app).create_session_maker()
    # Presentation data: a failure here must never block startup.
    try:
        await reconcile_override_homes(session_maker, settings.map.home_locations)
        if settings.logparser.enabled:
            await upsert_auto_homes(
                session_maker,
                settings.logparser.resolved_hostnames(),
                runtime.get_map_home_location(app),
            )
    except Exception:
        logger.warning(
            "site_homes startup write failed; map falls back to the default home",
            exc_info=True,
        )
    yield


@asynccontextmanager
async def scheduler_lifespan(app: "Litestar") -> "AsyncGenerator[None]":
    """APScheduler with job-run tracking; no-op in DB-degraded mode."""
    if not getattr(app.state, "db_available", False):
        yield
        return

    settings = _resolve_settings(app)
    session_maker = get_app_db_config(app).create_session_maker()

    # Tracker must attach before start so no event is missed. mode is only
    # passed for agent mode, not "full": some hand-built test doubles for
    # create_scheduler predate the mode parameter and only accept the
    # original (session_factory, settings, crowdsec_poller) call shape.
    crowdsec_poller = runtime.get_crowdsec_poller(app)
    kwargs = {"mode": "agent"} if settings.is_agent else {}
    scheduler: AsyncIOScheduler = await create_scheduler(
        session_maker, settings, crowdsec_poller=crowdsec_poller, app=app, **kwargs
    )
    # The finally covers start() itself: if it activates the scheduler and
    # then raises, the running scheduler is still shut down.
    try:
        scheduler_tracker = JobRunTracker()
        scheduler_tracker.attach(scheduler)
        scheduler.start()
        logger.info("Started APScheduler")

        app.state.scheduler = scheduler
        app.state.scheduler_tracker = scheduler_tracker
        yield
    finally:
        running = runtime.get_scheduler(app) or scheduler
        if running and running.running:
            running.shutdown(wait=True)
            logger.info("Stopped APScheduler")


@asynccontextmanager
async def ingestion_lifespan(app: "Litestar") -> "AsyncGenerator[None]":
    """Log tailing -> parse -> GeoIP -> DB pipeline; no-op in DB-degraded mode.

    Enters last and therefore exits first: ingestion stops before the
    scheduler and the CrowdSec client so nothing keeps writing during teardown.

    LOGPARSER_ENABLED=false no-ops the same way, without ever constructing a
    parser or the service, and independently of database availability: a
    disabled ingestion is an operator choice, not an outage. /health reads
    settings.logparser.enabled directly to tell "disabled by configuration"
    apart from degraded.
    """
    settings = _resolve_settings(app)
    if not settings.logparser.enabled:
        logger.info("Ingestion disabled (LOGPARSER_ENABLED=false): skipping log tailing.")
        yield
        return

    if not getattr(app.state, "db_available", False):
        yield
        return

    from litestar.channels import ChannelsPlugin

    # Ingestion opens a short-lived session per batch flush.
    session_maker = get_app_db_config(app).create_session_maker()

    # Hand-built test apps in the lifespan suites are bare stand-ins with no
    # `.plugins` registry at all; real apps always carry ChannelsPlugin
    # (registered in server/plugins.py), so a genuine lookup miss there is a
    # wiring bug: log it loudly and degrade the live feed rather than crash
    # ingestion over it.
    channels: ChannelsPlugin | None = None
    plugins = getattr(app, "plugins", None)
    if plugins is not None:
        try:
            channels = plugins.get(ChannelsPlugin)
        except KeyError:
            channels = None
            logger.warning("live_events channel unavailable: ChannelsPlugin not registered")

    hostnames = settings.logparser.resolved_hostnames()
    parsers = [
        LogParser(
            log_path=path,
            send_logs=settings.logparser.send_logs,
            poll_interval=settings.logparser.poll_interval,
            hostname=host,
            ignore_ips=settings.logparser.ignore_ips,
            log_format=fmt,
            peer_window=PeerWindow() if settings.app.proxy_advisory else None,
        )
        for path, fmt, host in zip(
            settings.logparser.log_paths,
            settings.logparser.resolved_formats(),
            hostnames,
        )
    ]

    ingestion_service = LogIngestionService(
        parsers=parsers,
        session_maker=session_maker,
        geoip_path=settings.geoip.db_path,
        locales=settings.geoip.locales,
        asn_db_path=settings.geoip.asn_db_path if settings.geoip.asn_enabled else None,
        hostname=hostnames[0],
        batch_size=settings.logparser.batch_size,
        commit_interval=settings.logparser.commit_interval,
        store_debug_lines=settings.logparser.store_debug_lines,
        channels=channels,
    )
    app.state.ingestion_service = ingestion_service

    # The finally covers start() itself: if it activates tailers and then
    # raises, the partially started service is still stopped.
    try:
        await ingestion_service.start(
            skip_validation=settings.logparser.skip_validation,
        )
        yield
    finally:
        service = runtime.get_ingestion_service(app) or ingestion_service
        if service:
            # A geoip-refresh job mid-flight must not restart the tail tasks
            # after this stop (the scheduler shuts down after ingestion).
            service.disable_reloads()
            await service.stop(timeout=5.0)


# Entered in order by Litestar's lifespan AsyncExitStack; exited in reverse.
LIFESPAN = [
    core_state_lifespan,
    geoip_lifespan,
    crowdsec_lifespan,
    database_lifespan,
    scheduler_lifespan,
    ingestion_lifespan,
]


class LifecyclePlugin(InitPlugin):
    """Registers :data:`LIFESPAN` after every plugin listed before it.

    Must be the last entry in ``create_plugins()`` so the app's managers
    nest inside the plugin-owned ones (channels, database engine).
    """

    def on_app_init(self, app_config: "AppConfig") -> "AppConfig":
        app_config.lifespan.extend(LIFESPAN)
        return app_config
