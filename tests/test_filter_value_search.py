"""Name search over the access log filter values, for the command palette."""
from __future__ import annotations

import asyncio

from geometrikks.domain.logs.filter_value_search import (
    FilterValueTotals,
    FilterValueTotalsCache,
    _busiest_first,
    _Entry,
    fold,
    match_filter_values,
)
from geometrikks.domain.logs.schemas import (
    AsnMatch,
    CityMatch,
    CountryMatch,
    HostMatch,
    ServerMatch,
)


def _totals() -> FilterValueTotals:
    countries = [
        CountryMatch(code="MK", name="North Macedonia", hits=8),
        CountryMatch(code="NO", name="Norway", hits=38_587),
        CountryMatch(code="SE", name="Sweden", hits=500),
    ]
    cities = [
        CityMatch(city="Paris", country_code="FR", country_name="France", hits=900),
        CityMatch(city="Paris", country_code="US", country_name="United States", hits=40),
        CityMatch(city="Malmö", country_code="SE", country_name="Sweden", hits=70),
        CityMatch(city="Nowhere", country_code=None, country_name=None, hits=1),
    ]
    hosts = [HostMatch(host="git.example.com", hits=300), HostMatch(host="example.com", hits=1_000)]
    servers = [ServerMatch(server="edge", hits=5_000), ServerMatch(server="nas", hits=20)]
    asns = [
        AsnMatch(asn=2119, organization="Telenor Norge AS", hits=23_890),
        AsnMatch(asn=198830, organization="Nordcom S.p.a.", hits=7),
        AsnMatch(asn=24940, organization="Hetzner Online GmbH", hits=60),
        AsnMatch(asn=24961, organization="WIIT AG", hits=3),
        AsnMatch(asn=64512, organization=None, hits=2),
    ]
    return FilterValueTotals(
        countries=_busiest_first([_Entry(fold(match.name), match.hits, match) for match in countries]),
        cities=_busiest_first([_Entry(fold(match.city), match.hits, match) for match in cities]),
        hosts=_busiest_first([_Entry(fold(match.host), match.hits, match) for match in hosts]),
        servers=_busiest_first([_Entry(fold(match.server), match.hits, match) for match in servers]),
        asns=_busiest_first([_Entry(fold(match.organization or ""), match.hits, match) for match in asns]),
    )


class TestMatch:
    def test_busiest_first_not_alphabetical(self) -> None:
        found = match_filter_values(_totals(), "nor", 4)
        assert [country.code for country in found.countries] == ["NO", "MK"]
        assert [asn.asn for asn in found.asns] == [2119, 198830]

    def test_matches_anywhere_in_the_name(self) -> None:
        found = match_filter_values(_totals(), "nor", 4)
        assert found.asns[0].organization == "Telenor Norge AS"

    def test_ignores_case_and_accents(self) -> None:
        assert [city.city for city in match_filter_values(_totals(), "MALMO", 4).cities] == ["Malmö"]

    def test_the_same_city_in_two_countries_is_two_matches(self) -> None:
        cities = match_filter_values(_totals(), "paris", 4).cities
        assert [(city.city, city.country_code) for city in cities] == [("Paris", "FR"), ("Paris", "US")]

    def test_country_matches_its_exact_code(self) -> None:
        assert [country.code for country in match_filter_values(_totals(), "se", 4).countries] == ["SE"]
        assert match_filter_values(_totals(), "s", 4).countries[0].code == "SE"

    def test_as_number_matches_from_the_first_digits(self) -> None:
        assert [asn.asn for asn in match_filter_values(_totals(), "2494", 4).asns] == [24940]
        assert [asn.asn for asn in match_filter_values(_totals(), "AS249", 4).asns] == [24940, 24961]
        assert match_filter_values(_totals(), "940", 4).asns == []

    def test_hosts_and_servers(self) -> None:
        found = match_filter_values(_totals(), "example", 4)
        assert [host.host for host in found.hosts] == ["example.com", "git.example.com"]
        assert [server.server for server in match_filter_values(_totals(), "edg", 4).servers] == ["edge"]

    def test_limit_applies_per_kind(self) -> None:
        found = match_filter_values(_totals(), "a", 1)
        assert len(found.cities) == 1 and len(found.asns) == 1 and len(found.servers) == 1

    def test_query_is_trimmed(self) -> None:
        assert match_filter_values(_totals(), "  norway ", 4).countries[0].code == "NO"


class TestCache:
    def test_reloads_behind_the_stale_totals(self) -> None:
        now = [0.0]
        cache = FilterValueTotalsCache(ttl_seconds=300, clock=lambda: now[0])
        loaded: list[FilterValueTotals] = []

        async def load() -> FilterValueTotals:
            loaded.append(_totals())
            return loaded[-1]

        async def run() -> None:
            first = await cache.get(load)
            now[0] = 299
            assert await cache.get(load) is first
            assert len(loaded) == 1
            now[0] = 301
            # Past the limit the search still gets the old totals at once.
            assert await cache.get(load) is first
            await cache.wait_for_reload()
            assert len(loaded) == 2
            assert await cache.get(load) is loaded[1]

        asyncio.run(run())

    def test_a_failed_reload_keeps_the_old_totals(self) -> None:
        now = [0.0]
        cache = FilterValueTotalsCache(ttl_seconds=300, clock=lambda: now[0])

        async def run() -> None:
            first = await cache.get(lambda: asyncio.sleep(0, _totals()))

            async def broken() -> FilterValueTotals:
                raise RuntimeError("database gone")

            now[0] = 400
            assert await cache.get(broken) is first
            await cache.wait_for_reload()
            assert await cache.get(broken) is first

        asyncio.run(run())

    def test_concurrent_searches_share_one_load(self) -> None:
        cache = FilterValueTotalsCache()
        loads = 0

        async def load() -> FilterValueTotals:
            nonlocal loads
            loads += 1
            await asyncio.sleep(0.01)
            return _totals()

        async def run() -> None:
            await asyncio.gather(*(cache.get(load) for _ in range(5)))

        asyncio.run(run())
        assert loads == 1
