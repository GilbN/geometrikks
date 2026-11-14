"""Live log feeder: lines from the seeded visitors that the app's own parsers accept."""
from __future__ import annotations

import dataclasses
import os
import random
import signal
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

import pytest

from geometrikks.services.logparser.formats import FORMATS
from tests.seed import live
from tests.seed.config import SeedConfig
from tests.seed.live import LiveFeeder, live_log_targets
from tests.seed.traffic import TrafficGenerator
from tests.seed.visitors import Visitor, VisitorBuilder
from tests.seed_support import FakeGeoSource

NOW = datetime(2026, 11, 10, 12, 30, 15, 123456, tzinfo=UTC)


def test_same_seed_gives_the_same_visitors_whatever_the_end() -> None:
    a = SeedConfig(rows=4000, seed=7, end=datetime(2026, 11, 1, tzinfo=UTC))
    b = dataclasses.replace(a, end=datetime(2026, 11, 10, tzinfo=UTC))

    def ips(config: SeedConfig) -> list[str]:
        return [v.ip for v in VisitorBuilder(config, FakeGeoSource(), random.Random(config.seed)).build()]

    assert ips(a) == ips(b)


def test_live_log_targets_alternate_formats(tmp_path: Path) -> None:
    assert live_log_targets(["edge", "homelab"], tmp_path) == [
        ("edge", "geometrikks-json", tmp_path / "edge.log"),
        ("homelab", "nginx", tmp_path / "homelab.log"),
    ]


def test_line_at_marks_probes_with_their_parse_error() -> None:
    config = SeedConfig(rows=4000, seed=7)
    visitors = VisitorBuilder(config, FakeGeoSource(), random.Random(7)).build()
    generator = TrafficGenerator(config, visitors, {}, random.Random(3))
    lines = [generator.line_at(generator.pick_visitor(), NOW) for _ in range(2000)]
    assert any(error for _, _, error in lines)
    assert all((error is not None) == (row.method is None) for row, _, error in lines)


def test_line_at_writes_whole_seconds_like_both_formats() -> None:
    config = SeedConfig(rows=4000, seed=7)
    visitors = VisitorBuilder(config, FakeGeoSource(), random.Random(7)).build()
    generator = TrafficGenerator(config, visitors, {}, random.Random(3))
    for _ in range(200):
        row, line, _ = generator.line_at(generator.pick_visitor(), NOW)
        parsed = FORMATS[row.log_format].parse(line)
        assert parsed is not None, line
        assert row.timestamp == parsed.timestamp == NOW.replace(microsecond=0)


def test_feeder_ranks_visitors_like_the_seed_run() -> None:
    config = SeedConfig(rows=4000, seed=7)
    seed_rng = random.Random(config.seed)
    seeded = TrafficGenerator(config, VisitorBuilder(config, FakeGeoSource(), seed_rng).build(), {}, seed_rng)
    feeder = LiveFeeder(config, FakeGeoSource(), Path("unused"), rate=4, rng=random.Random(1))
    assert [v.ip for v in feeder.generator.public] == [v.ip for v in seeded.public]


def test_emitted_lines_parse_and_come_from_seed_visitors(tmp_path: Path) -> None:
    config = SeedConfig(rows=4000, seed=7, servers=("edge", "homelab"))
    feeder = LiveFeeder(config, FakeGeoSource(), tmp_path, rate=4, rng=random.Random(1))
    visitor_ips = {v.ip for v in VisitorBuilder(config, FakeGeoSource(), random.Random(7)).build()}
    now = datetime.now(UTC)
    for _ in range(300):
        feeder.emit(now)
    for _, log_format, path in live_log_targets(config.servers, tmp_path):
        parsed = [FORMATS[log_format].parse(line) for line in path.read_text().splitlines()]
        good = [p for p in parsed if p is not None]
        assert good and {p.ip_address for p in good} <= visitor_ips
        assert all(abs((p.timestamp - now).total_seconds()) < 2 for p in good)


def test_emit_returns_the_line_it_appended(tmp_path: Path) -> None:
    config = SeedConfig(rows=4000, seed=7, servers=("edge", "homelab"))
    feeder = LiveFeeder(config, FakeGeoSource(), tmp_path, rate=4, rng=random.Random(1))
    emitted = [feeder.emit(NOW) for _ in range(50)]
    for server, _, path in live_log_targets(config.servers, tmp_path):
        assert path.read_text().splitlines() == [line for name, line in emitted if name == server]


def test_run_returns_once_stop_is_set(tmp_path: Path) -> None:
    config = SeedConfig(rows=4000, seed=7, servers=("edge", "homelab"))
    feeder = LiveFeeder(config, FakeGeoSource(), tmp_path, rate=200, rng=random.Random(1))
    stop = threading.Event()
    worker = threading.Thread(target=feeder.run, args=(stop,))
    worker.start()
    threading.Timer(0.3, stop.set).start()
    worker.join(timeout=5)
    assert not worker.is_alive()
    assert sum(len(path.read_text().splitlines()) for *_, path in live_log_targets(config.servers, tmp_path)) > 5


class _ClosableFakeSource(FakeGeoSource):
    def close(self) -> None:
        pass


@pytest.mark.parametrize("signum", [signal.SIGTERM, signal.SIGINT])
def test_cli_truncates_the_files_and_exits_0_on_signal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, signum: signal.Signals
) -> None:
    city_db, asn_db = tmp_path / "city.mmdb", tmp_path / "asn.mmdb"
    city_db.touch()
    asn_db.touch()
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    (log_dir / "edge.log").write_text("stale line from an earlier run\n")
    monkeypatch.setattr(live, "MaxMindGeoSource", lambda *_args: _ClosableFakeSource())
    handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
    timer = threading.Timer(0.5, os.kill, (os.getpid(), signum))
    timer.start()
    try:
        code = live.main(
            ["--log-dir", str(log_dir), "--city-db", str(city_db), "--asn-db", str(asn_db),
             "--rows", "4000", "--rate", "200"]
        )
    finally:
        timer.cancel()
    assert code == 0
    written = 0
    for _, log_format, path in live_log_targets(["edge", "homelab"], log_dir):
        lines = path.read_text().splitlines()
        assert all(FORMATS[log_format].parse(line) is not None for line in lines)
        written += len(lines)
    assert written > 5
    assert {sig: signal.getsignal(sig) for sig in handlers} == handlers


def test_line_at_refuses_a_naive_timestamp() -> None:
    generator = TrafficGenerator.__new__(TrafficGenerator)
    with pytest.raises(ValueError, match="aware"):
        generator.line_at(cast(Visitor, None), datetime(2026, 11, 11, 12, 0))
