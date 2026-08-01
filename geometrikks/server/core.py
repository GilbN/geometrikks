"""Application factory for creating Litestar app instance."""

from __future__ import annotations

from typing import TYPE_CHECKING

from litestar import Litestar
from litestar.di import Provide
from litestar.openapi import OpenAPIConfig
from litestar.config.compression import CompressionConfig

from geometrikks.config.settings import Settings, get_settings
from geometrikks.server import plugins
from geometrikks.server.exceptions import EXCEPTION_HANDLERS
from geometrikks.server.lifecycle import on_startup, on_shutdown
from geometrikks.server.routes import get_route_handlers
from geometrikks.api.dependencies import (
    create_settings_provider,
    provide_limit_offset_pagination,
)

if TYPE_CHECKING:
    from collections.abc import Mapping


def create_app(
    settings: Settings | None = None,
    dependencies: Mapping[str, Provide] | None = None,
) -> Litestar:
    """Create and configure the Litestar application.

    This factory function loads configuration and initializes the app
    with proper settings for CORS, OpenAPI, dependency injection, etc.

    Args:
        settings: Explicit settings for the app. Defaults to the cached
            process settings; tests pass their own instance for hermetic
            composition.
        dependencies: Extra or replacement app-level dependency providers,
            merged over the defaults. Intended for tests that substitute
            services without patching modules.

    Returns:
        Litestar: Configured application instance
    """
    if settings is None:
        settings = get_settings()
    if dependencies and "settings" in dependencies:
        # A request-level override would diverge from the settings the
        # plugins, auth, and lifecycle were composed with (split-brain
        # configuration). The settings= argument is the one way in.
        raise ValueError(
            "The 'settings' dependency is reserved; pass create_app(settings=...) instead."
        )

    # One engine per app: the same config feeds the SQLAlchemy plugin and,
    # via app.state, every non-request code path (lifecycle, health probes,
    # system inspection).
    db_config = plugins.create_sqlalchemy_config(settings)

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
    
    dependency_map: dict[str, Provide] = {
        "limit_offset": Provide(provide_limit_offset_pagination, sync_to_thread=False),
        "settings": create_settings_provider(settings),
    }
    if dependencies:
        dependency_map.update(dependencies)

    # Create app with configuration
    app = Litestar(
        debug=settings.debug,
        route_handlers=get_route_handlers(include_auth=not settings.auth_disabled),
        on_startup=[on_startup],
        on_shutdown=[on_shutdown],
        plugins=plugins.create_plugins(settings, db_config=db_config),
        dependencies=dependency_map,
        openapi_config=openapi_config,
        compression_config=compression_config,
        exception_handlers=EXCEPTION_HANDLERS,
        on_app_init=on_app_init,
    )
    app.state.auth_state = auth_state
    # Lifecycle hooks and other non-request code read the composed settings
    # and database config from state instead of re-resolving the
    # process-cached factories.
    app.state.settings = settings
    app.state.db_config = db_config

    return app