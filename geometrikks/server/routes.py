"""Central route registration."""
from pathlib import Path

from litestar import get
from litestar.datastructures import ResponseHeader
from litestar.exceptions import NotFoundException
from litestar.response import File
from litestar.types import ControllerRouterHandler

from geometrikks.api.v1.geo_events_controller import GeoEventController
from geometrikks.api.v1.geo_locations_controller import GeoLocationController
from geometrikks.api.v1.access_log_controller import AccessLogController
from geometrikks.api.v1.access_log_debug_controller import AccessLogDebugController
from geometrikks.api.v1.analytics_controller import AnalyticsController
from geometrikks.api.v1.auth_controller import AuthController
from geometrikks.api.v1.system_controller import SystemController
from geometrikks.api.v1.live_controller import live_feed
from geometrikks.api.v1.settings import read_settings
from geometrikks.api.v1.stats import stats
from geometrikks.api.health import health, health_ready


@get(
    "/sw.js",
    include_in_schema=False,
    sync_to_thread=False,
    # The browser must be able to revalidate the worker promptly or updates
    # stall; never serve it with a long-lived cache header.
    response_headers=[ResponseHeader(name="Cache-Control", value="no-cache")],
)
def service_worker() -> File:
    sw_path = Path("public/sw.js")
    if not sw_path.is_file():
        raise NotFoundException(detail="Service worker not built")
    return File(path=sw_path, media_type="text/javascript")


@get(
    "/manifest.webmanifest",
    include_in_schema=False,
    sync_to_thread=False,
    # Served from the origin root (like /sw.js) so the same URL works in dev,
    # where /static/ is proxied to the Vite dev server and the built manifest
    # does not exist there; the SPA fallback would return HTML and the browser
    # would log a manifest syntax error on every page load.
    response_headers=[ResponseHeader(name="Cache-Control", value="no-cache")],
)
def web_manifest() -> File:
    manifest_path = Path("public/manifest.webmanifest")
    if not manifest_path.is_file():
        raise NotFoundException(detail="Web app manifest not built")
    return File(path=manifest_path, media_type="application/manifest+json")


def get_route_handlers(*, include_auth: bool = True) -> list[ControllerRouterHandler]:
    """Get all route handlers for the application.

    Args:
        include_auth: Register the login/logout/me endpoints. Disabled when
            APP_AUTH_DISABLED=true — without the session middleware those
            handlers would crash on ``app.state.auth_state`` / ``request.user``.
    """

    handlers: list[ControllerRouterHandler] = [
        GeoEventController,
        GeoLocationController,
        AccessLogController,
        AccessLogDebugController,
        AnalyticsController,
        SystemController,
        live_feed,
        read_settings,
        stats,
        health,
        health_ready,
        service_worker,
        web_manifest,
    ]

    if include_auth:
        handlers.append(AuthController)
    return handlers