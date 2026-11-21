"""The muted IP list on AnalyticsFilters: routing flags and the SQL predicate."""
from __future__ import annotations

from ipaddress import ip_network

from geometrikks.domain.analytics.controllers import _build_filters
from geometrikks.domain.analytics.repositories import AnalyticsFilters

NETS = [ip_network("203.0.113.7/32"), ip_network("::ffff:203.0.113.7/128")]


def test_muted_list_alone_is_active_but_not_raw():
    filters = AnalyticsFilters(muted_networks=NETS)
    assert filters.is_active() and not filters.needs_raw_rows()


def test_sql_conditions_emits_cidr_predicate():
    sql, params = AnalyticsFilters(muted_networks=NETS).sql_conditions()
    assert "NOT (ip_address <<= ANY(CAST(:muted_networks AS cidr[])))" in sql
    assert params["muted_networks"] == NETS


def test_ip_include_wins():
    filters = AnalyticsFilters(ip_addresses=["203.0.113.7"], muted_networks=NETS)
    assert filters.effective_muted_networks is None
    assert "muted_networks" not in filters.sql_conditions()[1]


def test_no_list_adds_no_predicate():
    filters = AnalyticsFilters(muted_networks=None)
    assert not filters.is_active()
    assert filters.sql_conditions() == ("", {})


def test_build_filters_passes_the_list_keyword_only():
    assert _build_filters(None, None, None, muted_networks=NETS).muted_networks == NETS
    assert _build_filters(None, None, None).muted_networks is None
