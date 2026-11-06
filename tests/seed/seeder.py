"""One seeding run from visitors to refreshed aggregates."""

from __future__ import annotations

import random
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone

import asyncpg
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from geometrikks.server.timescale import refresh_caggs_range
from geometrikks.services.aggregation.service import AggregationService
from tests.seed.config import SeedConfig
from tests.seed.traffic import TrafficGenerator
from tests.seed.visitors import GeoSource, VisitorBuilder
from tests.seed.writer import SeedWriter


# Start of the refresh that clears stale buckets after --reset; older than any real log.
RESET_FROM = datetime(2000, 1, 1, tzinfo=timezone.utc)


@dataclass(slots=True)
class SeedStats:
    visitors: int = 0
    locations: int = 0
    access_logs: int = 0
    geo_events: int = 0
    debug_rows: int = 0
    seconds: float = 0.0
    failed_caggs: list[str] = field(default_factory=list)


def asyncpg_dsn(database_url: str) -> str:
    return database_url.replace("postgresql+asyncpg://", "postgresql://", 1)


async def run_seed(
    config: SeedConfig,
    source: GeoSource,
    database_url: str,
    *,
    reset: bool = False,
    refresh: bool = True,
    progress: Callable[[str], None] = lambda _: None,
) -> SeedStats:
    """Generate ``config.rows`` requests and write them to the database at ``database_url``.

    Args:
        config: What to generate.
        source: Resolves sampled IPs to places and ASNs.
        database_url: SQLAlchemy asyncpg URL of a migrated GeoMetrikks database.
        reset: Empty the traffic tables and their aggregates first.
        refresh: Materialize the continuous aggregates over the seeded range and
            update geo_locations.last_hit, as the scheduler would.
        progress: Receives one line per step.
    """
    started = time.monotonic()
    stats = SeedStats()
    rng = random.Random(config.seed)

    progress(f"Sampling {config.visitor_count:,} visitor IPs")
    visitors = VisitorBuilder(config, source, rng).build()
    stats.visitors = len(visitors)
    places = [visitor.resolved.place for visitor in visitors]

    engine = create_async_engine(database_url)
    conn = await asyncpg.connect(asyncpg_dsn(database_url))
    try:
        writer = SeedWriter(conn)
        await writer.check_schema()
        if reset:
            progress("Emptying traffic tables and continuous aggregates")
            stale_caggs = await writer.reset(config.servers)
            if stale_caggs:
                stats.failed_caggs += await refresh_caggs_range(
                    engine, start=RESET_FROM, end=datetime.now(timezone.utc), caggs=stale_caggs
                )
        location_ids = await writer.upsert_locations(places)
        stats.locations = len(location_ids)
        await writer.add_server_locations(config.servers)

        generator = TrafficGenerator(config, visitors, location_ids, rng)
        for batch in generator.batches():
            counts = await writer.write(batch)
            stats.access_logs += counts.access_logs
            stats.geo_events += counts.geo_events
            stats.debug_rows += counts.debug_rows
            rate = stats.access_logs / max(time.monotonic() - started, 1e-6)
            progress(f"  {stats.access_logs:,} / {config.rows:,} requests ({rate:,.0f}/s)")
        await conn.close()

        if refresh:
            progress("Refreshing continuous aggregates")
            stats.failed_caggs += await refresh_caggs_range(engine, start=config.start, end=config.end)
            async with async_sessionmaker(engine)() as session:
                await AggregationService(session).refresh_location_last_hits()
                await session.commit()
    finally:
        if not conn.is_closed():
            await conn.close()
        await engine.dispose()

    stats.seconds = time.monotonic() - started
    return stats
