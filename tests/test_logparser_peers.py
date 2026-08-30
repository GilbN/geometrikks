"""Peer classification inside LogParser: kinds, logging, budget."""
from __future__ import annotations

import json
import time
from pathlib import Path

import structlog

from geometrikks.services.logparser.logparser import LogParser, is_private_peer
from geometrikks.services.logparser.peer_window import PeerWindow


def make_line(ip: str) -> str:
    # geometrikks-json fields are ALL strings (GeometrikksJsonLine struct);
    # an int status would fail msgspec decoding and the line would not parse.
    return json.dumps({
        "client_ip": ip, "timestamp": "2026-08-30T10:00:00+00:00",
        "method": "GET", "path": "/", "protocol": "HTTP/1.1",
        "status": "200", "bytes": "123",
    })


def make_parser(*, window: PeerWindow | None, asn: int | None = None) -> LogParser:
    parser = LogParser(
        log_path=Path("/dev/null"), send_logs=True,
        hostname="web-01", log_format="geometrikks-json",
        peer_window=window,
    )
    parser._asn = asn  # ty: ignore[unresolved-attribute]  # captured by the stub lookups below
    return parser


class FakeASN:
    def __init__(self, number: int) -> None:
        self.autonomous_system_number = number
        self.autonomous_system_organization = "org"


def parse(parser: LogParser, ip: str) -> None:
    lookup = lambda _ip: None                     # no City data needed for classification
    stub_asn = parser._asn  # ty: ignore[unresolved-attribute]
    asn_lookup = (lambda _ip: FakeASN(stub_asn)) if stub_asn else (lambda _ip: None)
    parser.parse_line(make_line(ip), lookup, asn_lookup=asn_lookup)  # ty: ignore[invalid-argument-type]


def test_private_ranges_classify_as_private() -> None:
    for ip in ("10.1.2.3", "172.18.0.1", "192.168.1.9", "100.64.0.7",
               "127.0.0.1", "169.254.10.10", "fc00::1", "::1", "fe80::1"):
        assert is_private_peer(ip), ip


def test_reserved_is_not_private_and_not_recorded() -> None:
    window = PeerWindow(size=100)
    parser = make_parser(window=window)
    parse(parser, "240.0.0.1")                    # RESERVED
    assert not is_private_peer("240.0.0.1")
    assert window.summary().lines == 0


def test_private_line_recorded() -> None:
    window = PeerWindow(size=100)
    parser = make_parser(window=window)
    parse(parser, "172.18.0.1")
    s = window.summary()
    assert s.lines == 1 and s.private_share == 1.0


def test_cdn_line_recorded_with_provider() -> None:
    window = PeerWindow(size=100)
    parser = make_parser(window=window, asn=13335)
    parse(parser, "203.0.113.7")
    s = window.summary()
    assert s.cdn_share == 1.0 and s.top_provider == "Cloudflare"


def test_public_without_asn_database_is_other() -> None:
    window = PeerWindow(size=100)
    parser = make_parser(window=window)           # asn_lookup returns None
    parse(parser, "203.0.113.7")
    s = window.summary()
    assert s.lines == 1 and s.cdn_share == 0.0 and s.private_share == 0.0


def test_no_window_records_nothing() -> None:
    parser = make_parser(window=None)
    parse(parser, "172.18.0.1")                   # must not raise
    assert parser.peer_summary() is None


def test_detected_and_cleared_logged_once() -> None:
    window = PeerWindow(size=1000)
    parser = make_parser(window=window)
    with structlog.testing.capture_logs() as logs:
        for _ in range(600):
            parse(parser, "172.18.0.1")
        for _ in range(700):
            parse(parser, "203.0.113.7")          # dilutes below 50%
    detected = [e for e in logs if e["event"] == "proxy_peer_detected"]
    cleared = [e for e in logs if e["event"] == "proxy_peer_cleared"]
    assert len(detected) == 1 and detected[0]["kind"] == "private"
    assert detected[0]["hostname"] == "web-01"
    assert len(cleared) == 1


def test_per_line_budget() -> None:
    """Classification must not measurably slow the parser. Generous bound:
    the same 10k lines with the window on may take at most 1.25x the
    no-window time (best of 3 runs each, same parser construction)."""
    lines = [make_line("203.0.113.7")] * 10_000

    def run(window: PeerWindow | None) -> float:
        best = float("inf")
        for _ in range(3):
            parser = make_parser(window=window)
            start = time.perf_counter()
            for line in lines:
                parser.parse_line(line, lambda _ip: None, asn_lookup=lambda _ip: None)
            best = min(best, time.perf_counter() - start)
        return best

    assert run(PeerWindow()) <= run(None) * 1.25
