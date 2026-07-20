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
