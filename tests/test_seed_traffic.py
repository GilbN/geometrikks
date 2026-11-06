"""Seeder row generation: the shapes live ingestion would have written."""
from __future__ import annotations

import dataclasses
import json
import random
from datetime import datetime, timezone
from pathlib import Path

import geohash2
import pytest

from geometrikks.services.logparser.formats import FORMATS
from geometrikks.services.logparser.logparser import check_ip_type
from tests.seed.config import SeedConfig, SeedError
from tests.seed.traffic import Batch, TrafficGenerator
from tests.seed.visitors import MaxMindGeoSource, Resolved, Visitor, VisitorBuilder
from tests.seed_support import FakeGeoSource

END = datetime(2026, 11, 1, 12, tzinfo=timezone.utc)


def _generate(config: SeedConfig) -> tuple[list[Visitor], list[Batch]]:
    rng = random.Random(config.seed)
    visitors = VisitorBuilder(config, FakeGeoSource(), rng).build()
    places = {visitor.resolved.place.geohash for visitor in visitors}
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
    by_ip = {visitor.ip: visitor.resolved for visitor in visitors}
    for batch in batches:
        for log in [*batch.access_logs, *(log for log, _ in batch.linked)]:
            resolved = by_ip[log.ip_address]
            assert (log.country_code, log.city, log.autonomous_system_number) == (
                resolved.place.country_code,
                resolved.place.city,
                resolved.asn,
            )


def test_every_request_is_a_public_log_and_event_pair() -> None:
    _, batches = _generate(_config())
    for batch in batches:
        logs = [*batch.access_logs, *(log for log, _ in batch.linked)]
        assert sorted((log.timestamp, log.ip_address) for log in logs) == sorted(
            (event.timestamp, event.ip_address) for event in batch.geo_events
        )
        assert all(check_ip_type(log.ip_address) for log in logs)


@pytest.mark.parametrize(
    "overrides",
    [{"batch_size": 0}, {"visitors": 0}, {"rows": 0}, {"debug_share": 1.5}, {"days": float("nan")}, {"days": 99_999}],
)
def test_config_rejects_values_that_cannot_seed(overrides) -> None:
    with pytest.raises(ValueError):
        _config(**overrides)


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
    home = [visitor for visitor in people if visitor.resolved.place.country_code == "NO"]
    assert len(home) / len(people) > 0.7


def test_same_seed_gives_the_same_traffic() -> None:
    _, first = _generate(_config())
    _, second = _generate(_config())
    assert [batch.access_logs for batch in first] == [batch.access_logs for batch in second]


def test_debug_lines_parse_back_to_their_rows() -> None:
    _, batches = _generate(_config())
    linked = [pair for batch in batches for pair in batch.linked]
    assert {log.log_format for log, _ in linked} == {"geometrikks-json", "nginx"}
    for log, debug in linked:
        line_format = FORMATS[log.log_format]
        parsed = line_format.parse(debug.raw_line)
        assert parsed is not None, debug.raw_line
        assert (
            parsed.ip_address, parsed.timestamp, parsed.method, parsed.path, parsed.status_code,
            parsed.bytes_sent, parsed.host, parsed.user_agent,
        ) == (
            log.ip_address, log.timestamp, log.method, log.url, log.status_code,
            log.bytes_sent, log.host, log.user_agent,
        )
        assert line_format.detect_malformed(parsed) == (debug.is_malformed, debug.parse_error)


def test_maxmind_source_reads_places_like_ingestion() -> None:
    fixtures = Path(__file__).parent
    source = MaxMindGeoSource(fixtures / "GeoLite2-City-Test.mmdb", fixtures / "GeoLite2-ASN-Test.mmdb", ["en"])
    try:
        resolved = source.resolve("89.160.20.112")
    finally:
        source.close()
    assert resolved is not None
    place = resolved.place
    assert (place.country_code, place.city, place.state_code, place.timezone) == (
        "SE", "Linköping", "E", "Europe/Stockholm",
    )
    assert place.geohash == geohash2.encode(place.latitude, place.longitude)
    assert (resolved.asn, resolved.asn_org) == (29518, "Bredband2 AB")


def test_home_country_that_never_resolves_raises_seed_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(VisitorBuilder, "HOME_ATTEMPTS", 500)
    with pytest.raises(SeedError, match="'ZZ'"):
        _generate(_config(home_country="ZZ", home_share=1.0, visitors=5))


class _NoAsnSource(FakeGeoSource):
    has_asn = False

    def __init__(self) -> None:
        self.lookups = 0

    def resolve(self, ip: str) -> Resolved | None:
        self.lookups += 1
        resolved = super().resolve(ip)
        return resolved and Resolved(place=resolved.place, asn=None, asn_org=None)

    def is_hosting(self, asn: int | None) -> bool:
        return False


def test_bots_take_any_network_without_asn_data() -> None:
    source = _NoAsnSource()
    config = _config()
    visitors = VisitorBuilder(config, source, random.Random(config.seed)).build()
    assert {visitor.kind for visitor in visitors} == {"browser", "crawler", "scanner"}
    assert source.lookups < 5 * len(visitors)
