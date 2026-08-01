"""Chart granularity resolution: explicit override wins, fallback is the
existing get_stats_granularity routing, RAW is never returned."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from geometrikks.domain.exceptions import DomainValidationError

from geometrikks.api.v1.analytics_controller import _build_filters, _resolve_chart_granularity
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


def test_build_filters_accepts_valid_ipv4():
    filters = _build_filters(None, None, ["1.1.1.1", "2.2.2.2"])
    assert filters.ip_addresses == ["1.1.1.1", "2.2.2.2"]


def test_build_filters_accepts_valid_ipv6():
    filters = _build_filters(None, None, ["2001:db8::1"])
    assert filters.ip_addresses == ["2001:db8::1"]


def test_build_filters_rejects_invalid_ip():
    with pytest.raises(DomainValidationError):
        _build_filters(None, None, ["not-an-ip"])


def test_build_filters_all_none_is_inactive():
    filters = _build_filters(None, None, None)
    assert filters.is_active() is False
    assert filters.country_codes is None
    assert filters.cities is None
    assert filters.ip_addresses is None


def test_build_filters_empty_lists_behave_like_none():
    filters = _build_filters([], [], [])
    assert filters.is_active() is False
    assert filters.country_codes is None
    assert filters.cities is None
    assert filters.ip_addresses is None
