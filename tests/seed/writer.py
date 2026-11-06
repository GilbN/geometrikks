"""Database side of a seeding run: COPY for the bulk tables, plain SQL for the rest."""

from __future__ import annotations

import asyncio
from collections.abc import Iterable
from dataclasses import dataclass
from itertools import cycle

import asyncpg

from geometrikks.server.timescale import ALL_CAGGS

from tests.seed.catalog import SERVER_SITES
from tests.seed.config import SeedError
from tests.seed.traffic import AccessLogRow, Batch, DebugRow, GeoEventRow
from tests.seed.visitors import Place

# summary_daily_stats stands in for the continuous aggregates, which only app startup creates.
REQUIRED_TABLES = (
    "access_logs", "geo_events", "geo_locations", "access_log_debug", "server_locations", "summary_daily_stats",
)


@dataclass(slots=True)
class WriteCounts:
    access_logs: int = 0
    geo_events: int = 0
    debug_rows: int = 0


class SeedWriter:
    def __init__(self, conn: asyncpg.Connection) -> None:
        self.conn = conn

    async def check_schema(self) -> None:
        missing = [
            table for table in REQUIRED_TABLES if await self.conn.fetchval("SELECT to_regclass($1)", table) is None
        ]
        if missing:
            raise SeedError(
                f"Missing: {', '.join(missing)}. Start the app once so the tables and continuous aggregates exist."
            )

    async def reset(self, servers: Iterable[str]) -> list[str]:
        """Empty the traffic tables and their aggregates; return the aggregates that failed to clear.

        TimescaleDB 2.31 rejects TRUNCATE on a continuous aggregate. Truncating
        a raw hypertable invalidates its whole range instead, so a full refresh
        drops every bucket. geo_locations ids keep counting up, so a running
        app's cached location ids point at no row instead of at a seeded place.
        """
        async with self.conn.transaction():
            for table in ("access_logs", "geo_events", "access_log_debug"):
                await self.conn.execute(f"TRUNCATE {table}")
            await self.conn.execute("TRUNCATE geo_locations CASCADE")
            await self.conn.execute("TRUNCATE import_jobs, loki_imports")
            await self.conn.execute(
                "DELETE FROM server_locations WHERE server = ANY($1::text[]) AND source = 'auto'", list(servers)
            )
        return await self.refresh_aggregates()

    async def refresh_aggregates(self) -> list[str]:
        """Refresh every GeoMetrikks aggregate over all time; return the ones that failed.

        Matches the app's six-hourly full refresh. It covers today's open
        bucket, which a bounded refresh skips. Once the app's full refresh has
        run, the daily watermark sits at tomorrow, and real-time aggregation
        no longer reads today's rows.
        """
        existing = await self.conn.fetch(
            "SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass(name) IS NOT NULL",
            list(ALL_CAGGS),
        )
        failed: list[str] = []
        for row in existing:
            # A refresh policy running on the same view raises "concurrent
            # refresh"; retry like refresh_caggs_range does.
            for attempt in range(5):
                try:
                    # ALL_CAGGS names only; CALL takes no bind parameter for the view.
                    await self.conn.execute(f"CALL refresh_continuous_aggregate('{row['name']}', NULL, NULL)")
                    break
                except asyncpg.PostgresError as exc:
                    if "concurrent refresh" in str(exc) and attempt < 4:
                        await asyncio.sleep(0.5 * (attempt + 1))
                        continue
                    failed.append(f"{row['name']} ({exc})")
                    break
        return failed

    async def upsert_locations(self, places: Iterable[Place]) -> dict[str, int]:
        """Insert the places that are new and return the id of every place, keyed by geohash."""
        unique = list({place.geohash: place for place in places}.values())
        await self.conn.execute(
            """
            INSERT INTO geo_locations (
                latitude, longitude, geohash, geographic_point, country_code, country_name,
                state, state_code, city, postal_code, timezone, created_at, updated_at
            )
            SELECT lat, lon, gh, ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography, cc, cn,
                   st, stc, city, pc, tz, now(), now()
            FROM unnest(
                $1::float8[], $2::float8[], $3::text[], $4::text[], $5::text[],
                $6::text[], $7::text[], $8::text[], $9::text[], $10::text[]
            ) AS t(lat, lon, gh, cc, cn, st, stc, city, pc, tz)
            ON CONFLICT (geohash) DO NOTHING
            """,
            [place.latitude for place in unique],
            [place.longitude for place in unique],
            [place.geohash for place in unique],
            [place.country_code for place in unique],
            [place.country_name for place in unique],
            [place.state for place in unique],
            [place.state_code for place in unique],
            [place.city for place in unique],
            [place.postal_code for place in unique],
            [place.timezone for place in unique],
        )
        rows = await self.conn.fetch(
            "SELECT geohash, id FROM geo_locations WHERE geohash = ANY($1::text[])",
            [place.geohash for place in unique],
        )
        return {row["geohash"]: row["id"] for row in rows}

    async def add_server_locations(self, servers: Iterable[str]) -> None:
        """Place each server's map beacon at a real city, leaving existing beacons alone."""
        for server, (latitude, longitude) in zip(servers, cycle(SERVER_SITES)):
            await self.conn.execute(
                """
                INSERT INTO server_locations (server, latitude, longitude, source, detected_at, created_at, updated_at)
                VALUES ($1, $2, $3, 'auto', now(), now(), now())
                ON CONFLICT (server) DO NOTHING
                """,
                server,
                latitude,
                longitude,
            )

    async def write(self, batch: Batch) -> WriteCounts:
        """Write one batch in one transaction, so a failure never splits its logs from its events."""
        debug_rows: list[DebugRow] = list(batch.orphan_debug)
        async with self.conn.transaction():
            if batch.access_logs:
                await self._copy("access_logs", batch.access_logs, AccessLogRow._fields)
            if batch.linked:
                # Reserved up front so each debug row can name its access log in the same COPY pass.
                ids = await self.conn.fetch(
                    "SELECT nextval(pg_get_serial_sequence('access_logs', 'id')) AS id "
                    "FROM generate_series(1, $1)",
                    len(batch.linked),
                )
                linked_logs = [(row["id"], *log) for row, (log, _) in zip(ids, batch.linked)]
                await self._copy("access_logs", linked_logs, ("id", *AccessLogRow._fields))
                debug_rows.extend(
                    debug._replace(access_log_id=row["id"]) for row, (_, debug) in zip(ids, batch.linked)
                )
            if batch.geo_events:
                await self._copy("geo_events", batch.geo_events, GeoEventRow._fields)
            if debug_rows:
                await self._copy("access_log_debug", debug_rows, DebugRow._fields)
        return WriteCounts(
            access_logs=len(batch.access_logs) + len(batch.linked),
            geo_events=len(batch.geo_events),
            debug_rows=len(debug_rows),
        )

    async def _copy(self, table: str, records: Iterable[tuple], columns: tuple[str, ...]) -> None:
        await self.conn.copy_records_to_table(table, records=records, columns=list(columns))
