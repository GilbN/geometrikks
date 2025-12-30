"""Data generators for bulk seeding using Polyfactory.

Provides high-performance generators that create realistic test data
with proper statistical distributions, built on Polyfactory.
"""

from __future__ import annotations

import logging
import random
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert as pg_insert

from geometrikks.domain.geo.models import GeoLocation, GeoEvent
from geometrikks.domain.logs.models import AccessLog, AccessLogDebug
from tests.seed.config import (
    SeedConfig,
    safe_batch_size,
    COLUMNS_GEO_LOCATION,
    COLUMNS_ACCESS_LOG,
    COLUMNS_GEO_EVENT,
    COLUMNS_DEBUG_LOG,
)
from tests.seed.factories import (
    GeoLocationFactory,
    GeoEventFactory,
    AccessLogFactory,
    AccessLogDebugFactory,
    seed_factories,
    rng as factory_rng,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

logger = logging.getLogger(__name__)


def zipf_distribution(n: int, exponent: float, size: int, rng: random.Random) -> list[int]:
    """Generate indices following Zipf distribution.

    Args:
        n: Number of unique items (0 to n-1).
        exponent: Zipf exponent (higher = more skewed).
        size: Number of samples to generate.
        rng: Random number generator.

    Returns:
        List of indices with Zipf-distributed frequencies.
    """
    ranks = range(1, n + 1)
    weights = [1.0 / (rank ** exponent) for rank in ranks]
    total = sum(weights)
    probabilities = [w / total for w in weights]
    indices = list(range(n))
    return rng.choices(indices, weights=probabilities, k=size)


class IPPool:
    """Pool of IP addresses with Zipf-distributed access."""

    def __init__(self, size: int = 1000, ipv6_ratio: float = 0.1, seed: int = 42):
        from faker import Faker
        fake = Faker()
        Faker.seed(seed)

        self.ipv4_pool = [fake.ipv4() for _ in range(size)]
        self.ipv6_pool = [fake.ipv6() for _ in range(int(size * ipv6_ratio))]
        self.rng = random.Random(seed)
        self.zipf_exponent = 1.5

    def get_ip(self) -> str:
        """Get an IP with Zipf distribution (some IPs much more common)."""
        if self.rng.random() < 0.1 and self.ipv6_pool:  # 10% IPv6
            idx = int(self.rng.random() * len(self.ipv6_pool))
            return self.ipv6_pool[idx]

        # Zipf distribution for IPv4
        idx = int((self.rng.random() ** self.zipf_exponent) * len(self.ipv4_pool))
        idx = min(idx, len(self.ipv4_pool) - 1)
        return self.ipv4_pool[idx]


class DataSeeder:
    """High-performance data seeder using Polyfactory.

    Example:
        async with DataSeeder(session_factory) as seeder:
            await seeder.seed_all(SeedConfig(num_access_logs=1_000_000))
    """

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        config: SeedConfig | None = None,
    ):
        self.session_factory = session_factory
        self.config = config or SeedConfig()

        # Seed all factories
        seed_factories(self.config.seed)

        # Local RNG for distribution logic
        self.rng = random.Random(self.config.seed)

        # IP pool for realistic distribution
        self.ip_pool = IPPool(size=1000, seed=self.config.seed)

        # Track created IDs for foreign key relationships
        self.location_ids: list[int] = []

    async def __aenter__(self) -> "DataSeeder":
        return self

    async def __aexit__(self, *args) -> None:
        pass

    def _log(self, msg: str) -> None:
        if self.config.verbose:
            logger.info(msg)
            print(msg)

    def _random_timestamp(self) -> datetime:
        """Generate a random timestamp within the configured range."""
        delta = self.config.end_date - self.config.start_date
        random_seconds = self.rng.random() * delta.total_seconds()
        return self.config.start_date + timedelta(seconds=random_seconds)

    async def seed_locations(self) -> list[int]:
        """Seed GeoLocation table and return created IDs."""
        self._log(f"Seeding {self.config.num_locations:,} locations...")

        # Calculate safe batch size for this table
        max_batch = safe_batch_size(COLUMNS_GEO_LOCATION)
        batch_size = min(self.config.batch_size, max_batch)

        location_ids = []

        async with self.session_factory() as session:
            for batch_start in range(0, self.config.num_locations, batch_size):
                batch_end = min(batch_start + batch_size, self.config.num_locations)
                batch_count = batch_end - batch_start

                # Use factory to generate location dicts
                locations = GeoLocationFactory.batch_dicts(batch_count)

                # PostgreSQL upsert to handle geohash conflicts
                stmt = pg_insert(GeoLocation).values(locations)
                stmt = stmt.on_conflict_do_nothing(index_elements=["geohash"])
                stmt = stmt.returning(GeoLocation.id)

                result = await session.execute(stmt)
                ids = [row[0] for row in result.fetchall()]
                location_ids.extend(ids)

                await session.commit()

                if self.config.verbose and batch_end % (batch_size * 10) == 0:
                    self._log(f"  Locations: {batch_end:,}/{self.config.num_locations:,}")

        self._log(f"  Created {len(location_ids):,} locations")
        self.location_ids = location_ids
        return location_ids

    async def seed_access_logs_and_events(self) -> tuple[int, int]:
        """Seed AccessLog and GeoEvent tables.

        Returns:
            Tuple of (access_log_count, geo_event_count)
        """
        if not self.location_ids:
            raise RuntimeError("Must seed locations first")

        self._log(f"Seeding {self.config.num_access_logs:,} access logs and geo events...")

        # Calculate safe batch size (use the smaller of the two table limits)
        max_batch_logs = safe_batch_size(COLUMNS_ACCESS_LOG)
        max_batch_events = safe_batch_size(COLUMNS_GEO_EVENT)
        batch_size = min(self.config.batch_size, max_batch_logs, max_batch_events)

        total_logs = 0
        total_events = 0

        async with self.session_factory() as session:
            for batch_start in range(0, self.config.num_access_logs, batch_size):
                batch_end = min(batch_start + batch_size, self.config.num_access_logs)
                batch_count = batch_end - batch_start

                # Pre-compute Zipf-distributed location indices for this batch
                location_indices = zipf_distribution(
                    len(self.location_ids),
                    self.config.location_zipf_exponent,
                    batch_count,
                    self.rng,
                )

                access_logs = []
                geo_events = []

                for i in range(batch_count):
                    timestamp = self._random_timestamp()
                    ip = self.ip_pool.get_ip()
                    location_id = self.location_ids[location_indices[i]]

                    # Use factories to build dicts
                    access_logs.append(
                        AccessLogFactory.build_dict(timestamp=timestamp, ip_address=ip)
                    )
                    geo_events.append(
                        GeoEventFactory.build_dict(
                            location_id=location_id,
                            timestamp=timestamp,
                            ip_address=ip,
                        )
                    )

                # Bulk insert access logs
                if access_logs:
                    await session.execute(pg_insert(AccessLog).values(access_logs))
                    total_logs += len(access_logs)

                # Bulk insert geo events
                if geo_events:
                    await session.execute(pg_insert(GeoEvent).values(geo_events))
                    total_events += len(geo_events)

                await session.commit()

                if self.config.verbose and batch_end % (batch_size * 10) == 0:
                    self._log(f"  Progress: {batch_end:,}/{self.config.num_access_logs:,}")

        self._log(f"  Created {total_logs:,} access logs, {total_events:,} geo events")
        return total_logs, total_events

    async def seed_debug_logs(self, count: int | None = None) -> int:
        """Seed AccessLogDebug table.

        Args:
            count: Number of debug entries (default: 10% of access logs)
        """
        if count is None:
            count = max(1000, self.config.num_access_logs // 10)

        self._log(f"Seeding {count:,} debug log entries...")

        # Calculate safe batch size for this table
        max_batch = safe_batch_size(COLUMNS_DEBUG_LOG)
        batch_size = min(self.config.batch_size, max_batch)

        num_malformed = int(count * self.config.malformed_ratio)
        total = 0

        async with self.session_factory() as session:
            for batch_start in range(0, count, batch_size):
                batch_end = min(batch_start + batch_size, count)
                batch_count = batch_end - batch_start

                entries = []
                for i in range(batch_count):
                    global_idx = batch_start + i
                    is_malformed = global_idx < num_malformed

                    created_at = self._random_timestamp()
                    entries.append(
                        AccessLogDebugFactory.build_dict(
                            is_malformed=is_malformed,
                            created_at=created_at,
                        )
                    )

                await session.execute(pg_insert(AccessLogDebug).values(entries))
                total += len(entries)
                await session.commit()

        self._log(f"  Created {total:,} debug entries ({num_malformed:,} malformed)")
        return total

    async def refresh_aggregates(self) -> None:
        """Refresh TimescaleDB continuous aggregates after seeding.

        Note: CALL statements cannot run inside a transaction block,
        so we use the raw asyncpg connection with autocommit.
        """
        self._log("Refreshing continuous aggregates...")

        async with self.session_factory() as session:
            # Get the raw asyncpg connection (nested under SQLAlchemy adapters)
            connection = await session.connection()
            raw_conn = await connection.get_raw_connection()
            asyncpg_conn = raw_conn.dbapi_connection.driver_connection

            for cagg in ["hourly_stats_cagg", "geo_events_hourly_cagg", "daily_stats_cagg"]:
                try:
                    # Execute with autocommit (outside transaction)
                    await asyncpg_conn.execute(
                        f"CALL refresh_continuous_aggregate('{cagg}', NULL, NOW())"
                    )
                    self._log(f"  Refreshed {cagg}")
                except Exception as e:
                    self._log(f"  Warning: Could not refresh {cagg}: {e}")

    async def seed_all(self, config: SeedConfig | None = None) -> dict:
        """Seed all tables with test data.

        Args:
            config: Optional config override.

        Returns:
            Dictionary with seeding statistics.
        """
        if config:
            self.config = config
            seed_factories(config.seed)
            self.rng = random.Random(config.seed)
            self.ip_pool = IPPool(size=1000, seed=config.seed)

        import time
        start_time = time.time()

        self._log("=" * 60)
        self._log("Starting data seeding (using Polyfactory)")
        self._log(f"  Seed: {self.config.seed}")
        self._log(f"  Batch size: {self.config.batch_size:,}")
        self._log(f"  Date range: {self.config.start_date.date()} to {self.config.end_date.date()}")
        self._log("=" * 60)

        # Seed in order (respecting foreign key relationships)
        location_ids = await self.seed_locations()
        log_count, event_count = await self.seed_access_logs_and_events()
        debug_count = await self.seed_debug_logs()

        # Refresh aggregates
        await self.refresh_aggregates()

        elapsed = time.time() - start_time
        total_rows = len(location_ids) + log_count + event_count + debug_count
        rows_per_sec = total_rows / elapsed if elapsed > 0 else 0

        self._log("=" * 60)
        self._log(f"Seeding complete in {elapsed:.1f}s ({rows_per_sec:,.0f} rows/sec)")
        self._log("=" * 60)

        return {
            "locations": len(location_ids),
            "access_logs": log_count,
            "geo_events": event_count,
            "debug_logs": debug_count,
            "elapsed_seconds": elapsed,
            "rows_per_second": rows_per_sec,
        }
