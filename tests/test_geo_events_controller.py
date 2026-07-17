"""Provider + filter-construction tests for the rebuilt geo-events controller.

Search/sort/pagination come from advanced-alchemy's create_service_dependencies
(library-tested); these cover the project-specific providers and the
GeoEventFilters SQL fragments consumed by the aggregate endpoints.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest
from advanced_alchemy.filters import CollectionFilter, NotInCollectionFilter, OnBeforeAfter
from litestar.exceptions import ValidationException

from geometrikks.api.v1.geo_events_controller import (
    GeoEventController,
    provide_geo_event_filters,
    provide_geo_event_in_filters,
    provide_geo_event_time_window,
)
from geometrikks.domain.geo.schemas import GeoEventFilters, GeoLogPeriod


class TestTimeWindow:
    def test_no_window_when_both_bounds_none(self) -> None:
        assert provide_geo_event_time_window(None, None) == []

    def test_adds_inclusive_window_on_timestamp(self) -> None:
        start = datetime(2026, 7, 1, tzinfo=timezone.utc)
        end = datetime(2026, 7, 2, tzinfo=timezone.utc)
        result = provide_geo_event_time_window(start, end)
        assert len(result) == 1
        window = result[0]
        assert isinstance(window, OnBeforeAfter)
        assert window.field_name == "timestamp"
        assert window.on_or_after == start
        assert window.on_or_before == end

    def test_normalizes_window_bounds_to_utc(self) -> None:
        start = datetime(2026, 7, 1, 2, tzinfo=timezone(timedelta(hours=2)))
        end = datetime(2026, 7, 2)

        window = provide_geo_event_time_window(start, end)[0]

        assert window.on_or_after == datetime(2026, 7, 1, tzinfo=timezone.utc)
        assert window.on_or_before == datetime(2026, 7, 2, tzinfo=timezone.utc)


class TestInFilters:
    def test_absent_params_yield_no_filters(self) -> None:
        assert provide_geo_event_in_filters(None, None, None) == []
        assert provide_geo_event_in_filters([], [], []) == []

    def test_builds_include_exclude_and_hostname_filters(self) -> None:
        result = provide_geo_event_in_filters(["10.0.0.1"], ["10.0.0.2"], ["web1"])
        assert len(result) == 3
        include, exclude, host = result
        assert isinstance(include, CollectionFilter)
        assert include.field_name == "ip_address"
        assert include.values == ["10.0.0.1"]
        assert isinstance(exclude, NotInCollectionFilter)
        assert exclude.field_name == "ip_address"
        assert exclude.values == ["10.0.0.2"]
        assert isinstance(host, CollectionFilter)
        assert host.field_name == "hostname"
        assert host.values == ["web1"]

    def test_accepts_ipv6(self) -> None:
        assert len(provide_geo_event_in_filters(["2001:db8::1"], ["::1"], None)) == 2

    def test_invalid_include_ip_raises(self) -> None:
        # ip_address is INET — free text must 400, not fail bind-param encoding.
        with pytest.raises(ValidationException, match="Invalid IP address"):
            provide_geo_event_in_filters(["not-an-ip"], None, None)

    def test_invalid_exclude_ip_raises(self) -> None:
        with pytest.raises(ValidationException, match="Invalid IP address"):
            provide_geo_event_in_filters(None, ["not-an-ip"], None)


class TestAggregateFilters:
    def test_empty_params_build_inactive_filters(self) -> None:
        filters = provide_geo_event_filters(None, None, None, None, None)
        assert isinstance(filters, GeoEventFilters)
        assert not filters.is_active()
        assert not filters.forces_raw

    def test_all_params_carried_over(self) -> None:
        filters = provide_geo_event_filters(
            ["NO"], ["Oslo"], ["10.0.0.1"], ["10.0.0.2"], ["web1"]
        )
        assert filters.country_codes == ["NO"]
        assert filters.cities == ["Oslo"]
        assert filters.ip_include == ["10.0.0.1"]
        assert filters.ip_exclude == ["10.0.0.2"]
        assert filters.hostnames == ["web1"]
        assert filters.is_active()

    def test_invalid_ips_raise_in_both_lists(self) -> None:
        with pytest.raises(ValidationException, match="Invalid IP address"):
            provide_geo_event_filters(None, None, ["bad"], None, None)
        with pytest.raises(ValidationException, match="Invalid IP address"):
            provide_geo_event_filters(None, None, None, ["bad"], None)

    def test_only_hostnames_force_raw(self) -> None:
        assert provide_geo_event_filters(None, None, None, None, ["web1"]).forces_raw
        assert not provide_geo_event_filters(["NO"], None, ["10.0.0.1"], None, None).forces_raw


class TestSummaryComparison:
    async def test_previous_period_is_adjacent_and_equal_length(self) -> None:
        start = datetime(2026, 7, 2, tzinfo=timezone.utc)
        end = datetime(2026, 7, 3, tzinfo=timezone.utc)
        current = GeoLogPeriod(total_events=10, unique_ips=5, unique_countries=2, unique_cities=3)
        previous = GeoLogPeriod(total_events=5, unique_ips=4, unique_countries=2, unique_cities=2)
        service = MagicMock()
        service.get_summary = AsyncMock(side_effect=[current, previous])

        response = await GeoEventController.get_geo_log_summary.fn(
            None, service, GeoEventFilters(), start, end, compare_previous=True
        )

        assert service.get_summary.await_args_list[0].args[:2] == (start, end)
        assert service.get_summary.await_args_list[1].args[:2] == (
            datetime(2026, 7, 1, tzinfo=timezone.utc),
            start,
        )
        assert response.previous_period == previous


class TestFiltersSqlConditions:
    def test_inactive_filters_emit_nothing(self) -> None:
        sql, params = GeoEventFilters().sql_conditions("ge", "gl")
        assert sql == ""
        assert params == {}

    def test_fragments_use_aliases_and_inet_casts(self) -> None:
        filters = GeoEventFilters(
            country_codes=["no"],
            cities=["Oslo"],
            ip_include=["10.0.0.1"],
            ip_exclude=["10.0.0.2"],
            hostnames=["web1"],
        )
        sql, params = filters.sql_conditions("ge", "gl")
        assert "AND gl.country_code = ANY(:filter_countries)" in sql
        assert "AND gl.city = ANY(:filter_cities)" in sql
        assert "AND ge.ip_address = ANY(CAST(:filter_ips AS inet[]))" in sql
        assert "AND NOT (ge.ip_address = ANY(CAST(:filter_ips_excl AS inet[])))" in sql
        assert "AND ge.hostname = ANY(:filter_hostnames)" in sql
        assert params["filter_countries"] == ["NO"]  # normalized upper-case
        assert params["filter_ips"] == ["10.0.0.1"]
        assert params["filter_ips_excl"] == ["10.0.0.2"]
