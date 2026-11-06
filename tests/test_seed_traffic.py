"""Seeder row generation: the shapes live ingestion would have written."""
from __future__ import annotations

import dataclasses
import ipaddress
import json
import random
from datetime import datetime, timezone

from tests.seed.config import SeedConfig
from tests.seed.traffic import Batch, TrafficGenerator
from tests.seed.visitors import Visitor, VisitorBuilder
from tests.seed_support import FakeGeoSource

END = datetime(2026, 11, 1, 12, tzinfo=timezone.utc)


def _generate(config: SeedConfig) -> tuple[list[Visitor], list[Batch]]:
    rng = random.Random(config.seed)
    visitors = VisitorBuilder(config, FakeGeoSource(), rng).build()
    places = {visitor.resolved.place.geohash for visitor in visitors if visitor.resolved}
    location_ids = {geohash: index for index, geohash in enumerate(sorted(places), start=1)}
    return visitors, list(TrafficGenerator(config, visitors, location_ids, rng).batches())


def _config(**overrides) -> SeedConfig:
    return dataclasses.replace(SeedConfig(rows=4_000, days=7, visitors=300, batch_size=1_000, end=END), **overrides)


def test_every_ip_keeps_one_location_and_asn() -> None:
    _, batches = _generate(_config())
    seen: dict[str, tuple[int, int | None]] = {}
    for event in (event for batch in batches for event in batch.geo_events):
        assert seen.setdefault(event.ip_address, (event.location_id, event.autonomous_system_number)) == (
            event.location_id,
            event.autonomous_system_number,
        )
    assert len(seen) > 50


def test_access_logs_carry_their_visitors_place() -> None:
    visitors, batches = _generate(_config())
    by_ip = {visitor.ip: visitor for visitor in visitors}
    for batch in batches:
        logs = [*batch.access_logs, *(log for log, _ in batch.linked)]
        for log in logs:
            resolved = by_ip[log.ip_address].resolved
            if resolved is None:
                assert log.country_code is None and log.autonomous_system_number is None
            else:
                assert (log.country_code, log.city, log.autonomous_system_number) == (
                    resolved.place.country_code,
                    resolved.place.city,
                    resolved.asn,
                )


def test_lan_requests_get_no_geo_event() -> None:
    _, batches = _generate(_config(private_share=0.2))
    logs = [log for batch in batches for log in [*batch.access_logs, *(log for log, _ in batch.linked)]]
    private = [log for log in logs if ipaddress.ip_address(log.ip_address).is_private]
    events = [event for batch in batches for event in batch.geo_events]
    assert len(private) > 400
    assert len(events) == len(logs) - len(private)
    assert not any(ipaddress.ip_address(event.ip_address).is_private for event in events)


def test_probe_lines_are_malformed_and_linked() -> None:
    _, batches = _generate(_config())
    linked = [pair for batch in batches for pair in batch.linked]
    probes = [(log, debug) for log, debug in linked if debug.is_malformed]
    assert probes
    for log, debug in probes:
        assert (log.method, log.url, log.status_code) == (None, None, 400)
        assert debug.parse_error and debug.log_timestamp == log.timestamp
    for log, debug in linked:
        if log.log_format == "geometrikks-json":
            assert json.loads(debug.raw_line)["client_ip"] == log.ip_address
        else:
            assert debug.raw_line.startswith(f"{log.ip_address} - ")


def test_rows_stay_inside_the_window() -> None:
    config = _config()
    _, batches = _generate(config)
    stamps = [log.timestamp for batch in batches for log in batch.access_logs]
    assert config.start <= min(stamps) and max(stamps) <= END


def test_home_country_holds_most_people() -> None:
    visitors, _ = _generate(_config(home_country="NO", home_share=0.8))
    people = [visitor for visitor in visitors if visitor.kind == "browser"]
    home = [visitor for visitor in people if visitor.resolved and visitor.resolved.place.country_code == "NO"]
    assert len(home) / len(people) > 0.7


def test_same_seed_gives_the_same_traffic() -> None:
    _, first = _generate(_config())
    _, second = _generate(_config())
    assert [batch.access_logs for batch in first] == [batch.access_logs for batch in second]
