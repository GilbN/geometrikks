"""Application factory for creating Litestar app instance."""

from __future__ import annotations


from litestar import Litestar
from litestar.di import Provide
from litestar.openapi import OpenAPIConfig
from litestar.config.compression import CompressionConfig

from geometrikks.config.settings import get_settings
from geometrikks.server import plugins
from geometrikks.server.exceptions import CROWDSEC_EXCEPTION_HANDLERS
from geometrikks.server.lifecycle import on_startup, on_shutdown
from geometrikks.server.routes import get_route_handlers
from geometrikks.api.dependencies import provide_limit_offset_pagination


def create_app() -> Litestar:
    """Create and configure the Litestar application.
    
    This factory function loads configuration and initializes the app
    with proper settings for CORS, OpenAPI, dependency injection, etc.
    
    Returns:
        Litestar: Configured application instance
    """
    # Load settings once at app creation
    settings = get_settings()

    from geometrikks.server.auth import build_auth_state, create_session_auth, warn_auth_disabled

    on_app_init = []
    auth_state = None
    if settings.auth_disabled:
        # Documented reverse-proxy mode (Authelia/Tailscale in front).
        warn_auth_disabled()
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
    
    # Create app with configuration
    app = Litestar(
        debug=settings.debug,
        route_handlers=get_route_handlers(include_auth=not settings.auth_disabled),
        on_startup=[on_startup],
        on_shutdown=[on_shutdown],
        plugins=plugins.create_plugins(),
        dependencies={
            "limit_offset": Provide(provide_limit_offset_pagination, sync_to_thread=False),
        },
        openapi_config=openapi_config,
        compression_config=compression_config,
        exception_handlers=CROWDSEC_EXCEPTION_HANDLERS,
        on_app_init=on_app_init,
    )
    app.state.auth_state = auth_state

    return app