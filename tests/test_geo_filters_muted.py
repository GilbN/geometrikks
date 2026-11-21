"""Muted networks on GeoEventFilters, the access-log filter and the wrapper providers."""
from __future__ import annotations

from ipaddress import ip_network

import pytest
from advanced_alchemy.filters import CollectionFilter, FilterTypes
from sqlalchemy import select
from sqlalchemy.dialects import postgresql

from geometrikks.domain.geo.controllers.events import provide_geo_filters
from geometrikks.domain.geo.schemas import GeoEventFilters
from geometrikks.domain.logs.controllers.access_logs import provide_in_filters
from geometrikks.domain.logs.models import AccessLog
from geometrikks.domain.muted_ips.filters import MutedNetworksFilter

pytestmark = pytest.mark.anyio

NETS = [ip_network("203.0.113.7/32"), ip_network("::ffff:203.0.113.7/128")]


def test_geo_muted_alone_is_active_not_forced_raw():
    filters = GeoEventFilters(muted_networks=NETS)
    assert filters.is_active() and not filters.forces_raw


def test_geo_sql_uses_alias():
    sql, params = GeoEventFilters(muted_networks=NETS).sql_conditions("c", "gl", asn_column="asn")
    assert "NOT (c.ip_address <<= ANY(CAST(:muted_networks AS cidr[])))" in sql
    assert params["muted_networks"] == NETS


def test_geo_include_wins():
    filters = GeoEventFilters(ip_include=["203.0.113.7"], muted_networks=NETS)
    assert filters.effective_muted_networks is None
    assert "muted_networks" not in filters.sql_conditions("ge", "gl")[1]


async def test_geo_wrapper_adds_the_list_to_the_base_filters():
    base = GeoEventFilters(country_codes=["NO"])
    result = await provide_geo_filters(base, NETS)
    assert result.muted_networks == NETS and result.country_codes == ["NO"]
    assert base.muted_networks is None


def test_filter_compiles_to_a_cidr_array_predicate():
    statement = MutedNetworksFilter(NETS).append_to_statement(select(AccessLog.id), AccessLog)
    sql = str(statement.compile(dialect=postgresql.dialect()))
    assert "NOT (access_logs.ip_address <<= ANY (" in sql


async def test_access_log_wrapper_appends_the_filter_without_an_include():
    result = await provide_in_filters([], NETS)
    assert [type(item) for item in result] == [MutedNetworksFilter]


async def test_access_log_wrapper_skips_it_when_an_include_is_set():
    base: list[FilterTypes] = [CollectionFilter(field_name="ip_address", values=["203.0.113.7"])]
    assert await provide_in_filters(base, NETS) == base


async def test_access_log_wrapper_passes_through_without_a_list():
    assert await provide_in_filters([], None) == []
