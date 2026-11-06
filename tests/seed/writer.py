"""Database side of a seeding run: COPY for the bulk tables, plain SQL for the rest."""

from __future__ import annotations

import asyncio
from collections.abc import Iterable
from dataclasses import dataclass
from itertools import cycle

import asyncpg

from tests.seed.catalog import SERVER_SITES
from tests.seed.traffic import AccessLogRow, Batch, DebugRow, GeoEventRow
from tests.seed.visitors import Place

REQUIRED_TABLES = ("access_logs", "geo_events", "geo_locations", "access_log_debug", "server_locations")


class SeedError(RuntimeError):
    """The target database cannot take the seed as it stands."""


@dataclass(slots=True)
class WriteCounts:
    access_logs: int = 0
    geo_events: int = 0
    debug_rows: int = 0


class SeedWriter:
    """Writes through two connections so geo_events loads while access_logs does."""

    def __init__(self, conn: asyncpg.Connection, events_conn: asyncpg.Connection) -> None:
        self.conn = conn
        self.events_conn = events_conn

    async def check_schema(self) -> None:
        missing = [
            table for table in REQUIRED_TABLES if await self.conn.fetchval("SELECT to_regclass($1)", table) is None
        ]
        if missing:
            raise SeedError(
                f"Tables missing: {', '.join(missing)}. Start the app once or run `uv run litestar database upgrade`."
            )

    async def reset(self, servers: Iterable[str]) -> None:
        """Empty every traffic table and its continuous aggregates.

        TRUNCATE on a continuous aggregate also resets its watermark; deleting
        only the raw rows would leave stale buckets that hide new history.
        """
        caggs = await self.conn.fetch(
            "SELECT format('%I.%I', view_schema, view_name) AS name FROM timescaledb_information.continuous_aggregates"
        )
        async with self.conn.transaction():
            for cagg in caggs:
                await self.conn.execute(f"TRUNCATE {cagg['name']}")
            for table in ("access_logs", "geo_events", "access_log_debug"):
                await self.conn.execute(f"TRUNCATE {table}")
            await self.conn.execute("TRUNCATE geo_locations RESTART IDENTITY CASCADE")
            await self.conn.execute(
                "DELETE FROM server_locations WHERE server = ANY($1::text[]) AND source = 'auto'", list(servers)
            )

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
        debug_rows, _ = await asyncio.gather(self._write_logs(batch), self._write_events(batch))
        return WriteCounts(
            access_logs=len(batch.access_logs) + len(batch.linked),
            geo_events=len(batch.geo_events),
            debug_rows=debug_rows,
        )

    async def _write_logs(self, batch: Batch) -> int:
        debug_rows: list[DebugRow] = list(batch.orphan_debug)
        async with self.conn.transaction():
            if batch.access_logs:
                await self._copy(self.conn, "access_logs", batch.access_logs, AccessLogRow._fields)
            if batch.linked:
                # Reserved up front so each debug row can name its access log in the same COPY pass.
                ids = await self.conn.fetch(
                    "SELECT nextval(pg_get_serial_sequence('access_logs', 'id')) AS id "
                    "FROM generate_series(1, $1)",
                    len(batch.linked),
                )
                linked_logs = [(row["id"], *log) for row, (log, _) in zip(ids, batch.linked)]
                await self._copy(self.conn, "access_logs", linked_logs, ("id", *AccessLogRow._fields))
                debug_rows.extend(
                    debug._replace(access_log_id=row["id"]) for row, (_, debug) in zip(ids, batch.linked)
                )
            if debug_rows:
                await self._copy(self.conn, "access_log_debug", debug_rows, DebugRow._fields)
        return len(debug_rows)

    async def _write_events(self, batch: Batch) -> None:
        if batch.geo_events:
            await self._copy(self.events_conn, "geo_events", batch.geo_events, GeoEventRow._fields)

    @staticmethod
    async def _copy(
        conn: asyncpg.Connection, table: str, records: Iterable[tuple], columns: tuple[str, ...]
    ) -> None:
        await conn.copy_records_to_table(table, records=records, columns=list(columns))
