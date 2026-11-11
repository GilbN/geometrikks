"""Appends access log lines from the seeded visitors to files the app tails.

``uv run python -m tests.seed.live --help``. The same seed, row count, server
names and GeoLite2 build as the seed run give the same visitors, so live
requests arrive from IPs the history already holds.
"""

from __future__ import annotations

import argparse
import random
import signal
import sys
import threading
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path

from geometrikks.config.settings import get_settings
from tests.seed.catalog import LOG_FORMATS
from tests.seed.config import SeedConfig, SeedError
from tests.seed.traffic import TrafficGenerator
from tests.seed.visitors import GeoSource, MaxMindGeoSource, VisitorBuilder


def live_log_targets(servers: Sequence[str], log_dir: Path) -> list[tuple[str, str, Path]]:
    """``(server, log format, path)`` per server, the formats assigned as the seed assigns them."""
    return [
        (server, LOG_FORMATS[index % len(LOG_FORMATS)], log_dir / f"{server}.log")
        for index, server in enumerate(servers)
    ]


class LiveFeeder:
    """Writes one request at a time from the seed's visitors, Zipf-weighted like the history."""

    def __init__(self, config: SeedConfig, source: GeoSource, log_dir: Path, *, rate: float, rng: random.Random) -> None:
        seed_rng = random.Random(config.seed)
        visitors = VisitorBuilder(config, source, seed_rng).build()
        # The generator shuffles the visitors into their Zipf ranks with the rng
        # it gets. Handing it the seed run's rng, in the state run_seed leaves it
        # in, gives the live feed the history's heavy hitters.
        self.generator = TrafficGenerator(config, visitors, {}, seed_rng)
        self.generator.rng = rng
        self.rate = rate
        self.rng = rng
        self.paths = {server: path for server, _, path in live_log_targets(config.servers, log_dir)}

    def emit(self, now: datetime) -> tuple[str, str]:
        """Append one line to its server's file; returns ``(server, line)``."""
        row, line, _ = self.generator.line_at(self.generator.pick_visitor(), now)
        # One write per line: the tailer hands a half-written line on as a line.
        with self.paths[row.server].open("a", encoding="utf-8") as log_file:
            log_file.write(f"{line}\n")
        return row.server, line

    def run(self, stop: threading.Event) -> None:
        """Emit lines with exponential gaps averaging ``rate`` per second until ``stop`` is set."""
        while not stop.is_set():
            self.emit(datetime.now(UTC))
            stop.wait(self.rng.expovariate(self.rate))


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m tests.seed.live",
        description="Append access log lines from the seeded visitors until SIGTERM or SIGINT.",
    )
    parser.add_argument("--log-dir", type=Path, required=True, help="where to write <server>.log")
    parser.add_argument("--city-db", type=Path, required=True, help="GeoLite2-City.mmdb the seed run used")
    parser.add_argument("--asn-db", type=Path, required=True, help="GeoLite2-ASN.mmdb the seed run used")
    parser.add_argument("-s", "--seed", type=int, default=42, help="the seed run's seed (default: 42)")
    parser.add_argument("-r", "--rows", type=int, default=150_000, help="the seed run's rows (default: 150000)")
    parser.add_argument("--servers", default="edge,homelab", help="the seed run's servers (default: edge,homelab)")
    parser.add_argument("--rate", type=float, default=4, help="average lines per second (default: 4)")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    for database in (args.city_db, args.asn_db):
        if not database.is_file():
            print(f"No GeoLite2 database at {database}.", file=sys.stderr)
            return 2
    if args.rate <= 0:
        print("--rate must be above 0.", file=sys.stderr)
        return 2
    try:
        config = SeedConfig(
            rows=args.rows,
            seed=args.seed,
            servers=tuple(name.strip() for name in args.servers.split(",") if name.strip()),
        )
    except ValueError as exc:
        print(f"Invalid option: {exc}", file=sys.stderr)
        return 2

    args.log_dir.mkdir(parents=True, exist_ok=True)
    for _, _, path in live_log_targets(config.servers, args.log_dir):
        path.write_text("", encoding="utf-8")

    stop = threading.Event()
    previous = {signum: signal.getsignal(signum) for signum in (signal.SIGTERM, signal.SIGINT)}
    for signum in previous:
        signal.signal(signum, lambda *_: stop.set())
    try:
        source = MaxMindGeoSource(args.city_db, args.asn_db, get_settings().geoip.locales)
        try:
            feeder = LiveFeeder(config, source, args.log_dir, rate=args.rate, rng=random.Random())
        except SeedError as exc:
            print(exc, file=sys.stderr)
            return 1
        finally:
            source.close()
        print(f"Writing about {args.rate:g} lines a second to {args.log_dir}", flush=True)
        feeder.run(stop)
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)
    return 0


if __name__ == "__main__":
    sys.exit(main())
