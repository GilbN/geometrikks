"""Application factory for creating Litestar app instance."""

from __future__ import annotations


from litestar import Litestar
from litestar.di import Provide
from litestar.openapi import OpenAPIConfig
from litestar.config.compression import CompressionConfig
from litestar.middleware.logging import LoggingMiddlewareConfig

from geometrikks.config.settings import get_settings
from geometrikks.server import plugins
from geometrikks.server.lifecycle import on_startup, on_shutdown
from geometrikks.server.routes import get_route_handlers
from geometrikks.api.dependencies import (
    provide_transaction,
    provide_limit_offset_pagination
)


def create_app() -> Litestar:
    """Create and configure the Litestar application.
    
    This factory function loads configuration and initializes the app
    with proper settings for CORS, OpenAPI, dependency injection, etc.
    
    Returns:
        Litestar: Configured application instance
    """
    # Load settings once at app creation
    settings = get_settings()

    from geometrikks.server.auth import build_auth_state, create_session_auth

    on_app_init = []
    auth_state = None
    if settings.auth_disabled:
        # Documented reverse-proxy mode (Authelia/Tailscale in front).
        import logging
        logging.getLogger(__name__).warning(
            "APP_AUTH_DISABLED=true: API is unauthenticated. Only run this "
            "behind an authenticating reverse proxy."
        )
    else:
        auth_state = build_auth_state(settings)
        on_app_init.append(create_session_auth(settings).on_app_init)

    # Configure OpenAPI
    openapi_config = OpenAPIConfig(
        title=settings.name,
        version=settings.version,
        description=settings.description,
        create_examples=False,
    )
    
    compression_config = CompressionConfig(
        backend="brotli",
        minimum_size=1000,  # Only compress responses >= 1KB
        brotli_quality=4,
        exclude=[
            r"^/ws/.*",  # Exclude WebSocket endpoints
        ],
    )
    
    logging_middleware_config = LoggingMiddlewareConfig(
        response_log_fields=("status_code",),
        request_log_fields=(
                "path",
                "method",
                "query",
                "path_params",
            ),
    )

    # Create app with configuration
    app = Litestar(
        debug=settings.debug,
        route_handlers=get_route_handlers(),
        on_startup=[on_startup],
        on_shutdown=[on_shutdown],
        plugins=plugins.create_plugins(),
        dependencies={
            "limit_offset": Provide(provide_limit_offset_pagination, sync_to_thread=False),
            "transaction": provide_transaction,
        },
        logging_config=plugins.create_logging_config(settings),
        openapi_config=openapi_config,
        compression_config=compression_config,
        middleware=[logging_middleware_config.middleware],
        on_app_init=on_app_init,
    )
    app.state.auth_state = auth_state

    return app