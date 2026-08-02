"""Shared helpers for hand-built test apps."""
from __future__ import annotations

from contextlib import AsyncExitStack, asynccontextmanager
from typing import TYPE_CHECKING

from litestar.di import Provide

from geometrikks.config.settings import get_settings

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator


def ambient_settings_dependency() -> dict[str, Provide]:
    """App-level ``settings`` dependency for hand-built test apps.

    Resolves ``get_settings()`` per request so tests that monkeypatch env
    vars (with the autouse cache-clear fixture) keep seeing fresh values,
    exactly as handlers did when they called ``get_settings()`` inline.
    Full-app tests should prefer ``create_app(settings=...)`` instead.
    """
    return {"settings": Provide(get_settings, sync_to_thread=False)}


@asynccontextmanager
async def enter_lifespan(app) -> AsyncGenerator[None]:
    """Enter every lifecycle manager in order and exit in reverse.

    Mirrors how Litestar runs ``LIFESPAN`` on its ``AsyncExitStack``, for
    lifecycle tests that drive a bare stand-in app instead of a real
    Litestar instance.
    """
    from geometrikks.server import lifecycle

    async with AsyncExitStack() as stack:
        for manager in lifecycle.LIFESPAN:
            await stack.enter_async_context(manager(app))
        yield
