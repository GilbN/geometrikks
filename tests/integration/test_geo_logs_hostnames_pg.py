"""Hostname sets survive CAGG rollups, exact boundaries and column upgrades."""
from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import text

from geometrikks.config.settings import get_settings
from geometrikks.domain.geo.schemas import GeoEventFilters
from geometrikks.domain.geo.services import GeoEventService
from geometrikks.server import timescale
from tests.integration.test_geo_logs_pg import NOW, _insert_events, _seed_locations
from tests.integration.test_ip_location_asn_columns_pg import _drop_view

pytestmark = pytest.mark.anyio


@pytest.fixture(autouse=True)
async def clear_backfill_history(pg_engine, clean_tables):
    """Startup repair can populate other geo CAGGs while testing an upgrade.

    Remove this module's older buckets too, so later global facet/count tests
    do not inherit history outside their short refresh windows.
    """
    refresh = timescale.refresh_caggs_range
    yield
    async with pg_engine.begin() as conn:
        await conn.execute(text("DELETE FROM geo_events"))
    assert not await refresh(
        pg_engine,
        start=(NOW - timedelta(days=get_settings().analytics.raw_retention_days + 40)).replace(hour=0),
        end=(NOW + timedelta(days=1)).replace(hour=0),
        caggs=[view for view, source in timescale.CAGG_SOURCE_TABLES.items() if source == "geo_events"],
        force=True,
    )


@pytest.mark.parametrize("days", [3, 40])
async def test_hostname_sets_match_raw_with_partial_buckets(
    pg_engine, pg_session_maker, clean_tables, days,
):
    start = NOW - timedelta(days=days, minutes=25)
    end = NOW - timedelta(minutes=10)
    async with pg_session_maker() as session:
        locs = await _seed_locations(session)
        # Repeated names, unequal array lengths, raw-only edge names, and
        # excluded events in the same boundary buckets as included ones.
        for ts, hostname, n in [
            (start - timedelta(seconds=1), "outside-start", 7),
            (start, "head", 2),
            (start + timedelta(days=1), "web1", 3),
            (start + timedelta(days=1), "web2", 2),
            (start + timedelta(days=2), "web1", 1),
            (end - timedelta(seconds=1), "tail", 1),
            (end, "outside-end", 8),
        ]:
            await _insert_events(session, ts=ts, ip="2001:db8::1", hostname=hostname,
                                 location_id=locs["no"], n=n)
        # The same IP in another location, and another IP in the same
        # location, must not leak names into the requested group.
        await _insert_events(session, ts=start + timedelta(days=1), ip="2001:db8::1",
                             hostname="sweden", location_id=locs["se"])
        await _insert_events(session, ts=start + timedelta(days=1), ip="1.1.1.1",
                             hostname="other-ip", location_id=locs["no"])
        await session.commit()

    assert not await timescale.refresh_caggs_range(
        pg_engine, start=start - timedelta(days=1), end=NOW + timedelta(days=1),
        caggs=timescale.IP_LOCATION_CAGGS_NAMES,
    )
    async with pg_session_maker() as session:
        service = GeoEventService(session=session)
        rows, total = await service.get_grouped_logs(start, end, GeoEventFilters(), limit=1, offset=0)
        assert total == 3
        assert [(r.location_id, r.ip_address, r.event_count, r.hostnames) for r in rows] == [
            (locs["no"], "2001:db8::1", 9, ["head", "tail", "web1", "web2"]),
        ]
        following, following_total = await service.get_grouped_logs(
            start, end, GeoEventFilters(), limit=2, offset=1,
        )
        assert following_total == total
        assert [r.hostnames for r in following] == [["other-ip"], ["sweden"]]
        empty, empty_total = await service.get_grouped_logs(
            start, end, GeoEventFilters(), limit=2, offset=3,
        )
        assert empty == []
        assert empty_total == total
        filtered, filtered_total = await service.get_grouped_logs(
            start, end, GeoEventFilters(hostnames=["web1"]), limit=10, offset=0,
        )
        assert filtered_total == 1
        assert [(r.event_count, r.hostnames) for r in filtered] == [(4, ["web1"])]


async def _old_view(conn, view, interval):
    await _drop_view(conn, view)
    await conn.execute(text(f"""
        CREATE MATERIALIZED VIEW {view} WITH (timescaledb.continuous) AS
        SELECT time_bucket('{interval}', timestamp) AS bucket, location_id, ip_address,
               COUNT(*) AS event_count, MAX(autonomous_system_number) AS asn,
               MAX(autonomous_system_organization) AS as_org,
               COUNT(autonomous_system_number) AS asn_hits
        FROM geo_events GROUP BY bucket, location_id, ip_address WITH NO DATA
    """))


@pytest.mark.parametrize("suffix, interval", [("hourly", "1 hour"), ("daily", "1 day")])
async def test_hostname_upgrade_resumes_after_interrupted_refresh(
    pg_engine, pg_session_maker, clean_tables, suffix, interval, monkeypatch,
):
    view = f"ip_location_{suffix}_stats"
    retention = get_settings().analytics.raw_retention_days
    async with pg_session_maker() as session:
        locs = await _seed_locations(session)
        for name, n in [("web1", 3), ("web2", 2)]:
            await _insert_events(session, ts=NOW - timedelta(days=8), ip="1.1.1.1",
                                 hostname=name, location_id=locs["no"], n=n)
        await session.commit()
    async with pg_engine.begin() as conn:
        await _old_view(conn, view, interval)
    assert not await timescale.refresh_caggs_range(
        pg_engine, start=NOW - timedelta(days=9), end=NOW, caggs=[view],
    )
    async with pg_engine.begin() as conn:
        # Schema evolution must also work when old materialized chunks
        # have already been compressed.
        await conn.execute(text(f"ALTER MATERIALIZED VIEW {view} SET (timescaledb.compress = true)"))
        await conn.execute(text("""
            SELECT compress_chunk(c, if_not_compressed => true)
            FROM timescaledb_information.continuous_aggregates a,
                 LATERAL show_chunks(format('%I.%I', a.materialization_hypertable_schema,
                                             a.materialization_hypertable_name)::regclass) c
            WHERE a.view_name = :view
        """), {"view": view})
        before = (await conn.execute(text(f"SELECT '{view}'::regclass::oid"))).scalar_one()
        assert view in await timescale._cagg_columns_need_upgrade(conn, raw_retention_days=retention)
        assert await timescale._add_cagg_columns(conn, [view]) == []
        # Simulate a restart after adding columns but before the refresh.
        assert view in await timescale._cagg_columns_need_upgrade(conn, raw_retention_days=retention)
    await timescale.setup_timescaledb(pg_engine, get_settings().analytics)
    async with pg_engine.connect() as conn:
        assert view in await timescale._cagg_columns_need_upgrade(conn, raw_retention_days=retention)
        assert view not in await timescale._cagg_columns_need_upgrade(
            conn, raw_retention_days=retention, include_manual=False,
        )
    await _run_cli(pg_engine, monkeypatch)

    async with pg_engine.connect() as conn:
        after = (await conn.execute(text(f"SELECT '{view}'::regclass::oid"))).scalar_one()
        assert after == before, "the aggregate must not be dropped"
        rows = (await conn.execute(text(
            f"SELECT event_count, hostnames, hostname_hits FROM {view} WHERE location_id = :loc"
        ), {"loc": locs["no"]})).all()
        assert [(r.event_count, sorted(r.hostnames), r.hostname_hits) for r in rows] == [
            (5, ["web1", "web2"], 5),
        ]
        assert view not in await timescale._cagg_columns_need_upgrade(conn, raw_retention_days=retention)
    async with pg_engine.begin() as conn:
        await _drop_view(conn, view)
    await timescale.setup_timescaledb(pg_engine, get_settings().analytics)


async def test_hostname_upgrade_preserves_counts_beyond_raw_retention(
    pg_engine, pg_session_maker, clean_tables, monkeypatch,
):
    view = "ip_location_daily_stats"
    retention = get_settings().analytics.raw_retention_days
    old = NOW - timedelta(days=retention + 30)
    async with pg_session_maker() as session:
        locs = await _seed_locations(session)
        for ts, name in [(old, "expired"), (NOW - timedelta(days=2), "recent")]:
            await _insert_events(session, ts=ts, ip="1.1.1.1", hostname=name,
                                 location_id=locs["no"], n=2)
        await session.commit()
    async with pg_engine.begin() as conn:
        await _old_view(conn, view, "1 day")
    assert not await timescale.refresh_caggs_range(
        pg_engine, start=old - timedelta(days=1), end=NOW, caggs=[view],
    )
    async with pg_engine.begin() as conn:
        await conn.execute(text(
            "SELECT drop_chunks('geo_events', older_than => make_interval(days => :days))"
        ), {"days": retention + 10})
    await timescale.setup_timescaledb(pg_engine, get_settings().analytics)
    await _run_cli(pg_engine, monkeypatch)
    async with pg_engine.connect() as conn:
        rows = (await conn.execute(text(
            f"SELECT event_count, hostnames, hostname_hits FROM {view} "
            "WHERE location_id = :loc ORDER BY bucket"
        ), {"loc": locs["no"]})).all()
        assert [(r.event_count, r.hostnames, r.hostname_hits) for r in rows] == [
            (2, None, None), (2, ["recent"], 2),
        ]
        assert view not in await timescale._cagg_columns_need_upgrade(conn, raw_retention_days=retention)
    async with pg_session_maker() as session:
        rows, total = await GeoEventService(session=session).get_grouped_logs(
            old - timedelta(days=1), NOW, GeoEventFilters(), limit=10, offset=0,
        )
        assert total == 1
        assert [(r.event_count, r.hostnames) for r in rows] == [(4, ["recent"])]
        old_rows, _ = await GeoEventService(session=session).get_grouped_logs(
            old - timedelta(days=40), old + timedelta(days=1), GeoEventFilters(), limit=10, offset=0,
        )
        assert [(r.event_count, r.hostnames) for r in old_rows] == [(2, [])]
    async with pg_engine.begin() as conn:
        await _drop_view(conn, view)
    await timescale.setup_timescaledb(pg_engine, get_settings().analytics)


async def test_hostname_lookup_keeps_asn_filters(pg_engine, pg_session_maker, clean_tables):
    async with pg_session_maker() as session:
        locs = await _seed_locations(session)
        for day, name, asn in [(3, "included", 1221), (2, "excluded", 13335)]:
            await session.execute(text("""
                INSERT INTO geo_events (timestamp, ip_address, hostname, location_id,
                                        autonomous_system_number)
                VALUES (:ts, '1.1.1.1', :name, :loc, :asn)
            """), {"ts": NOW - timedelta(days=day), "name": name, "loc": locs["no"], "asn": asn})
        await session.commit()
    assert not await timescale.refresh_caggs_range(
        pg_engine, start=NOW - timedelta(days=4), end=NOW,
        caggs=timescale.IP_LOCATION_CAGGS_NAMES,
    )
    async with pg_session_maker() as session:
        rows, total = await GeoEventService(session=session).get_grouped_logs(
            NOW - timedelta(days=4), NOW, GeoEventFilters(asn_include=[1221]), limit=10, offset=0,
        )
        assert total == 1
        assert [(r.event_count, r.hostnames) for r in rows] == [(1, ["included"])]


async def _run_cli(engine, monkeypatch):
    from geometrikks.cli import _run_backfill_geo_hostnames
    from geometrikks.server import plugins

    monkeypatch.setattr(plugins, "get_sqlalchemy_config", lambda: SimpleNamespace(get_engine=lambda: engine))
    await _run_backfill_geo_hostnames(yes=True)


async def test_cli_failure_resumes_and_completed_run_is_noop(
    pg_engine, pg_session_maker, clean_tables, monkeypatch,
):
    import click
    from geometrikks.server.hostname_backfill import hostname_backfill_ranges

    view = "ip_location_daily_stats"
    async with pg_session_maker() as session:
        locs = await _seed_locations(session)
        for day in (12, 10, 8):
            await _insert_events(session, ts=NOW - timedelta(days=day), ip="1.1.1.1",
                                 hostname=f"web-{day}", location_id=locs["no"])
        await session.commit()
    async with pg_engine.begin() as conn:
        await _old_view(conn, view, "1 day")
    assert not await timescale.refresh_caggs_range(
        pg_engine, start=NOW - timedelta(days=14), end=NOW, caggs=[view],
    )
    await timescale.setup_timescaledb(pg_engine, get_settings().analytics)
    real_refresh = timescale.refresh_caggs_range
    calls = []

    async def fail_second(engine, **kwargs):
        calls.append(kwargs)
        if len(calls) == 2:
            return [view]
        return await real_refresh(engine, **kwargs)

    monkeypatch.setattr(timescale, "refresh_caggs_range", fail_second)
    with pytest.raises(click.ClickException, match="Rerun"):
        await _run_cli(pg_engine, monkeypatch)
    first_start = calls[0]["start"]
    assert calls[0]["force"] is True
    assert calls[0]["end"] - first_start <= timedelta(days=1)
    await _run_cli(pg_engine, monkeypatch)
    assert sum(call["start"] == first_start for call in calls) == 1
    count = len(calls)
    await _run_cli(pg_engine, monkeypatch)
    assert len(calls) == count
    async with pg_engine.connect() as conn:
        assert await hostname_backfill_ranges(
            conn, now=NOW, raw_retention_days=180, hourly_retention_days=60,
        ) == []
    async with pg_engine.begin() as conn:
        await _drop_view(conn, view)
    await timescale.setup_timescaledb(pg_engine, get_settings().analytics)


async def test_cli_decline_and_concurrent_run_do_not_refresh(
    pg_engine, pg_session_maker, clean_tables, monkeypatch,
):
    import click
    from unittest.mock import AsyncMock
    from geometrikks.cli import _run_backfill_geo_hostnames
    from geometrikks.server import plugins

    view = "ip_location_daily_stats"
    async with pg_session_maker() as session:
        locs = await _seed_locations(session)
        await _insert_events(session, ts=NOW - timedelta(days=8), ip="1.1.1.1",
                             hostname="web", location_id=locs["no"])
        await session.commit()
    async with pg_engine.begin() as conn:
        await _old_view(conn, view, "1 day")
    assert not await timescale.refresh_caggs_range(
        pg_engine, start=NOW - timedelta(days=10), end=NOW, caggs=[view],
    )
    await timescale.setup_timescaledb(pg_engine, get_settings().analytics)
    monkeypatch.setattr(plugins, "get_sqlalchemy_config", lambda: SimpleNamespace(get_engine=lambda: pg_engine))
    monkeypatch.setattr(click, "confirm", lambda *args: False)
    refresh = AsyncMock()
    with monkeypatch.context() as patch:
        patch.setattr(timescale, "refresh_caggs_range", refresh)
        await _run_backfill_geo_hostnames(yes=False)
        async with pg_engine.connect() as conn:
            await conn.execute(text("SELECT pg_advisory_lock(714023, 1)"))
            try:
                with pytest.raises(click.ClickException, match="already running"):
                    await _run_backfill_geo_hostnames(yes=True)
            finally:
                await conn.execute(text("SELECT pg_advisory_unlock(714023, 1)"))
        refresh.assert_not_awaited()
    async with pg_engine.begin() as conn:
        await _drop_view(conn, view)
    await timescale.setup_timescaledb(pg_engine, get_settings().analytics)
