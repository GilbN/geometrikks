"""Custom filter providers for the historical access-logs list endpoint.

Search / sort / pagination / IN-filtering are provided declaratively by
advanced-alchemy's ``create_service_dependencies`` (library-tested); these
tests cover the two project-specific providers appended alongside it.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from advanced_alchemy.filters import CollectionFilter, OnBeforeAfter, SearchFilter
from litestar.exceptions import ValidationException

from geometrikks.api.v1.access_log_controller import (
    provide_access_log_host_search,
    provide_access_log_in_filters,
    provide_access_log_time_window,
)


class TestTimeWindow:
    def test_no_window_when_both_bounds_none(self) -> None:
        assert provide_access_log_time_window(None, None) == []

    def test_adds_inclusive_window_on_timestamp(self) -> None:
        start = datetime(2026, 7, 1, tzinfo=timezone.utc)
        end = datetime(2026, 7, 2, tzinfo=timezone.utc)
        result = provide_access_log_time_window(start, end)
        assert len(result) == 1
        window = result[0]
        assert isinstance(window, OnBeforeAfter)
        assert window.field_name == "timestamp"
        assert window.on_or_after == start
        assert window.on_or_before == end

    def test_open_ended_window_when_only_one_bound(self) -> None:
        start = datetime(2026, 7, 1, tzinfo=timezone.utc)
        result = provide_access_log_time_window(start, None)
        assert len(result) == 1
        window = result[0]
        assert isinstance(window, OnBeforeAfter)
        assert window.on_or_after == start
        assert window.on_or_before is None


class TestHostSearch:
    def test_empty_host_yields_no_filter(self) -> None:
        assert provide_access_log_host_search(None) == []
        assert provide_access_log_host_search("") == []

    def test_builds_case_insensitive_substring_filter(self) -> None:
        result = provide_access_log_host_search("example.com")
        assert len(result) == 1
        search = result[0]
        assert isinstance(search, SearchFilter)
        assert search.field_name == "host"
        assert search.value == "example.com"
        assert search.ignore_case is True


class TestInFilters:
    def test_absent_params_yield_no_filters(self) -> None:
        assert provide_access_log_in_filters(None, None) == []
        assert provide_access_log_in_filters([], []) == []

    def test_builds_collection_filters(self) -> None:
        result = provide_access_log_in_filters(["GET", "POST"], ["10.0.0.1"])
        assert len(result) == 2
        method, ip = result
        assert isinstance(method, CollectionFilter)
        assert method.field_name == "method"
        assert method.values == ["GET", "POST"]
        assert isinstance(ip, CollectionFilter)
        assert ip.field_name == "ip_address"
        assert ip.values == ["10.0.0.1"]

    def test_accepts_ipv6(self) -> None:
        result = provide_access_log_in_filters(None, ["2001:db8::1"])
        assert len(result) == 1

    def test_invalid_ip_raises_validation_error(self) -> None:
        # ip_address is INET — free text must 400, not fail bind-param encoding.
        with pytest.raises(ValidationException, match="Invalid IP address"):
            provide_access_log_in_filters(None, ["u"])

    def test_builds_city_and_country_filters(self) -> None:
        result = provide_access_log_in_filters(None, None, ["Oslo"], ["NO", "SE"])
        assert len(result) == 2
        city, country = result
        assert isinstance(city, CollectionFilter)
        assert city.field_name == "city"
        assert city.values == ["Oslo"]
        assert isinstance(country, CollectionFilter)
        assert country.field_name == "country_code"
        assert country.values == ["NO", "SE"]

    def test_absent_city_country_yield_no_filters(self) -> None:
        assert provide_access_log_in_filters(None, None, None, None) == []
        assert provide_access_log_in_filters(None, None, [], []) == []
