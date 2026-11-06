"""Command line for the seeder: ``uv run python -m tests.seed --help``."""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from sqlalchemy.engine import make_url

from geometrikks.config.settings import get_settings
from tests.seed.config import SeedConfig, SeedError
from tests.seed.seeder import run_seed
from tests.seed.visitors import MaxMindGeoSource

EXAMPLES = """
examples:
  uv run python -m tests.seed                          100k requests over 30 days
  uv run python -m tests.seed -r 1000000 -d 90         a million requests over 90 days
  uv run python -m tests.seed --reset --home-country NO
  uv run python -m tests.seed --servers web,nas,vps    three servers, each with its own hosts
"""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m tests.seed",
        description="Write access logs, geo events and debug lines to a GeoMetrikks database, placed with GeoLite2.",
        epilog=EXAMPLES,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("-r", "--rows", type=int, default=100_000, help="requests to write (default: 100000)")
    parser.add_argument("-d", "--days", type=float, default=30, help="days of history ending now (default: 30)")
    parser.add_argument("--visitors", type=int, help="distinct client IPs (default: rows / 40, 100 to 20000)")
    parser.add_argument(
        "--servers",
        default="seed-edge,seed-nas",
        help="comma-separated server names to record traffic under (default: seed-edge,seed-nas)",
    )
    parser.add_argument("--home-country", help="ISO code most human visitors come from, such as NO or US")
    parser.add_argument("-s", "--seed", type=int, default=42, help="random seed (default: 42)")
    parser.add_argument("--batch-size", type=int, default=20_000, help="rows per COPY (default: 20000)")
    parser.add_argument(
        "--debug-share", type=float, default=0.02, help="share of normal requests that keep a raw debug line"
    )
    parser.add_argument("--reset", action="store_true", help="empty all traffic tables before seeding")
    parser.add_argument("-y", "--yes", action="store_true", help="skip the --reset confirmation")
    parser.add_argument("--no-refresh", action="store_true", help="skip the continuous aggregate refresh")
    parser.add_argument("--database-url", help="postgresql+asyncpg:// URL (default: the app's DB_* settings)")
    parser.add_argument("--city-db", type=Path, help="GeoLite2-City.mmdb (default: GEOIP_DB_PATH)")
    parser.add_argument("--asn-db", type=Path, help="GeoLite2-ASN.mmdb (default: GEOIP_ASN_DB_PATH)")
    return parser.parse_args(argv)


def _confirm_reset(database: str) -> bool:
    try:
        answer = input(f"--reset empties every traffic table in '{database}'. Type the database name to go on: ")
    except EOFError:
        return False
    return answer.strip() == database


async def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    settings = get_settings()
    database_url = args.database_url or settings.database.url
    if database_url.startswith("postgresql://"):
        database_url = database_url.replace("postgresql://", "postgresql+asyncpg://", 1)
    target = make_url(database_url)
    database = target.database or ""

    city_db = args.city_db or settings.geoip.db_path
    if not city_db.is_file():
        print(
            f"GeoLite2 City database not found at {city_db}. The seeder places visitors with it; "
            "pass --city-db or set GEOIP_DB_PATH.",
            file=sys.stderr,
        )
        return 2
    asn_db: Path | None = args.asn_db or settings.geoip.asn_db_path
    if asn_db is not None and not asn_db.is_file():
        print(f"No GeoLite2 ASN database at {asn_db}; rows get no ASN.", file=sys.stderr)
        asn_db = None

    try:
        config = SeedConfig(
            rows=args.rows,
            days=args.days,
            seed=args.seed,
            visitors=args.visitors,
            servers=tuple(name.strip() for name in args.servers.split(",") if name.strip()),
            home_country=args.home_country,
            debug_share=args.debug_share,
            batch_size=args.batch_size,
        )
    except ValueError as exc:
        print(f"Invalid option: {exc}", file=sys.stderr)
        return 2

    print(f"Seeding {database} on {target.host}:{target.port or 5432}")
    if args.reset and not args.yes and not _confirm_reset(database):
        print("Not confirmed; nothing written.", file=sys.stderr)
        return 1

    source = MaxMindGeoSource(city_db, asn_db, settings.geoip.locales)
    try:
        stats = await run_seed(
            config, source, database_url, reset=args.reset, refresh=not args.no_refresh, progress=print
        )
    except SeedError as exc:
        print(exc, file=sys.stderr)
        return 1
    finally:
        source.close()

    print(
        f"Done in {stats.seconds:.1f}s: {stats.access_logs:,} access logs, {stats.geo_events:,} geo events, "
        f"{stats.debug_rows:,} debug lines, {stats.locations:,} locations from {stats.visitors:,} visitors"
    )
    if stats.failed_caggs:
        print(f"These continuous aggregates did not refresh: {', '.join(stats.failed_caggs)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
