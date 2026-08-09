"""A concurrently created geo_locations row must not blow up the batch."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from geohash2 import encode

from geometrikks.domain.geo.models import GeoLocation
from geometrikks.domain.geo.utils import make_point
from geometrikks.services.ingestion.service import IngestionRepos, LogIngestionService
from geometrikks.services.logparser.schemas import ParsedGeoData

pytestmark = [pytest.mark.anyio, pytest.mark.integration]


async def test_get_or_create_location_survives_existing_geohash(pg_session_maker, clean_tables) -> None:
    lat, lon = 51.5074, -0.1278
    geohash = encode(lat, lon)

    async with pg_session_maker() as db_session:
        # Simulate the other writer having won the race already.
        existing = GeoLocation(
            geohash=geohash, latitude=lat, longitude=lon,
            country_code="GB", country_name="United Kingdom",
            geographic_point=make_point(lat, lon),
        )
        db_session.add(existing)
        await db_session.flush()

        service = LogIngestionService(
            parsers=[], session_maker=None, geoip_path="unused", hostname="test",
        )
        repos = IngestionRepos.from_session(db_session)
        geo = ParsedGeoData(
            latitude=lat, longitude=lon, geohash=geohash,
            country_code="GB", country_name="United Kingdom",
            timestamp=datetime.now(timezone.utc),
        )
        location_id = await service._get_or_create_location(geo, repos)
        assert location_id == existing.id
        await db_session.rollback()


async def test_insert_conflict_resolves_to_existing_id(pg_session_maker, clean_tables, monkeypatch) -> None:
    # Force the insert path even though the row exists: emulate the race
    # window where get_by_geohash saw nothing but the insert conflicts.
    lat, lon = 51.5074, -0.1278
    geohash = encode(lat, lon)

    async with pg_session_maker() as db_session:
        existing = GeoLocation(
            geohash=geohash, latitude=lat, longitude=lon,
            country_code="GB", country_name="United Kingdom",
            geographic_point=make_point(lat, lon),
        )
        db_session.add(existing)
        await db_session.flush()

        service = LogIngestionService(
            parsers=[], session_maker=None, geoip_path="unused", hostname="test",
        )
        repos = IngestionRepos.from_session(db_session)
        geo = ParsedGeoData(
            latitude=lat, longitude=lon, geohash=geohash,
            country_code="GB", country_name="United Kingdom",
            timestamp=datetime.now(timezone.utc),
        )

        # Only the pre-check's first call is faked as a miss; the fallback
        # re-select after the conflicting insert must see the real row.
        calls = {"n": 0}
        real = type(repos.geo_location).get_by_geohash

        async def first_none(self_repo, geohash):
            calls["n"] += 1
            if calls["n"] == 1:
                return None
            return await real(self_repo, geohash)

        monkeypatch.setattr(type(repos.geo_location), "get_by_geohash", first_none, raising=True)

        location_id = await service._get_or_create_location(geo, repos)
        assert location_id == existing.id
        await db_session.rollback()
