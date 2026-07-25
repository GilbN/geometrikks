"""Unit tests for the analytics dimension-filter SQL builder.

These are pure string/param assertions - no database. The filters decide
whether a query can use the continuous aggregates or must scan raw
access_logs, so their is_active() gate is load-bearing.
"""
from __future__ import annotations

import pytest
from litestar.exceptions import ValidationException

from geometrikks.api.v1.analytics_controller import _build_filters
from geometrikks.domain.analytics.repositories import AnalyticsFilters


class TestIsActive:
    def test_empty_filters_are_inactive(self) -> None:
        assert AnalyticsFilters().is_active() is False

    def test_exclude_only_is_active(self) -> None:
        # Must force the raw path: the CAGGs cannot be sliced by IP.
        assert AnalyticsFilters(ip_exclude=["10.0.0.1"]).is_active() is True


class TestSqlConditions:
    def test_no_filters_yield_empty_clause(self) -> None:
        clause, params = AnalyticsFilters().sql_conditions()
        assert clause == ""
        assert params == {}

    def test_exclude_only_emits_negated_any(self) -> None:
        clause, params = AnalyticsFilters(ip_exclude=["10.0.0.1"]).sql_conditions()
        assert "NOT (ip_address = ANY(CAST(:filter_ips_exclude AS inet[])))" in clause
        assert params == {"filter_ips_exclude": ["10.0.0.1"]}

    def test_all_dimensions_emit_all_clauses(self) -> None:
        clause, params = AnalyticsFilters(
            country_codes=["NO"],
            cities=["Oslo"],
            ip_addresses=["10.0.0.1"],
            ip_exclude=["10.0.0.2"],
        ).sql_conditions()
        assert clause.count("AND") == 4
        assert set(params) == {
            "filter_countries",
            "filter_cities",
            "filter_ips",
            "filter_ips_exclude",
        }


class TestBuildFilters:
    def test_passes_exclude_through(self) -> None:
        filters = _build_filters(None, None, None, ["10.0.0.1"])
        assert filters.ip_exclude == ["10.0.0.1"]

    def test_empty_exclude_becomes_none(self) -> None:
        assert _build_filters(None, None, None, []).ip_exclude is None

    def test_invalid_excluded_ip_raises(self) -> None:
        with pytest.raises(ValidationException, match="Invalid IP address"):
            _build_filters(None, None, None, ["not-an-ip"])
