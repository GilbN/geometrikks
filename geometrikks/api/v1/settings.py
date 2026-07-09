"""Read-only, whitelisted application settings for the frontend.

Deliberately NOT settings.model_dump(): the full Settings tree contains
database credentials and the admin password. Only fields listed here are
exposed; add new fields consciously.
"""

from __future__ import annotations

from dataclasses import dataclass

from litestar import get

from geometrikks.config.settings import get_settings


@dataclass
class LogparserSettingsView:
    log_paths: list[str]
    send_logs: bool
    store_debug_lines: bool


@dataclass
class AnalyticsSettingsView:
    raw_retention_days: int
    debug_retention_days: int
    hourly_retention_days: int
    compression_after_days: int


@dataclass
class SafeSettingsResponse:
    name: str
    version: str
    environment: str
    logparser: LogparserSettingsView
    analytics: AnalyticsSettingsView


@get("/api/v1/settings", tags=["Settings"])
async def read_settings() -> SafeSettingsResponse:
    """Whitelisted runtime settings (no credentials, ever)."""
    s = get_settings()
    return SafeSettingsResponse(
        name=s.name,
        version=s.version,
        environment=s.environment,
        logparser=LogparserSettingsView(
            log_paths=[str(p) for p in s.logparser.log_paths],
            send_logs=s.logparser.send_logs,
            store_debug_lines=s.logparser.store_debug_lines,
        ),
        analytics=AnalyticsSettingsView(
            raw_retention_days=s.analytics.raw_retention_days,
            debug_retention_days=s.analytics.debug_retention_days,
            hourly_retention_days=s.analytics.hourly_retention_days,
            compression_after_days=s.analytics.compression_after_days,
        ),
    )
