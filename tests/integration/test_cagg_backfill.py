"""CAGG history that predates refresh coverage must be backfilled.

Reproduces the issue #14 symptom: after a narrow refresh advances the
watermark, raw rows older than the materialized range vanish from CAGG
queries (charts) while raw-table queries (top lists) still see them.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from geometrikks.domain.analytics.repositories import SummaryStatsRepository

NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
OLD = NOW - timedelta(days=10)
# Inside the simulated policy refresh window: without a row here, the
# refresh has nothing to materialize and never advances the CAGG watermark,
# so the "bug reproduced" precondition below would not actually hold.
# Two days, not one: only fully covered buckets are refreshed, and in the
# first hour of the UTC day the window end (NOW - 1h) lands at 23:00 the
# previous day, cutting off the 1-day-ago daily bucket. The 2-days-ago
# bucket fits the [NOW-3d, NOW-1h] window at any hour.
RECENT = NOW - timedelta(days=2)


async def _refresh(engine, cagg: str, start, end) -> None:
    # CALL cannot run inside a transaction: use the raw asyncpg connection
    async with engine.connect() as conn:
        raw = await conn.get_raw_connection()
        await raw.driver_connection.execute(
            f"CALL refresh_continuous_aggregate('{cagg}', $1::timestamptz, $2::timestamptz)",
            start,
            end,
        )


async def test_backfill_recovers_history(pg_engine, pg_session_maker, clean_tables):
    from geometrikks.server.timescale import backfill_cagg_gaps

    async with pg_session_maker() as session:
        await session.execute(text(
            "INSERT INTO access_logs (timestamp, ip_address, status_code, bytes_sent, request_time) "
            "VALUES (:ts, '10.0.0.1', 200, 100, 0.01)"
        ), {"ts": OLD})
        await session.execute(text(
            "INSERT INTO access_logs (timestamp, ip_address, status_code, bytes_sent, request_time) "
            "VALUES (:ts, '10.0.0.2', 200, 100, 0.01)"
        ), {"ts": RECENT})
        await session.commit()

    # Simulate the broken state: a policy-style refresh of only the trailing
    # window advances the watermark past the old row without materializing it.
    await _refresh(pg_engine, "summary_daily_stats",
                   NOW - timedelta(days=3), NOW - timedelta(hours=1))

    async with pg_session_maker() as session:
        rows = await SummaryStatsRepository(session=session).get_time_series(
            NOW - timedelta(days=90), NOW
        )
    assert all(r.bucket.date() != OLD.date() for r in rows), "precondition: bug reproduced"

    await backfill_cagg_gaps(pg_engine, raw_retention_days=180, hourly_retention_days=60)

    async with pg_session_maker() as session:
        rows = await SummaryStatsRepository(session=session).get_time_series(
            NOW - timedelta(days=90), NOW
        )
    assert any(r.bucket.date() == OLD.date() for r in rows)


async def test_one_bad_probe_does_not_cascade(pg_engine, pg_session_maker, clean_tables, monkeypatch):
    """A probe failure for one CAGG must not skip the others.

    Each CAGG is probed on its own connection: a failed statement poisons
    only that connection's transaction, so a bad first entry must not
    cascade to later ones (regression guard for the shared-connection bug).
    """
    import geometrikks.server.timescale as ts

    async with pg_session_maker() as session:
        for ts_val, ip in ((OLD, "10.0.0.1"), (RECENT, "10.0.0.2")):
            await session.execute(text(
                "INSERT INTO access_logs (timestamp, ip_address, status_code, bytes_sent, request_time) "
                "VALUES (:ts, :ip, 200, 100, 0.01)"
            ), {"ts": ts_val, "ip": ip})
        await session.commit()

    await _refresh(pg_engine, "summary_daily_stats",
                   NOW - timedelta(days=3), NOW - timedelta(hours=1))

    # Poison the FIRST probed CAGG by pointing it at a nonexistent table.
    # A shared-connection implementation would abort the transaction and
    # skip summary_daily_stats too, leaving the gap unfilled.
    bad = {"broken_cagg": "table_that_does_not_exist", **ts.CAGG_SOURCE_TABLES}
    monkeypatch.setattr(ts, "CAGG_SOURCE_TABLES", bad)

    await ts.backfill_cagg_gaps(pg_engine, raw_retention_days=180, hourly_retention_days=60)

    async with pg_session_maker() as session:
        rows = await SummaryStatsRepository(session=session).get_time_series(
            NOW - timedelta(days=90), NOW
        )
    assert any(r.bucket.date() == OLD.date() for r in rows), (
        "later CAGG was skipped: one bad probe cascaded across the shared connection"
    )


async def test_hourly_probe_clamped_to_hourly_retention(pg_engine, pg_session_maker, clean_tables):
    """Hourly CAGGs keep only hourly_retention_days of buckets: raw rows older
    than that are not a gap, and re-detecting them re-backfills (and re-drops)
    the same buckets on every startup."""
    import geometrikks.server.timescale as ts

    # Wipe stale materialized OLD-day buckets left by earlier tests in this
    # file (clean_tables deletes raw rows, which only invalidates; a refresh
    # over the empty range is what actually drops the stale buckets).
    await _refresh(pg_engine, "summary_hourly_stats",
                   OLD - timedelta(days=1), OLD + timedelta(days=1))

    async with pg_session_maker() as session:
        for ts_val, ip in ((OLD, "10.0.0.1"), (RECENT, "10.0.0.2")):
            await session.execute(text(
                "INSERT INTO access_logs (timestamp, ip_address, status_code, bytes_sent, request_time) "
                "VALUES (:ts, :ip, 200, 100, 0.01)"
            ), {"ts": ts_val, "ip": ip})
        await session.commit()

    # Advance the hourly watermark past OLD without materializing it.
    await _refresh(pg_engine, "summary_hourly_stats",
                   NOW - timedelta(days=3), NOW - timedelta(hours=1))

    async def hourly_mat_dates() -> set:
        async with pg_engine.connect() as conn:
            mat = (await conn.execute(text(
                "SELECT format('%I.%I', materialization_hypertable_schema, "
                "materialization_hypertable_name) "
                "FROM timescaledb_information.continuous_aggregates "
                "WHERE view_name = 'summary_hourly_stats'"
            ))).scalar()
            rows = (await conn.execute(
                text(f"SELECT DISTINCT bucket::date FROM {mat}")  # noqa: S608
            )).scalars().all()
        return set(rows)

    # OLD (10d ago) is beyond a 5-day hourly retention horizon: not a gap.
    await ts.backfill_cagg_gaps(pg_engine, raw_retention_days=180, hourly_retention_days=5)
    assert OLD.date() not in await hourly_mat_dates()

    # Within a 15-day horizon the same missing range is real and gets repaired.
    await ts.backfill_cagg_gaps(pg_engine, raw_retention_days=180, hourly_retention_days=15)
    assert OLD.date() in await hourly_mat_dates()
