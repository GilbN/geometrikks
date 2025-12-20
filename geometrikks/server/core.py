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
    provide_parser,
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

    # Configure OpenAPI
    openapi_config = OpenAPIConfig(
        title=settings.name,
        version=settings.version,
        description=settings.description,
        create_examples=True,
    )
    
    compression_config = CompressionConfig(
        backend="brotli",
        minimum_size=1000,  # Only compress responses >= 1KB
        brotli_quality=4,
        exclude=[
            r"^/ws/.*",  # Exclude WebSocket endpoints
        ],
    )
    
    logging_middleware_config = LoggingMiddlewareConfig()

    # Create app with configuration
    app = Litestar(
        debug=settings.debug,
        route_handlers=get_route_handlers(),
        on_startup=[on_startup],
        on_shutdown=[on_shutdown],
        plugins=[
            plugins.sqlalchemy_plugin,
            plugins.geoalchemy_plugin,
            plugins.granian_plugin,
            plugins.vite_plugin,
        ],
        dependencies={
            "log_parser": Provide(provide_parser, sync_to_thread=False),
            "limit_offset": Provide(provide_limit_offset_pagination, sync_to_thread=False),
            "transaction": provide_transaction,
        },
        logging_config=plugins.logging_config,
        openapi_config=openapi_config,
        compression_config=compression_config,
        middleware=[logging_middleware_config.middleware],
    )

    return app