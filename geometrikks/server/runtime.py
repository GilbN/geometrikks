"""Typed access to the runtime services stored on ``app.state``.

Lifecycle startup (server/lifecycle.py) populates these attributes; every
one of them is optional by design because the app deliberately serves in
degraded mode when the database, the GeoLite2 database, or the CrowdSec
integration is unavailable. These accessors centralize that optionality
instead of scattering ``getattr(app.state, ..., None)`` defaults across
handlers.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from geometrikks.server.scheduler_tracking import JobRunTracker
from geometrikks.lib.advisories import AdvisoryRegistry

if TYPE_CHECKING:
    from datetime import datetime

    from apscheduler.schedulers.asyncio import AsyncIOScheduler
    from litestar import Litestar

    from geometrikks.server.plugins import DegradedTolerantAsyncPgBackend
    from geometrikks.services.crowdsec import CrowdSecService
    from geometrikks.services.crowdsec.stream import CrowdSecStreamPoller
    from geometrikks.services.geoip.home import HomeLocation
    from geometrikks.services.ingestion import LogIngestionService


def get_ingestion_service(app: Litestar) -> LogIngestionService | None:
    """None when ingestion never started (DB- or geo-degraded mode)."""
    return getattr(app.state, "ingestion_service", None)


def get_advisories(app: Litestar) -> AdvisoryRegistry:
    """The app's open advisories, created on first access."""
    registry: AdvisoryRegistry | None = getattr(app.state, "advisories", None)
    if registry is None:
        registry = AdvisoryRegistry()
        app.state.advisories = registry
    return registry


def get_crowdsec_service(app: Litestar) -> CrowdSecService | None:
    """None when the integration is not enabled (no LAPI URL/bouncer key)."""
    return getattr(app.state, "crowdsec_service", None)


def get_crowdsec_poller(app: Litestar) -> CrowdSecStreamPoller | None:
    """None when CrowdSec is disabled or the app is DB-degraded."""
    return getattr(app.state, "crowdsec_stream_poller", None)


def get_scheduler(app: Litestar) -> AsyncIOScheduler | None:
    """None when startup never reached the scheduler (DB-degraded mode)."""
    return getattr(app.state, "scheduler", None)


def get_scheduler_tracker(app: Litestar) -> JobRunTracker:
    """The job-run tracker; an empty tracker when startup never set one."""
    tracker: JobRunTracker | None = getattr(app.state, "scheduler_tracker", None)
    return tracker if tracker is not None else JobRunTracker()


def get_started_at(app: Litestar) -> datetime | None:
    """Process start time; None before lifespan startup has run."""
    return getattr(app.state, "started_at", None)


def get_map_home_location(app: Litestar) -> HomeLocation | None:
    """Resolved map home location; None before startup or when undetectable."""
    return getattr(app.state, "map_home_location", None)


def is_geoip_available(app: Litestar, *, default: bool = False) -> bool:
    """Whether a usable GeoLite2 database is loaded.

    ``default`` is returned before lifespan startup has recorded the real value:
    the health endpoint passes True (don't report degraded during boot),
    settings introspection passes False (don't claim a database exists).
    """
    return bool(getattr(app.state, "geoip_available", default))


def is_asn_available(app: Litestar, *, default: bool = False) -> bool:
    """Whether a usable GeoLite2 ASN database is loaded.

    ASN is optional enrichment; False never means degraded, only that rows
    ingest without ASN columns. ``default`` mirrors is_geoip_available.
    """
    return bool(getattr(app.state, "asn_available", default))


def is_db_available(app: Litestar, *, default: bool = True) -> bool:
    """Whether database-bound services were wired during startup."""
    return bool(getattr(app.state, "db_available", default))


def get_channels_backend(app: Litestar) -> DegradedTolerantAsyncPgBackend | None:
    """The live-events backend; None on hand-built test apps."""
    return getattr(app.state, "channels_backend", None)
