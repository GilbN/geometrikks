"""Central route registration."""
from litestar.types import ControllerRouterHandler

from geometrikks.api.v1.geo_events_controller import GeoEventController
from geometrikks.api.v1.geo_locations_controller import GeoLocationController
from geometrikks.api.v1.access_log_controller import AccessLogController
from geometrikks.api.v1.access_log_debug_controller import AccessLogDebugController
from geometrikks.api.v1.analytics_controller import AnalyticsController
from geometrikks.api.v1.auth_controller import AuthController
from geometrikks.api.v1.settings import read_settings
from geometrikks.api.v1.stats import stats
from geometrikks.api.health import health, health_ready


def get_route_handlers() -> list[ControllerRouterHandler]:
    """Get all route handlers for the application."""
    return [
        GeoEventController,
        GeoLocationController,
        AccessLogController,
        AccessLogDebugController,
        AnalyticsController,
        AuthController,
        read_settings,
        stats,
        health,
        health_ready,
    ]