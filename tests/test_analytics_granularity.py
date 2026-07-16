"""Chart granularity resolution: explicit override wins, fallback is the
existing get_stats_granularity routing, RAW is never returned."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from geometrikks.api.v1.analytics_controller import _resolve_chart_granularity
from geometrikks.domain.analytics.repositories import StatsGranularity

NOW = datetime(2026, 7, 16, 12, 0, tzinfo=timezone.utc)


def test_explicit_override_wins():
    start = NOW - timedelta(days=14)
    assert _resolve_chart_granularity(start, NOW, "daily") is StatsGranularity.DAILY
    assert _resolve_chart_granularity(start, NOW, "hourly") is StatsGranularity.HOURLY


def test_fallback_matches_get_stats_granularity():
    # > 30 days -> DAILY (unchanged default routing)
    assert _resolve_chart_granularity(NOW - timedelta(days=90), NOW, None) is StatsGranularity.DAILY
    # 24h..30d -> HOURLY (unchanged default routing)
    assert _resolve_chart_granularity(NOW - timedelta(days=14), NOW, None) is StatsGranularity.HOURLY


def test_raw_is_never_returned():
    # <= 24h falls back to RAW internally but must clamp to HOURLY for charts
    assert _resolve_chart_granularity(NOW - timedelta(hours=6), NOW, None) is StatsGranularity.HOURLY
