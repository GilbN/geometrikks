"""/geo-locations/country-stats: counts per country across routing paths."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from geometrikks.domain.geo.repositories import GeoLocationRepository
from geometrikks.server import timescale

pytestmark = pytest.mark.anyio

NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)


async def _insert_location(
    session, *, geohash: str, latitude: float, longitude: float,
    country_code: str, country_name: str, city: str | None,
    state: str | None = None, state_code: str | None = None,
    postal_code: str | None = None, tz: str | None = None,
) -> int:
    result = await session.execute(
        text(
            "INSERT INTO geo_locations "
            "(geohash, latitude, longitude, geographic_point, country_code, "
            " country_name, state, state_code, city, postal_code, timezone, "
            " last_hit, created_at, updated_at) "
            "VALUES (:geohash, :latitude, :longitude, "
            " ST_SetSRID(ST_MakePoint(:longitude, :latitude), 4326)::geography, "
            " :country_code, :country_name, :state, :state_code, :city, "
            " :postal_code, :tz, now(), now(), now()) "
            "RETURNING id"
        ),
        {
            "geohash": geohash, "latitude": latitude, "longitude": longitude,
            "country_code": country_code, "country_name": country_name,
            "state": state, "state_code": state_code, "city": city,
            "postal_code": postal_code, "tz": tz,
        },
    )
    return result.scalar_one()


async def _insert_events(session, *, ts, ip: str, hostname: str, location_id: int, n: int = 1) -> None:
    for _ in range(n):
        await session.execute(
            text(
                "INSERT INTO geo_events (timestamp, ip_address, hostname, location_id) "
                "VALUES (:ts, :ip, :hostname, :location_id)"
            ),
            {"ts": ts, "ip": ip, "hostname": hostname, "location_id": location_id},
        )


async def _seed(session) -> None:
    oslo = await _insert_location(
        session, geohash="chor1", latitude=59.91, longitude=10.75,
        country_code="NO", country_name="Norway", city="Oslo",
    )
    umea = await _insert_location(
        session, geohash="chor2", latitude=63.83, longitude=20.26,
        country_code="SE", country_name="Sweden", city="Umea",
    )
    # Recent (RAW range) and older (hourly range) events, two hostnames.
    await _insert_events(session, ts=NOW - timedelta(hours=1), ip="203.0.113.1",
                         hostname="web-01", location_id=oslo, n=5)
    await _insert_events(session, ts=NOW - timedelta(hours=1), ip="203.0.113.2",
                         hostname="web-02", location_id=umea, n=3)
    await _insert_events(session, ts=NOW - timedelta(days=2), ip="203.0.113.1",
                         hostname="web-01", location_id=oslo, n=7)
    await session.commit()


async def test_raw_range_counts(pg_session_maker, clean_tables):
    async with pg_session_maker() as session:
        await _seed(session)
        repo = GeoLocationRepository(session=session)
        rows = await repo.get_country_stats(NOW - timedelta(hours=23), NOW + timedelta(hours=1))
    assert dict((c, n) for c, _name, n in rows) == {"NO": 5, "SE": 3}


async def test_hourly_range_includes_older_events(pg_session_maker, clean_tables):
    """> 24h routes to location_hourly_stats; real-time aggregation folds in
    rows the policy has not materialized yet, so no manual refresh is needed."""
    async with pg_session_maker() as session:
        await _seed(session)
        repo = GeoLocationRepository(session=session)
        rows = await repo.get_country_stats(NOW - timedelta(days=3), NOW + timedelta(hours=1))
    assert dict((c, n) for c, _name, n in rows) == {"NO": 12, "SE": 3}


async def test_hostname_filter_on_both_paths(pg_session_maker, clean_tables, monkeypatch):
    async with pg_session_maker() as session:
        await _seed(session)
        repo = GeoLocationRepository(session=session)
        span = (NOW - timedelta(days=3), NOW + timedelta(hours=1))

        rows = await repo.get_country_stats(*span, hostnames=["web-01"])
        assert dict((c, n) for c, _name, n in rows) == {"NO": 12}

        # Pre-hostname-CAGG installs force RAW; same answer either way.
        monkeypatch.setattr(timescale, "location_caggs_have_hostname", lambda: False)
        rows = await repo.get_country_stats(*span, hostnames=["web-01"])
        assert dict((c, n) for c, _name, n in rows) == {"NO": 12}


async def test_country_filter(pg_session_maker, clean_tables):
    async with pg_session_maker() as session:
        await _seed(session)
        repo = GeoLocationRepository(session=session)
        span = (NOW - timedelta(hours=23), NOW + timedelta(hours=1))
        rows = await repo.get_country_stats(*span, country_codes=["SE"])
        assert dict((c, n) for c, _name, n in rows) == {"SE": 3}

        # country_code is stored uppercase; a lowercase filter must match the same rows.
        lower_rows = await repo.get_country_stats(*span, country_codes=["se"])
        assert dict((c, n) for c, _name, n in lower_rows) == {"SE": 3}
