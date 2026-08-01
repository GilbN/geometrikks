"""Shared helpers for hand-built test apps."""
from __future__ import annotations

from litestar.di import Provide

from geometrikks.config.settings import get_settings


def ambient_settings_dependency() -> dict[str, Provide]:
    """App-level ``settings`` dependency for hand-built test apps.

    Resolves ``get_settings()`` per request so tests that monkeypatch env
    vars (with the autouse cache-clear fixture) keep seeing fresh values,
    exactly as handlers did when they called ``get_settings()`` inline.
    Full-app tests should prefer ``create_app(settings=...)`` instead.
    """
    return {"settings": Provide(get_settings, sync_to_thread=False)}
