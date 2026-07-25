"""Custom filter providers for the historical access-logs list endpoint.

Search / sort / pagination / IN-filtering are provided declaratively by
advanced-alchemy's ``create_service_dependencies`` (library-tested); these
tests cover the two project-specific providers appended alongside it.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from litestar.exceptions import ValidationException
from sqlalchemy import or_
from advanced_alchemy.filters import (
    CollectionFilter,
    FilterGroup,
    NotInCollectionFilter,
    NullFilter,
    OnBeforeAfter,
)

from geometrikks.api.v1.access_log_controller import (
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

    def test_ip_address_not_in_yields_not_in_collection_filter(self) -> None:
        result = provide_access_log_in_filters(
            None, None, None, None, None, ["10.0.0.5", "10.0.0.6"]
        )
        assert len(result) == 1
        excluded = result[0]
        assert isinstance(excluded, NotInCollectionFilter)
        assert excluded.field_name == "ip_address"
        assert excluded.values == ["10.0.0.5", "10.0.0.6"]

    def test_invalid_excluded_ip_raises_validation_error(self) -> None:
        # Same INET bind-param hazard as the include list.
        with pytest.raises(ValidationException, match="Invalid IP address"):
            provide_access_log_in_filters(None, None, None, None, None, ["nope"])

    def test_host_in_yields_collection_filter(self) -> None:
        result = provide_access_log_in_filters(
            None, None, None, None, None, None, ["a.example.com"]
        )
        assert len(result) == 1
        host = result[0]
        assert isinstance(host, CollectionFilter)
        assert host.field_name == "host"
        assert host.values == ["a.example.com"]

    def test_host_not_in_keeps_rows_with_no_host(self) -> None:
        # host is nullable, and SQL `NULL NOT IN (...)` is NULL, not TRUE. A
        # bare NotInCollectionFilter would silently drop every row whose host
        # never parsed, so the exclusion is OR'd with IS NULL.
        result = provide_access_log_in_filters(
            None, None, None, None, None, None, None, ["vault.example.com"]
        )
        assert len(result) == 1
        group = result[0]
        assert isinstance(group, FilterGroup)
        assert group.logical_operator is or_
        excluded, is_null = group.filters
        assert isinstance(excluded, NotInCollectionFilter)
        assert excluded.field_name == "host"
        assert excluded.values == ["vault.example.com"]
        assert isinstance(is_null, NullFilter)
        assert is_null.field_name == "host"

    def test_include_and_exclude_compose(self) -> None:
        result = provide_access_log_in_filters(
            None, ["10.0.0.1"], None, None, None, ["10.0.0.2"], ["a.example.com"], ["b.example.com"]
        )
        assert [type(f).__name__ for f in result] == [
            "CollectionFilter",
            "NotInCollectionFilter",
            "CollectionFilter",
            "FilterGroup",
        ]

    def test_absent_new_params_yield_no_filters(self) -> None:
        assert provide_access_log_in_filters(
            None, None, None, None, None, None, None, None
        ) == []
        assert provide_access_log_in_filters(None, None, None, None, None, [], [], []) == []
