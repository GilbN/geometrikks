"""Search the access log filter values by name, busiest first.

The search reads request totals for every country, city, host, server and
ASN from the daily aggregates. Adding those up costs too much to repeat per
keystroke, so each worker keeps the totals for a few minutes and matches in
memory. Countries and cities come from the per-location rollup, which has a
row per place and day, instead of the per-IP one with a row per address and
day.
"""
from __future__ import annotations

import asyncio
import re
import time
import unicodedata
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from sqlalchemy import text

from geometrikks.domain.logs.schemas import (
    AsnMatch,
    CityMatch,
    CountryMatch,
    FilterValueMatches,
    HostMatch,
    ServerMatch,
)
from geometrikks.server.logging import get_logger

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable, Sequence

    from sqlalchemy.ext.asyncio import AsyncSession

logger = get_logger(__name__)

TOTALS_TTL_SECONDS = 5 * 60
_AS_NUMBER = re.compile(r"(?:as)?(\d+)")


def fold(value: str) -> str:
    """Lower case without accents, so "malmo" finds Malmö."""
    decomposed = unicodedata.normalize("NFKD", value)
    return "".join(char for char in decomposed if not unicodedata.combining(char)).casefold()


@dataclass(frozen=True, slots=True)
class _Entry[T]:
    key: str
    hits: int
    match: T


@dataclass(frozen=True, slots=True)
class FilterValueTotals:
    """Every filter value with its request total, busiest first."""

    countries: list[_Entry[CountryMatch]]
    cities: list[_Entry[CityMatch]]
    hosts: list[_Entry[HostMatch]]
    servers: list[_Entry[ServerMatch]]
    asns: list[_Entry[AsnMatch]]


def _busiest_first[T](entries: list[_Entry[T]]) -> list[_Entry[T]]:
    return sorted(entries, key=lambda entry: (-entry.hits, entry.key))


async def load_filter_value_totals(session: AsyncSession) -> FilterValueTotals:
    """Read the totals from the daily aggregates, which keep values past the raw retention."""
    started = time.monotonic()
    place_rows = (
        await session.execute(text(
            "SELECT l.country_code, MAX(l.country_name) AS country_name, l.city, SUM(t.hits) AS hits "
            "FROM (SELECT location_id, SUM(event_count) AS hits FROM location_daily_stats "
            "      GROUP BY location_id) t "
            "JOIN geo_locations l ON l.id = t.location_id "
            "GROUP BY l.country_code, l.city"
        ))
    ).all()
    host_rows = (
        await session.execute(text("SELECT host, SUM(hits) AS hits FROM host_daily_stats GROUP BY host"))
    ).all()
    server_rows = (
        await session.execute(text(
            "SELECT server, SUM(hits) AS hits FROM log_source_daily_stats "
            "WHERE server IS NOT NULL GROUP BY server"
        ))
    ).all()
    asn_rows = (
        await session.execute(text(
            "SELECT asn, MAX(as_org) AS organization, SUM(hits) AS hits FROM asn_daily_stats GROUP BY asn"
        ))
    ).all()
    # Tens of thousands of names to fold and sort would hold up every other request on this worker.
    totals = await asyncio.to_thread(_build_totals, place_rows, host_rows, server_rows, asn_rows)
    logger.debug(
        "filter_value_totals_loaded",
        countries=len(totals.countries),
        cities=len(totals.cities),
        hosts=len(totals.hosts),
        servers=len(totals.servers),
        asns=len(totals.asns),
        duration_ms=round((time.monotonic() - started) * 1000),
    )
    return totals


def _build_totals(
    place_rows: Sequence[Any],
    host_rows: Sequence[Any],
    server_rows: Sequence[Any],
    asn_rows: Sequence[Any],
) -> FilterValueTotals:
    folded: dict[str, str] = {}

    def key(name: str) -> str:
        if (found := folded.get(name)) is None:
            found = folded[name] = fold(name)
        return found

    country_hits: dict[str, int] = {}
    country_names: dict[str, str] = {}
    cities: list[_Entry[CityMatch]] = []
    for row in place_rows:
        hits = int(row.hits)
        country_hits[row.country_code] = country_hits.get(row.country_code, 0) + hits
        if row.country_name:
            country_names[row.country_code] = row.country_name
        if row.city:
            cities.append(_Entry(
                key(row.city),
                hits,
                CityMatch(city=row.city, country_code=row.country_code, country_name=row.country_name, hits=hits),
            ))
    countries = [
        _Entry(key(name), hits, CountryMatch(code=code, name=name, hits=hits))
        for code, hits in country_hits.items()
        for name in [country_names.get(code, code)]
    ]
    return FilterValueTotals(
        countries=_busiest_first(countries),
        cities=_busiest_first(cities),
        hosts=_busiest_first([
            _Entry(key(row.host), int(row.hits), HostMatch(host=row.host, hits=int(row.hits)))
            for row in host_rows
        ]),
        servers=_busiest_first([
            _Entry(key(row.server), int(row.hits), ServerMatch(server=row.server, hits=int(row.hits)))
            for row in server_rows
        ]),
        asns=_busiest_first([
            _Entry(
                key(row.organization or ""),
                int(row.hits),
                AsnMatch(asn=int(row.asn), organization=row.organization, hits=int(row.hits)),
            )
            for row in asn_rows
        ]),
    )


def match_filter_values(totals: FilterValueTotals, query: str, limit: int) -> FilterValueMatches:
    """The busiest values of each kind whose name holds the query.

    A country also matches its exact two-letter code, and a network its
    number: "2494" and "AS2494" find AS24940 and every other number that
    starts with those digits.
    """
    needle = fold(query.strip())

    def first[T](entries: list[_Entry[T]], hit: Callable[[_Entry[T]], bool]) -> list[T]:
        found: list[T] = []
        for entry in entries:
            if hit(entry):
                found.append(entry.match)
                if len(found) == limit:
                    break
        return found

    number = _AS_NUMBER.fullmatch(needle)
    digits = number.group(1) if number else None
    return FilterValueMatches(
        countries=first(totals.countries, lambda entry: needle in entry.key or fold(entry.match.code) == needle),
        cities=first(totals.cities, lambda entry: needle in entry.key),
        hosts=first(totals.hosts, lambda entry: needle in entry.key),
        servers=first(totals.servers, lambda entry: needle in entry.key),
        asns=first(
            totals.asns,
            (lambda entry: str(entry.match.asn).startswith(digits))
            if digits is not None
            else (lambda entry: needle in entry.key),
        ),
    )


class FilterValueTotalsCache:
    """Keeps the totals for a few minutes.

    Only the first search waits for a load. After that, a search past the
    time limit gets the totals it has and starts one reload behind it.
    """

    def __init__(self, ttl_seconds: float = TOTALS_TTL_SECONDS, clock: Callable[[], float] = time.monotonic) -> None:
        self._ttl = ttl_seconds
        self._clock = clock
        self._lock = asyncio.Lock()
        self._totals: FilterValueTotals | None = None
        self._loaded_at = 0.0
        self._reload: asyncio.Task[None] | None = None

    async def get(self, load: Callable[[], Awaitable[FilterValueTotals]]) -> FilterValueTotals:
        if self._totals is None:
            async with self._lock:
                if self._totals is None:
                    self._totals = await load()
                    self._loaded_at = self._clock()
            return self._totals
        if self._clock() - self._loaded_at >= self._ttl and (self._reload is None or self._reload.done()):
            self._reload = asyncio.create_task(self._reload_in_background(load))
        return self._totals

    async def _reload_in_background(self, load: Callable[[], Awaitable[FilterValueTotals]]) -> None:
        try:
            totals = await load()
        except Exception:
            # The old totals keep serving, and the next search past the limit tries again.
            logger.exception("filter_value_totals_reload_failed")
            return
        self._totals = totals
        self._loaded_at = self._clock()

    async def wait_for_reload(self) -> None:
        if self._reload is not None:
            await self._reload

    def clear(self) -> None:
        self._totals = None


filter_value_totals = FilterValueTotalsCache()
