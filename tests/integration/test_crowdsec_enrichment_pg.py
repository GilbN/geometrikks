"""SecurityEnrichmentRepository bulk geo/request-count lookups on real TimescaleDB."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from geometrikks.domain.security.repositories import SecurityEnrichmentRepository

NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)


async def seed_access_log(
    session,
    *,
    ip: str,
    age: timedelta,
    country_code: str | None = None,
    country_name: str | None = None,
    city: str | None = None,
) -> None:
    await session.execute(
        text(
            "INSERT INTO access_logs (timestamp, ip_address, method, url, status_code, "
            " bytes_sent, request_time, country_code, country_name, city) "
            "VALUES (:timestamp, :ip, 'GET', '/x', 200, 1000, 0.01, "
            " :country_code, :country_name, :city)"
        ),
        {
            "timestamp": NOW - age,
            "ip": ip,
            "country_code": country_code,
            "country_name": country_name,
            "city": city,
        },
    )


async def test_enrich_counts_and_latest_geo(pg_session_maker, clean_tables):
    async with pg_session_maker() as session:
        # 1.2.3.4: three requests in the last 24h, one older; latest geo wins
        await seed_access_log(
            session, ip="1.2.3.4", age=timedelta(hours=1),
            country_code="NO", country_name="Norway", city="Oslo",
        )
        await seed_access_log(
            session, ip="1.2.3.4", age=timedelta(hours=5),
            country_code="SE", country_name="Sweden", city="Stockholm",
        )
        await seed_access_log(session, ip="1.2.3.4", age=timedelta(hours=10))
        await seed_access_log(
            session, ip="1.2.3.4", age=timedelta(days=3),
            country_code="DK", country_name="Denmark", city="Copenhagen",
        )
        # 5.6.7.8: only old traffic; geo known, 24h count zero
        await seed_access_log(
            session, ip="5.6.7.8", age=timedelta(days=2),
            country_code="DE", country_name="Germany", city="Berlin",
        )
        await session.commit()

        repo = SecurityEnrichmentRepository(session=session)
        result = await repo.enrich(["1.2.3.4", "5.6.7.8", "9.9.9.9"])

    assert set(result) == {"1.2.3.4", "5.6.7.8"}

    first = result["1.2.3.4"]
    assert first.request_count_24h == 3
    assert first.country_code == "NO"
    assert first.country_name == "Norway"
    assert first.city == "Oslo"

    second = result["5.6.7.8"]
    assert second.request_count_24h == 0
    assert second.country_code == "DE"
    assert second.city == "Berlin"


async def test_enrich_skips_non_ip_values(pg_session_maker, clean_tables):
    async with pg_session_maker() as session:
        await seed_access_log(
            session, ip="1.2.3.4", age=timedelta(hours=1),
            country_code="NO", country_name="Norway", city="Oslo",
        )
        await session.commit()

        repo = SecurityEnrichmentRepository(session=session)
        # Range/Country/AS decision values must be skipped, not crash INET binds
        result = await repo.enrich(["10.0.0.0/24", "US", "AS12345", "1.2.3.4"])

    assert set(result) == {"1.2.3.4"}


async def test_enrich_handles_ipv6(pg_session_maker, clean_tables):
    async with pg_session_maker() as session:
        await seed_access_log(
            session, ip="2001:db8::1", age=timedelta(hours=2),
            country_code="NL", country_name="Netherlands", city="Amsterdam",
        )
        await session.commit()

        repo = SecurityEnrichmentRepository(session=session)
        result = await repo.enrich(["2001:db8::1"])

    assert result["2001:db8::1"].request_count_24h == 1
    assert result["2001:db8::1"].country_code == "NL"


async def seed_geo_event(session, *, ip: str, age: timedelta, lat: float, lon: float,
                         city: str, country_code: str) -> None:
    result = await session.execute(
        text(
            "INSERT INTO geo_locations (geohash, latitude, longitude, geographic_point, "
            " country_code, country_name, city, last_hit, created_at, updated_at) "
            "VALUES (:geohash, :lat, :lon, "
            " ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography, "
            " :country_code, :country_code, :city, now(), now(), now()) RETURNING id"
        ),
        # geohash is varchar(12); derive a short unique value per (ip, city)
        {"geohash": f"gh{abs(hash((ip, city))) % 10**10}", "lat": lat, "lon": lon,
         "city": city, "country_code": country_code},
    )
    await session.execute(
        text(
            "INSERT INTO geo_events (timestamp, ip_address, hostname, location_id) "
            "VALUES (:timestamp, :ip, 'it-test', :location_id)"
        ),
        {"timestamp": NOW - age, "ip": ip, "location_id": result.scalar_one()},
    )


async def test_locations_returns_latest_coordinates_per_ip(pg_session_maker, clean_tables):
    async with pg_session_maker() as session:
        await session.execute(text("DELETE FROM geo_locations"))
        await seed_geo_event(
            session, ip="1.2.3.4", age=timedelta(hours=2),
            lat=59.91, lon=10.79, city="Oslo", country_code="NO",
        )
        await seed_geo_event(
            session, ip="5.6.7.8", age=timedelta(days=2),
            lat=52.52, lon=13.40, city="Berlin", country_code="DE",
        )
        await session.commit()

        repo = SecurityEnrichmentRepository(session=session)
        result = await repo.locations(["1.2.3.4", "5.6.7.8", "9.9.9.9", "10.0.0.0/24"])

    by_ip = {loc.ip: loc for loc in result}
    assert set(by_ip) == {"1.2.3.4", "5.6.7.8"}
    assert by_ip["1.2.3.4"].latitude == 59.91
    assert by_ip["1.2.3.4"].longitude == 10.79
    assert by_ip["1.2.3.4"].city == "Oslo"
    assert by_ip["1.2.3.4"].country_code == "NO"
    assert by_ip["5.6.7.8"].city == "Berlin"


async def test_locations_respects_explicit_time_window(pg_session_maker, clean_tables):
    async with pg_session_maker() as session:
        await session.execute(text("DELETE FROM geo_locations"))
        await seed_geo_event(
            session, ip="1.2.3.4", age=timedelta(hours=2),
            lat=59.91, lon=10.79, city="Oslo", country_code="NO",
        )
        # before the window
        await seed_geo_event(
            session, ip="5.6.7.8", age=timedelta(days=2),
            lat=52.52, lon=13.40, city="Berlin", country_code="DE",
        )
        # after the window
        await seed_geo_event(
            session, ip="9.9.9.9", age=timedelta(minutes=10),
            lat=48.85, lon=2.35, city="Paris", country_code="FR",
        )
        await session.commit()

        repo = SecurityEnrichmentRepository(session=session)
        result = await repo.locations(
            ["1.2.3.4", "5.6.7.8", "9.9.9.9"],
            start=NOW - timedelta(hours=24),
            end=NOW - timedelta(hours=1),
        )

    assert [loc.ip for loc in result] == ["1.2.3.4"]


async def test_locations_over_24h_serve_from_hourly_cagg(pg_session_maker, clean_tables):
    """Windows over 24h route to ip_location_hourly_stats: presence is
    bucket-resolution, so an event in the window's head bucket counts even
    if it falls minutes before the exact start (same semantics as the map
    circles, and it avoids decompressing raw chunks)."""
    async with pg_session_maker() as session:
        await session.execute(text("DELETE FROM geo_locations"))
        # 10 minutes before the window start, but inside its head bucket
        await seed_geo_event(
            session, ip="1.2.3.4", age=timedelta(days=3, minutes=40),
            lat=59.91, lon=10.79, city="Oslo", country_code="NO",
        )
        # far outside the window
        await seed_geo_event(
            session, ip="5.6.7.8", age=timedelta(days=10),
            lat=52.52, lon=13.40, city="Berlin", country_code="DE",
        )
        await session.commit()

        repo = SecurityEnrichmentRepository(session=session)
        result = await repo.locations(
            ["1.2.3.4", "5.6.7.8"],
            start=NOW - timedelta(days=3, minutes=30),
            end=NOW,
        )

    by_ip = {loc.ip: loc for loc in result}
    assert set(by_ip) == {"1.2.3.4"}
    assert by_ip["1.2.3.4"].city == "Oslo"


async def test_locations_over_30d_serve_from_daily_cagg(pg_session_maker, clean_tables):
    async with pg_session_maker() as session:
        await session.execute(text("DELETE FROM geo_locations"))
        await seed_geo_event(
            session, ip="1.2.3.4", age=timedelta(days=35),
            lat=59.91, lon=10.79, city="Oslo", country_code="NO",
        )
        # newer event elsewhere: latest location must win
        await seed_geo_event(
            session, ip="1.2.3.4", age=timedelta(days=5),
            lat=48.85, lon=2.35, city="Paris", country_code="FR",
        )
        await session.commit()

        repo = SecurityEnrichmentRepository(session=session)
        result = await repo.locations(
            ["1.2.3.4"],
            start=NOW - timedelta(days=40),
            end=NOW,
        )

    (loc,) = result
    assert loc.city == "Paris"
