"""Central route registration."""
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
    ]

    if include_auth:
        handlers.append(AuthController)
    return handlers