"""App-composition dependency providers registered by create_app()."""
from __future__ import annotations

from litestar.di import Provide

from geometrikks.config.settings import Settings


def create_settings_provider(settings: Settings) -> Provide:
    """Build the app-level ``settings`` dependency around an explicit object.

    ``create_app()`` registers this so request handlers receive the exact
    settings the app was composed with; tests can pass their own ``Settings``
    to ``create_app(settings=...)`` instead of mutating process state.
    """

    def provide_settings() -> Settings:
        return settings

    return Provide(provide_settings, sync_to_thread=False)
