"""CLI entry point for data seeding.

Usage:
    python -m tests.seed --help
    python -m tests.seed --rows 1000000
    python -m tests.seed --rows 1000000 --seed 12345 --batch-size 50000
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from geometrikks.config.settings import get_settings
from tests.seed.config import SeedConfig
from tests.seed.generators import DataSeeder


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Seed the database with test data for performance testing.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Seed 100k rows (default)
  python -m tests.seed

  # Seed 1 million access logs
  python -m tests.seed --rows 1000000

  # Seed with specific seed for reproducibility
  python -m tests.seed --rows 500000 --seed 12345

  # Seed with larger batch size for faster inserts
  python -m tests.seed --rows 1000000 --batch-size 50000

  # Seed data for last 90 days
  python -m tests.seed --days 90

  # Only seed locations (useful for testing)
  python -m tests.seed --locations-only --num-locations 10000
        """,
    )

    parser.add_argument(
        "--rows", "-r",
        type=int,
        default=100_000,
        help="Number of access log rows to generate (default: 100000)",
    )

    parser.add_argument(
        "--num-locations", "-l",
        type=int,
        default=5_000,
        help="Number of unique locations to generate (default: 5000)",
    )

    parser.add_argument(
        "--seed", "-s",
        type=int,
        default=42,
        help="Random seed for reproducibility (default: 42)",
    )

    parser.add_argument(
        "--batch-size", "-b",
        type=int,
        default=10_000,
        help="Batch size for bulk inserts (default: 10000)",
    )

    parser.add_argument(
        "--days", "-d",
        type=int,
        default=30,
        help="Number of days of historical data to generate (default: 30)",
    )

    parser.add_argument(
        "--database-url",
        type=str,
        default=None,
        help="Database URL (default: from settings)",
    )

    parser.add_argument(
        "--locations-only",
        action="store_true",
        help="Only seed locations (skip access logs and events)",
    )

    parser.add_argument(
        "--skip-aggregates",
        action="store_true",
        help="Skip refreshing continuous aggregates after seeding",
    )

    parser.add_argument(
        "--quiet", "-q",
        action="store_true",
        help="Suppress progress output",
    )

    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be seeded without actually seeding",
    )

    return parser.parse_args()


async def main() -> int:
    args = parse_args()

    # Build configuration
    end_date = datetime.now(timezone.utc)
    start_date = end_date - timedelta(days=args.days)

    config = SeedConfig(
        seed=args.seed,
        batch_size=args.batch_size,
        num_locations=args.num_locations,
        num_access_logs=args.rows,
        num_geo_events=args.rows,
        start_date=start_date,
        end_date=end_date,
        verbose=not args.quiet,
    )

    if args.dry_run:
        print("=" * 60)
        print("DRY RUN - No data will be written")
        print("=" * 60)
        print(f"Configuration:")
        print(f"  Random seed: {config.seed}")
        print(f"  Batch size: {config.batch_size:,}")
        print(f"  Locations: {config.num_locations:,}")
        print(f"  Access logs: {config.num_access_logs:,}")
        print(f"  Geo events: {config.num_geo_events:,}")
        print(f"  Debug logs: ~{config.num_access_logs // 10:,}")
        print(f"  Date range: {start_date.date()} to {end_date.date()}")
        print(f"  Malformed ratio: {config.malformed_ratio:.1%}")
        print("=" * 60)
        total_rows = (
            config.num_locations +
            config.num_access_logs +
            config.num_geo_events +
            config.num_access_logs // 10
        )
        print(f"Total rows to insert: ~{total_rows:,}")
        return 0

    # Get database URL
    if args.database_url:
        db_url = args.database_url
    else:
        settings = get_settings()
        db_url = settings.database.url

    # Create async engine and session factory
    engine = create_async_engine(
        db_url,
        echo=False,
        pool_size=5,
        max_overflow=10,
    )

    session_factory = async_sessionmaker(
        engine,
        expire_on_commit=False,
    )

    try:
        async with DataSeeder(session_factory, config) as seeder:
            if args.locations_only:
                await seeder.seed_locations()
            else:
                stats = await seeder.seed_all()

                if not args.skip_aggregates:
                    await seeder.refresh_aggregates()

                if not args.quiet:
                    print("\nSeeding Statistics:")
                    for key, value in stats.items():
                        if isinstance(value, float):
                            print(f"  {key}: {value:,.2f}")
                        else:
                            print(f"  {key}: {value:,}")

        return 0

    except Exception as e:
        logger.exception("Seeding failed: %s", e)
        return 1

    finally:
        await engine.dispose()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
