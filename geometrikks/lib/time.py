"""Shared datetime helpers."""

from __future__ import annotations

from datetime import UTC, datetime


def ensure_utc(dt: datetime) -> datetime:
    """Treat naive API timestamps as UTC and normalize aware ones to UTC."""
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)
