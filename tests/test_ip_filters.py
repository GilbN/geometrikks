"""Parsing and SQL for the IP include/exclude filters that take CIDR ranges."""
from __future__ import annotations

from ipaddress import ip_network

import pytest
from advanced_alchemy.filters import FilterTypes
from sqlalchemy import select
from sqlalchemy.dialects import postgresql

from geometrikks.domain.analytics.repositories import AnalyticsFilters
from geometrikks.domain.exceptions import DomainValidationError
from geometrikks.domain.geo.schemas import GeoEventFilters
from geometrikks.domain.logs.controllers.access_logs import provide_in_filters
from geometrikks.domain.logs.models import AccessLog
from geometrikks.domain.muted_ips.filters import MutedNetworksFilter
from geometrikks.lib.ip_filters import (
    IpMatchFilter,
    ip_match_filter,
    ip_match_sql,
    parse_ip_filter,
)

pytestmark = pytest.mark.anyio


class TestParse:
    def test_splits_addresses_from_ranges_and_adds_mapped_twins(self) -> None:
        match = parse_ip_filter(["203.0.113.7", "198.51.100.0/24", "2001:db8::/64"])
        assert match.addresses == ("203.0.113.7", "::ffff:203.0.113.7")
        assert match.networks == (
            ip_network("198.51.100.0/24"),
            ip_network("::ffff:198.51.100.0/120"),
            ip_network("2001:db8::/64"),
        )

    @pytest.mark.parametrize(
        ("value", "addresses"),
        [
            ("203.0.113.7/32", ("203.0.113.7", "::ffff:203.0.113.7")),
            ("::ffff:203.0.113.7/128", ("203.0.113.7", "::ffff:203.0.113.7")),
            ("::ffff:203.0.113.7", ("203.0.113.7", "::ffff:203.0.113.7")),
            ("2001:db8::1/128", ("2001:db8::1",)),
        ],
    )
    def test_a_full_length_prefix_is_an_address_matched_in_both_forms(
        self, value: str, addresses: tuple[str, ...]
    ) -> None:
        assert parse_ip_filter([value]).addresses == addresses

    def test_a_mapped_range_collapses_to_ipv4(self) -> None:
        assert parse_ip_filter(["::ffff:198.51.100.0/120"]).networks[0] == ip_network("198.51.100.0/24")

    def test_host_bits_are_rejected_with_the_muted_ips_message(self) -> None:
        with pytest.raises(DomainValidationError) as raised:
            parse_ip_filter(["10.0.0.5/8"])
        assert raised.value.code == "invalid_network"
        assert "10.0.0.0/8" in raised.value.detail and "10.0.0.5" in raised.value.detail

    @pytest.mark.parametrize("value", ["nope", "10.0.0.0/33", "10.0.0.0/", "u/8", "fe80::1%eth0"])
    def test_anything_else_is_rejected(self, value: str) -> None:
        with pytest.raises(DomainValidationError):
            parse_ip_filter([value])

    def test_repeated_values_are_matched_once(self) -> None:
        match = parse_ip_filter(["203.0.113.7", "::ffff:203.0.113.7", "198.51.100.0/24", "198.51.100.0/24"])
        assert match.addresses == ("203.0.113.7", "::ffff:203.0.113.7")
        assert len(match.networks) == 2

    def test_no_values_is_a_caller_error(self) -> None:
        with pytest.raises(ValueError, match="at least one value"):
            parse_ip_filter([])


class TestSql:
    def test_addresses_alone_keep_the_plain_array_match(self) -> None:
        clause, params = ip_match_sql("ge.ip_address", ["2001:db8::1"], "filter_ips")
        assert clause == "ge.ip_address = ANY(CAST(:filter_ips AS inet[]))"
        assert params == {"filter_ips": ["2001:db8::1"]}

    def test_a_range_becomes_explicit_bounds(self) -> None:
        clause, params = ip_match_sql("ip_address", ["2001:db8::/64"], "filter_ips")
        assert clause == (
            "(ip_address >= CAST(:filter_ips_low_0 AS inet) AND ip_address <= CAST(:filter_ips_high_0 AS inet))"
        )
        assert params == {"filter_ips_low_0": "2001:db8::", "filter_ips_high_0": "2001:db8::ffff:ffff:ffff:ffff"}

    def test_addresses_and_ranges_are_ored(self) -> None:
        clause, params = ip_match_sql("ip_address", ["10.0.0.1", "198.51.100.0/24"], "p")
        assert clause.startswith("(ip_address = ANY(CAST(:p AS inet[])) OR (ip_address >= CAST(:p_low_0")
        assert clause.count(" OR ") == 2
        assert (params["p_low_1"], params["p_high_1"]) == ("::ffff:198.51.100.0", "::ffff:198.51.100.255")

    def test_analytics_excludes_wrap_the_whole_match_in_not(self) -> None:
        clause, params = AnalyticsFilters(ip_exclude=["10.0.0.1", "10.1.0.0/16"]).sql_conditions()
        assert clause.startswith("AND NOT ((ip_address = ANY(CAST(:filter_ips_exclude AS inet[])) OR ")
        assert (params["filter_ips_exclude_low_0"], params["filter_ips_exclude_high_0"]) == ("10.1.0.0", "10.1.255.255")
        assert clause.endswith("))")

    def test_include_and_exclude_params_stay_apart(self) -> None:
        _, params = AnalyticsFilters(ip_addresses=["10.0.0.0/8"], ip_exclude=["10.1.0.0/16"]).sql_conditions()
        assert (params["filter_ips_low_0"], params["filter_ips_exclude_low_0"]) == ("10.0.0.0", "10.1.0.0")

    def test_geo_uses_the_events_alias(self) -> None:
        clause, _ = GeoEventFilters(ip_include=["10.1.0.0/16"]).sql_conditions("c", "gl", asn_column="asn")
        assert "c.ip_address >= CAST(:filter_ips_low_0 AS inet)" in clause


class TestStatementFilter:
    def _compile(self, statement_filter: IpMatchFilter) -> str:
        statement = statement_filter.append_to_statement(select(AccessLog.id), AccessLog)
        return str(statement.compile(dialect=postgresql.dialect()))

    def test_include_compiles_to_in_or_bounds(self) -> None:
        sql = self._compile(IpMatchFilter(["10.0.0.1", "10.1.0.0/16"]))
        assert "access_logs.ip_address IN (" in sql
        assert "access_logs.ip_address >= " in sql and "access_logs.ip_address <= " in sql

    def test_exclude_negates_the_whole_match(self) -> None:
        sql = self._compile(IpMatchFilter(["10.0.0.1", "10.1.0.0/16"], exclude=True))
        assert "WHERE NOT (access_logs.ip_address IN (" in sql
        assert sql.rstrip().endswith(")")


async def test_an_include_range_drops_the_muted_list() -> None:
    base: list[FilterTypes] = [ip_match_filter(["203.0.113.0/24"])]
    assert await provide_in_filters(base, [ip_network("203.0.113.0/24")]) == base


async def test_an_exclude_keeps_the_muted_list() -> None:
    base: list[FilterTypes] = [ip_match_filter(["198.51.100.0/24"], exclude=True)]
    result = await provide_in_filters(base, [ip_network("203.0.113.0/24")])
    assert [type(item) for item in result] == [IpMatchFilter, MutedNetworksFilter]
