"""Central route registration."""
from pathlib import Path

from litestar import Router, get
from litestar.datastructures import ResponseHeader
from litestar.di import NamedDependency
from litestar.exceptions import NotFoundException
from litestar.params import SkipValidation
from litestar.response import File
from litestar.types import ControllerRouterHandler

from geometrikks.domain.geo.controllers.events import GeoEventController
from geometrikks.domain.geo.controllers.locations import GeoLocationController
from geometrikks.domain.logs.controllers.access_logs import AccessLogController
from geometrikks.domain.logs.controllers.access_log_debug import AccessLogDebugController
from geometrikks.domain.analytics.controllers import AnalyticsController
from geometrikks.domain.auth.controllers import AuthController
from geometrikks.domain.security.controllers import CrowdSecController
from geometrikks.domain.system.controllers.logs import LogsController
from geometrikks.domain.system.controllers.system import SystemController
from geometrikks.domain.realtime.controllers import crowdsec_feed, live_feed, logs_feed
from geometrikks.domain.system.controllers.settings import read_settings
from geometrikks.domain.system.controllers.stats import stats
from geometrikks.domain.system.controllers.health import health, health_ready
from geometrikks.config.settings import Settings


@get(
    "/sw.js",
    include_in_schema=False,
    sync_to_thread=False,
    # The browser must be able to revalidate the worker promptly or updates
    # stall; never serve it with a long-lived cache header.
    response_headers=[ResponseHeader(name="Cache-Control", value="no-cache")],
)
def service_worker(settings: NamedDependency[SkipValidation[Settings]]) -> File:
    # No worker in dev mode: it would cache the dev shell and break the next
    # production run on the same origin.
    if settings.vite.dev_mode:
        raise NotFoundException(detail="Service worker is not served in dev mode")
    sw_path = Path("public/sw.js")
    if not sw_path.is_file():
        raise NotFoundException(detail="Service worker not built")
    return File(path=sw_path, media_type="text/javascript")


API_V1_PREFIX = "/api/v1"


def create_api_v1_router(handlers: list[ControllerRouterHandler]) -> Router:
    """Mount handlers under the versioned API prefix.

    Controllers own only their domain segment (``/crowdsec``, ``/analytics``,
    ...); this router supplies the ``/api/v1`` scope. Tests that mount a
    single controller use this too, so it keeps its production URL.
    """
    return Router(path=API_V1_PREFIX, route_handlers=handlers)


def get_route_handlers() -> list[ControllerRouterHandler]:
    """Get all route handlers for the application."""

    api_handlers: list[ControllerRouterHandler] = [
        GeoEventController,
        GeoLocationController,
        AccessLogController,
        AccessLogDebugController,
        AnalyticsController,
        CrowdSecController,
        LogsController,
        SystemController,
        AuthController,
        read_settings,
        stats,
    ]

    return [
        create_api_v1_router(api_handlers),
        # The WebSocket feeds and probe endpoints live outside /api/v1: /ws/*
        # by contract, /health and /health/ready for unauthenticated probes.
        live_feed,
        crowdsec_feed,
        logs_feed,
        health,
        health_ready,
        service_worker,
    ]


def get_agent_route_handlers() -> list[ControllerRouterHandler]:
    """Route handlers for agent mode.

    Agent mode is a headless log-tailing process, not a UI/API server: no
    /api/v1, no WebSocket feeds, no SPA shell. Only the health probes stay,
    since they're how the container/orchestrator checks the process is alive.
    """
    return [health, health_ready]
