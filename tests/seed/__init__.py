"""Data seeding module for performance testing.

This module provides Polyfactory-based factories and bulk generators
for creating realistic test data at scale (millions of rows).

Usage:
    # From command line
    python -m tests.seed --rows 1000000

    # Programmatically
    from tests.seed import DataSeeder, SeedConfig
    async with DataSeeder(session_factory) as seeder:
        await seeder.seed_all(SeedConfig(num_access_logs=1_000_000))

    # Use factories directly in tests
    from tests.seed.factories import GeoLocationFactory, AccessLogFactory
    location = GeoLocationFactory.build()
    access_log_dict = AccessLogFactory.build_dict(timestamp=now)
"""

from tests.seed.config import SeedConfig
from tests.seed.generators import DataSeeder
from tests.seed.factories import (
    GeoLocationFactory,
    GeoEventFactory,
    AccessLogFactory,
    AccessLogDebugFactory,
    seed_factories,
)

__all__ = [
    "DataSeeder",
    "SeedConfig",
    "GeoLocationFactory",
    "GeoEventFactory",
    "AccessLogFactory",
    "AccessLogDebugFactory",
    "seed_factories",
]
