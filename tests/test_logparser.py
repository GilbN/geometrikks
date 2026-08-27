import asyncio
import os
import re
import time
from pathlib import Path
from typing import Any, cast

import aiofiles.os
import pytest
from geoip2.database import Reader

from geometrikks.services.logparser.constants import ipv4_pattern, ipv6_pattern
from geometrikks.services.logparser.logparser import (
    LogParser,
    check_ip_type,
    get_ip_type,
    make_cached_city_lookup,
)
from geometrikks.services.logparser.schemas import ParsedAccessLog

pytestmark = pytest.mark.anyio


def make_log_line(ip: str) -> str:
    """A line in the project's custom nginx log format (mirrors tests/valid_ipv4_log.txt)."""
    return (
        f'{ip} - - [03/Aug/2024:13:14:17 +0200]"GET /index.php HTTP/2.0" 200 1024"-" '
        f'example.com "-""0.002" "0.001""City" "CC"'
    )


VALID_LOG_PATH = "tests/valid_ipv4_log.txt"
UNPARSEABLE_LOG_PATH = "tests/unparseable_logs.txt"
NONSTANDARD_LOG_PATH = "tests/nonstandard_logs.txt"
GEOIP_DB_PATH = "tests/GeoLite2-City-Test.mmdb"

# A geometrikks-json line as nginx's escape=json would actually write a TLS
# probe: control bytes escaped as JSON \u00XX sequences, but a byte above
# 0x7f is left raw and, here, not valid UTF-8 on its own (0xfc, an old
# 5-byte UTF-8 lead byte). Written in binary so the invalid byte lands on
# disk unchanged; a text-mode write would reject or escape it before the
# tailer ever sees it.
GJSON_TLS_PROBE_LINE_BYTES = (
    b'{"client_ip":"203.0.113.7","timestamp":"2026-08-25T22:00:24+02:00",'
    b'"method":"","status":"400","request_raw":"\\u0016\\u0003\\u0001'
    + bytes([0xFC])
    + b'"}\n'
)


@pytest.fixture
def load_valid_ipv4_log() -> list[str]:
    """Load the contents of the valid IPv4 log file."""
    with open("tests/valid_ipv4_log.txt", "r", encoding="utf-8") as f:
        return f.readlines()

@pytest.fixture
def load_valid_ipv6_log() -> list[str]:
    """Load the contents of the valid IPv6 log file."""
    with open("tests/valid_ipv6_log.txt", "r", encoding="utf-8") as f:
        return f.readlines()

@pytest.fixture
def load_unparseable_logs() -> list[str]:
    """Lines that match no log pattern at all (no IP / no timestamp structure)."""
    with open(UNPARSEABLE_LOG_PATH, "r", encoding="utf-8") as f:
        return f.readlines()

@pytest.fixture
def load_nonstandard_logs() -> list[str]:
    """Real-world lines in a different/garbage format that the loosened pattern still matches."""
    with open(NONSTANDARD_LOG_PATH, "r", encoding="utf-8") as f:
        return f.readlines()

@pytest.fixture
def ipv4_log_pattern() -> re.Pattern[str]:
    """Return the regular expression pattern for an IPv4 log line."""
    return ipv4_pattern()

@pytest.fixture
def ipv6_log_pattern() -> re.Pattern[str]:
    """Return the regular expression pattern for an IPv6 log line."""
    return ipv6_pattern()

@pytest.fixture
def geoip_reader() -> Reader:
    """Return a GeoIP2 Reader instance for testing."""
    return Reader(GEOIP_DB_PATH)

@pytest.fixture
def log_parser() -> LogParser:
    """Return an instance of the LogParser class."""
    log_path = Path(VALID_LOG_PATH)
    parser = LogParser(log_path=log_path, send_logs=True, hostname="localhost")
    return parser


def test_regex_tester_ipv4(load_valid_ipv4_log: list[str], ipv4_log_pattern: re.Pattern[str]) -> None:
    """Test the regex tester for IPv4 log lines."""
    for line in load_valid_ipv4_log:
        assert bool(ipv4_log_pattern.match(line)) is True

def test_regex_tester_ipv6(load_valid_ipv6_log: list[str], ipv6_log_pattern: re.Pattern[str]) -> None:
    """Test the regex tester for IPv6 log lines."""
    for line in load_valid_ipv6_log:
        assert bool(ipv6_log_pattern.match(line)) is True

def test_regex_tester_invalid(load_unparseable_logs: list[str], ipv4_log_pattern: re.Pattern[str], ipv6_log_pattern: re.Pattern[str]) -> None:
    """Truly unparseable lines must not match either full log pattern."""
    for line in load_unparseable_logs:
        assert bool(ipv4_log_pattern.match(line)) is False
        assert bool(ipv6_log_pattern.match(line)) is False

def test_user_agent_fully_captured(ipv4_log_pattern: re.Pattern[str]) -> None:
    """Regression: the user_agent group must capture the whole UA string.

    The non-greedy ``(.+?)`` had no required trailing token (request_time and
    upstream groups are optional, no ``$`` anchor), so it matched a single
    character -- e.g. "Mozilla/5.0 ..." collapsed to "M". Anchoring the group
    with the closing quote forces it to consume the full UA.
    """
    combined = (
        '4.255.101.233 - - [28/Jul/2024:02:00:50 +0200] '
        '"GET /manager/html HTTP/1.1" 301 162 "-" "Mozilla/5.0 zgrab/0.x"'
    )
    m = ipv4_log_pattern.match(combined)
    assert m is not None
    assert m.group("user_agent") == "Mozilla/5.0 zgrab/0.x"

    # Project's custom format: anchoring also lets request_time parse cleanly.
    custom = (
        '1.2.3.4 - - [03/Aug/2024:13:14:17 +0200]"GET /i HTTP/2.0" 200 1024"-" '
        'example.com "Mozilla/5.0 (X11)""0.002" "0.001""City" "CC"'
    )
    m2 = ipv4_log_pattern.match(custom)
    assert m2 is not None
    assert m2.group("user_agent") == "Mozilla/5.0 (X11)"
    assert m2.group("request_time") == "0.002"


def test_non_dash_referrer_does_not_swallow_following_fields(ipv4_log_pattern: re.Pattern[str]) -> None:
    """Regression: the referrer/url field must not cross quotes.

    ``URL_PATTERN`` used a greedy ``.+`` anchored only by a later ``"``. When the
    quoted field held a real value (not ``-``), it swallowed host, user_agent and
    the trailing fields, so user_agent ended up as the country code. Fixtures all
    use ``"-"`` there, which matched the ``\\-`` alternative and hid the bug.
    """
    line = (
        '1.2.3.4 - - [03/Aug/2024:13:14:17 +0200]"GET /p?a=1 HTTP/2.0" 200 1024'
        '"http://ref.example/x" host.tld "curl/8.0""0.002" "0.001""City" "CC"'
    )
    m = ipv4_log_pattern.match(line)
    assert m is not None
    assert m.group("url") == "http://ref.example/x"
    assert m.group("user_agent") == "curl/8.0"
    assert m.group("request_time") == "0.002"
    assert m.group("upstream_response_time") == "0.001"

def test_get_ip_type(log_parser: LogParser) -> None:
    """Test the module-level get_ip_type function."""
    assert get_ip_type("10.10.10.1") == "PRIVATE"
    assert get_ip_type("52.53.54.55") == "PUBLIC"

def test_get_ip_type_invalid(log_parser: LogParser) -> None:
    """Test the get_ip_type function with an invalid IP address."""
    assert get_ip_type("10.10.10.256") == ""


def test_check_ip_type_module_level_cached() -> None:
    """check_ip_type is a module-level lru_cache keyed on ip only."""
    check_ip_type.cache_clear()
    assert check_ip_type("52.53.54.55") is True   # PUBLIC
    assert check_ip_type("10.10.10.1") is False   # PRIVATE
    assert check_ip_type("52.53.54.55") is True
    info = check_ip_type.cache_info()
    assert info.currsize == 2
    assert info.hits == 1


def test_cached_city_lookup_calls_reader_once_per_ip() -> None:
    """The per-reader lookup caches by IP and swallows reader exceptions."""
    calls = {"n": 0}

    class CountingReader:
        def city(self, ip):
            calls["n"] += 1
            raise RuntimeError("lookup failed")

    lookup = make_cached_city_lookup(cast("Reader", CountingReader()))
    assert lookup("1.2.3.4") is None
    assert lookup("1.2.3.4") is None
    assert calls["n"] == 1


def test_validate_log_line_send_logs_true(log_parser: LogParser, load_valid_ipv4_log: list[str]) -> None:
    """When send_logs is True, full access-log regex should match valid lines."""
    log_parser.send_logs = True
    # Pick a typical valid line
    line = load_valid_ipv4_log[0]
    matched = log_parser.validate_log_line(line)
    assert matched is not None
    assert matched.ip_address  # IP captured


def test_validate_log_line_send_logs_false_geo_only(log_parser: LogParser) -> None:
    """When send_logs is False, geo-only pattern should match (IP + timestamp prefix)."""
    log_parser.send_logs = False
    # Geo pattern expects: IP - user [timestamp]
    # Use a valid line and verify only IP and timestamp are required
    valid_line = (
        Path("tests/valid_ipv4_log.txt").read_text(encoding="utf-8").splitlines()[0]
    )
    matched = log_parser.validate_log_line(valid_line)
    assert matched is not None
    # Should capture IP address
    assert matched.ip_address is not None
    # Should capture the timestamp
    assert matched.timestamp is not None

def test_validate_log_line_unmatched(log_parser: LogParser, load_unparseable_logs: list[str]) -> None:
    """Unparseable lines should not match when expecting full access-log format."""
    log_parser.send_logs = True
    for line in load_unparseable_logs:
        assert log_parser.validate_log_line(line) is None

def test_validate_log_format_true(tmp_path: Path, log_parser: LogParser) -> None:
    """validate_log_format returns True when last lines contain valid format."""
    # Create a temp log file and copy some valid lines
    log_file = tmp_path / "access.log"
    valid_lines = Path("tests/valid_ipv4_log.txt").read_text(encoding="utf-8")
    log_file.write_text(valid_lines, encoding="utf-8")

    # validate_log_format now takes log_path as parameter
    assert log_parser.validate_log_format(log_file) is True

def test_validate_log_format_false(tmp_path: Path, log_parser: LogParser) -> None:
    """validate_log_format returns False when trailing lines are unparseable."""
    log_file = tmp_path / "access.log"
    unparseable = Path(UNPARSEABLE_LOG_PATH).read_text(encoding="utf-8")
    log_file.write_text(unparseable, encoding="utf-8")

    log_parser.send_logs = True

    assert log_parser.validate_log_format(log_file) is False


def test_validate_log_format_survives_undecodable_bytes(tmp_path: Path) -> None:
    """A raw non-UTF-8 byte in request_raw must not raise UnicodeDecodeError."""
    log_file = tmp_path / "access.log"
    log_file.write_bytes(GJSON_TLS_PROBE_LINE_BYTES * 3)
    parser = LogParser(log_path=log_file, send_logs=True, log_format="geometrikks-json")

    assert parser.validate_log_format(log_file) is True


def test_parse_line_geometrikks_json_survives_undecodable_bytes(geoip_reader: Reader) -> None:
    """The decoded line still classifies as the raw-bytes TLS probe."""
    parser = LogParser(log_path=Path("/dev/null"), send_logs=True, log_format="geometrikks-json")
    lookup = make_cached_city_lookup(geoip_reader)
    line = GJSON_TLS_PROBE_LINE_BYTES.decode("utf-8", errors="replace")

    record = parser.parse_line(line, lookup)

    assert record is not None
    assert record.is_malformed is True
    assert record.parse_error == "TLS handshake sent to HTTP port (raw)"


async def test_iter_parsed_records_geometrikks_json_survives_undecodable_bytes(
    tmp_path: Path, geoip_reader: Reader
) -> None:
    """The async tail path also survives a raw non-UTF-8 byte in the file."""
    log_file = tmp_path / "access.log"
    log_file.write_bytes(GJSON_TLS_PROBE_LINE_BYTES)
    parser = LogParser(log_path=log_file, send_logs=True, log_format="geometrikks-json")
    parser._stop_event = asyncio.Event()

    gen = parser.iter_parsed_records(geoip_reader, skip_validation=True, start_at_end=False)
    record = await gen.__anext__()

    assert record is not None
    assert record.ip_address == "203.0.113.7"
    assert record.is_malformed is True
    assert record.parse_error == "TLS handshake sent to HTTP port (raw)"


async def test_await_valid_log_format_returns_when_stop_requested(
    tmp_path: Path, monkeypatch
) -> None:
    """A stop ends the retry loop instead of blocking for the whole timeout.

    The empty file never validates, so with retries enabled the old blocking
    loop would have occupied a worker thread for the full timeout regardless
    of the stop event.
    """
    monkeypatch.setenv("DISABLE_WAIT", "false")
    log_file = tmp_path / "access.log"
    log_file.write_text("", encoding="utf-8")
    parser = LogParser(log_path=log_file, send_logs=True, hostname="localhost")
    stop_event = asyncio.Event()
    parser.set_stop_event(stop_event)
    stop_event.set()

    started = time.monotonic()
    assert await parser.await_valid_log_format(timeout_seconds=60.0) is False
    assert time.monotonic() - started < 1.0


async def test_await_valid_log_format_wakes_on_stop_between_attempts(
    tmp_path: Path, monkeypatch
) -> None:
    """A stop arriving mid-wait ends the loop without sitting out the interval."""
    monkeypatch.setenv("DISABLE_WAIT", "false")
    log_file = tmp_path / "access.log"
    log_file.write_text("", encoding="utf-8")
    parser = LogParser(log_path=log_file, send_logs=True, hostname="localhost")
    stop_event = asyncio.Event()
    parser.set_stop_event(stop_event)

    async def stop_soon() -> None:
        await asyncio.sleep(0.05)
        stop_event.set()

    started = time.monotonic()
    result, _ = await asyncio.gather(
        parser.await_valid_log_format(timeout_seconds=60.0, check_interval=30.0),
        stop_soon(),
    )
    assert result is False
    assert time.monotonic() - started < 5.0


async def test_await_valid_log_format_retries_until_the_file_is_parseable(
    tmp_path: Path, monkeypatch
) -> None:
    """An empty file that gains a valid line mid-wait still validates."""
    monkeypatch.setenv("DISABLE_WAIT", "false")
    log_file = tmp_path / "access.log"
    log_file.write_text("", encoding="utf-8")
    parser = LogParser(log_path=log_file, send_logs=True, hostname="localhost")
    parser.set_stop_event(asyncio.Event())

    async def append_valid_line() -> None:
        await asyncio.sleep(0.05)
        log_file.write_text(
            Path(VALID_LOG_PATH).read_text(encoding="utf-8"), encoding="utf-8"
        )

    result, _ = await asyncio.gather(
        parser.await_valid_log_format(timeout_seconds=10.0, check_interval=0.02),
        append_valid_line(),
    )
    assert result is True

def test_nonstandard_lines_match_loosened_pattern(load_nonstandard_logs: list[str], ipv4_log_pattern: re.Pattern[str]) -> None:
    """The loosened request group ([^"]*) accepts nonstandard/garbage requests so they
    can be flagged by _detect_malformed_request instead of being skipped."""
    for line in load_nonstandard_logs:
        assert ipv4_log_pattern.match(line) is not None


def test_binary_probe_flagged_malformed(log_parser: LogParser, load_nonstandard_logs: list[str], geoip_reader: Reader) -> None:
    """A binary probe (frp handshake) matches the pattern but is detected as malformed."""
    log_parser.send_logs = True
    line = next(ln for ln in load_nonstandard_logs if "\\x00\\x01" in ln)
    lookup = make_cached_city_lookup(geoip_reader)
    record = log_parser.parse_line(line, lookup)
    assert record is not None
    assert record.is_malformed is True
    assert record.parse_error == "No HTTP method in request"

async def test_is_rotated_truncation_99pct(tmp_path: Path, log_parser: LogParser, monkeypatch) -> None:
    """Rotation detected when size shrinks by >=99%."""
    # Create file and obtain real previous stat
    log_file = tmp_path / "access.log"
    log_file.write_bytes(b"x" * 1_000_000)
    prev = os.stat(log_file)

    # Current stat: shrunk to 5_000 bytes (~99.5% drop) and same inode
    class Curr:
        st_size = 5_000
        st_ino = prev.st_ino

    async def fake_stat(_path):
        return Curr()

    monkeypatch.setattr(aiofiles.os, "stat", fake_stat)

    log_parser.log_path = log_file
    is_rotated = await log_parser._is_rotated_async(prev)
    assert is_rotated is True


async def test_is_rotated_inode_change(tmp_path: Path, log_parser: LogParser, monkeypatch) -> None:
    """Rotation detected when inode changes."""
    log_file = tmp_path / "access.log"
    log_file.write_bytes(b"x" * 1_000_000)
    prev = os.stat(log_file)

    class Curr:
        st_size = prev.st_size
        st_ino = prev.st_ino + 1

    async def fake_stat(_path):
        return Curr()

    monkeypatch.setattr(aiofiles.os, "stat", fake_stat)
    log_parser.log_path = log_file
    assert await log_parser._is_rotated_async(prev) is True


async def test_is_rotated_disabled(tmp_path: Path, log_parser: LogParser, monkeypatch) -> None:
    """Rotation check can be disabled via env."""
    monkeypatch.setenv("DISABLE_ROTATION_CHECK", "true")
    log_file = tmp_path / "access.log"
    log_file.write_bytes(b"x" * 1_000_000)
    prev = os.stat(log_file)

    # Even with drastic change, returns False when disabled
    class Curr:
        st_size = 100
        st_ino = prev.st_ino + 100

    async def fake_stat(_path):
        return Curr()

    monkeypatch.setattr(aiofiles.os, "stat", fake_stat)
    log_parser.log_path = log_file
    assert await log_parser._is_rotated_async(prev) is False


def test_create_access_log_sqlalchemy_success(log_parser: LogParser, geoip_reader: Reader) -> None:
    """Successfully create AccessLog from a valid normalized line and GeoIP lookup."""
    # Use a valid line from the IPv4 log
    line = Path("tests/valid_ipv4_log.txt").read_text(encoding="utf-8").splitlines()[0]
    log_parser.send_logs = True
    norm = log_parser.validate_log_line(line)
    assert norm is not None

    ip = norm.ip_address
    lookup = make_cached_city_lookup(geoip_reader)
    access_log = log_parser._parse_access_log(norm, ip, lookup)

    assert isinstance(access_log, ParsedAccessLog)
    assert access_log.country_code is not None
    assert access_log.bytes_sent >= 0
    assert access_log.request_time >= 0.0


def test_create_access_log_sqlalchemy_geoip_failure(log_parser: LogParser, monkeypatch) -> None:
    """Return None when GeoIP lookup fails."""
    line = Path("tests/valid_ipv4_log.txt").read_text(encoding="utf-8").splitlines()[0]
    log_parser.send_logs = True
    norm = log_parser.validate_log_line(line)
    assert norm is not None

    # Create a mock reader that raises an exception
    class MockReader:
        def city(self, ip):
            raise RuntimeError("geo lookup error")

    mock_reader = MockReader()
    ip = norm.ip_address
    lookup = make_cached_city_lookup(cast("Reader", mock_reader))
    result = log_parser._parse_access_log(norm, ip, lookup)
    assert result is None


async def test_iter_log_events_async_unmatched(tmp_path: Path, log_parser: LogParser, geoip_reader: Reader) -> None:
    """Async generator yields record with matched=None for invalid line; increments skipped."""
    log_file = tmp_path / "access.log"
    # Write a clearly invalid line
    log_file.write_text("not-a-valid-access-log-line\n", encoding="utf-8")
    log_parser.log_path = log_file

    # Set stop event so we don't loop forever
    log_parser._stop_event = asyncio.Event()

    gen = log_parser.iter_parsed_records(
        geoip_reader, skip_validation=True, start_at_end=False
    )
    record = await gen.__anext__()
    assert record is not None
    assert record.ip_address is None
    assert record.geo_data is None
    assert record.access_log is None
    assert isinstance(record.raw_line, str)
    assert log_parser.skipped_lines_count() >= 1


async def test_iter_log_events_async_matched(tmp_path: Path, log_parser: LogParser, geoip_reader: Reader) -> None:
    """Async generator yields parsed record for a valid line; access_log when send_logs=True."""
    log_file = tmp_path / "access.log"
    valid_line = (
        Path("tests/valid_ipv4_log.txt").read_text(encoding="utf-8").splitlines()[0]
    )
    log_file.write_text(valid_line + "\n", encoding="utf-8")
    log_parser.log_path = log_file

    # Ensure we use full log-line validation
    log_parser.send_logs = True

    # Set stop event so we don't loop forever
    log_parser._stop_event = asyncio.Event()

    gen = log_parser.iter_parsed_records(
        geoip_reader, skip_validation=True, start_at_end=False
    )
    record = await gen.__anext__()
    assert record is not None
    assert record.ip_address is not None
    assert record.geo_data is not None
    assert record.access_log is not None
    assert isinstance(record.ip_address, str)
    assert log_parser.parsed_lines_count() >= 1


async def test_iter_log_events_async_rotation_restart(tmp_path: Path, log_parser: LogParser, geoip_reader: Reader, monkeypatch) -> None:
    """When rotation is detected, async generator delegates to a new stream (restart)."""
    log_file = tmp_path / "access.log"
    # Start with a valid line so initial read succeeds
    valid_line = (
        Path("tests/valid_ipv4_log.txt").read_text(encoding="utf-8").splitlines()[0]
    )
    log_file.write_text(valid_line + "\n", encoding="utf-8")
    log_parser.log_path = log_file

    # Patch _is_rotated_async to return True at first check to force restart
    call_count = {"n": 0}

    async def _is_rotated_once(_prev):
        call_count["n"] += 1
        return call_count["n"] == 1

    monkeypatch.setattr(log_parser, "_is_rotated_async", _is_rotated_once)

    # Use full validation
    log_parser.send_logs = True

    # Set stop event so we don't loop forever
    log_parser._stop_event = asyncio.Event()

    gen = log_parser.iter_parsed_records(
        geoip_reader, skip_validation=True, start_at_end=False
    )
    # First __anext__() triggers rotation and restart; subsequent yield should still produce records
    record = await gen.__anext__()
    assert record is not None
    assert record.ip_address is not None
    assert record.access_log is not None


def test_parse_geo_data(log_parser: LogParser, geoip_reader: Reader) -> None:
    """_parse_geo_data builds a ParsedGeoData object with expected fields."""
    # Use a valid log line to get the normalized line
    valid_line = (
        Path("tests/valid_ipv4_log.txt").read_text(encoding="utf-8").splitlines()[0]
    )
    log_parser.send_logs = True
    norm = log_parser.validate_log_line(valid_line)
    assert norm is not None

    ip = norm.ip_address
    lookup = make_cached_city_lookup(geoip_reader)
    parsed = log_parser._parse_geo_data(ip, norm, lookup)

    # The IP should resolve to a location (test with real GeoIP DB)
    assert parsed is not None
    assert parsed.country_code is not None
    assert parsed.latitude is not None
    assert parsed.longitude is not None
    assert parsed.geohash is not None


async def test_iter_parsed_records_tags_source(tmp_path: Path, log_parser: LogParser, geoip_reader: Reader) -> None:
    """Every yielded record carries the source file path it was read from."""
    log_file = tmp_path / "access.log"
    valid_line = Path(VALID_LOG_PATH).read_text(encoding="utf-8").splitlines()[0]
    log_file.write_text(valid_line + "\n", encoding="utf-8")
    log_parser.log_path = log_file
    log_parser._stop_event = asyncio.Event()

    gen = log_parser.iter_parsed_records(geoip_reader, skip_validation=True, start_at_end=False)
    record = await gen.__anext__()
    await gen.aclose()
    assert record is not None
    assert record.source == str(log_file)


async def test_rotation_reopens_from_start_twice(tmp_path: Path, log_parser: LogParser, geoip_reader: Reader) -> None:
    """Two consecutive real rotations (inode change) keep records flowing, reading each new file from the start."""
    valid_lines = Path(VALID_LOG_PATH).read_text(encoding="utf-8").splitlines()
    log_file = tmp_path / "access.log"
    log_file.write_text(valid_lines[0] + "\n", encoding="utf-8")
    log_parser.log_path = log_file
    log_parser.poll_interval = 0.01
    log_parser.send_logs = True
    log_parser._stop_event = asyncio.Event()

    gen = log_parser.iter_parsed_records(geoip_reader, skip_validation=True, start_at_end=False)

    async def next_record():
        while True:
            rec = await gen.__anext__()
            if rec is not None:
                return rec

    first = await next_record()
    assert first.ip_address is not None

    for i in (1, 2):
        replacement = tmp_path / f"rotated-{i}.log"
        replacement.write_text(valid_lines[i] + "\n", encoding="utf-8")
        os.replace(replacement, log_file)  # atomically swaps in a new inode
        rec = await next_record()
        assert rec.ip_address is not None

    await gen.aclose()


class TestParseLine:
    def test_parse_line_valid(self, geoip_reader):
        from geometrikks.services.logparser.logparser import LogParser, make_cached_city_lookup
        parser = LogParser(log_path=Path("/dev/null"), send_logs=True)
        lookup = make_cached_city_lookup(geoip_reader)
        line = make_log_line("2.125.160.216")
        record = parser.parse_line(line, lookup)
        assert record is not None
        assert record.ip_address == "2.125.160.216"
        assert record.geo_data is not None
        assert record.access_log is not None
        assert parser.parsed_lines == 1

    def test_parse_line_garbage_is_malformed(self, geoip_reader):
        from geometrikks.services.logparser.logparser import LogParser, make_cached_city_lookup
        parser = LogParser(log_path=Path("/dev/null"), send_logs=True)
        lookup = make_cached_city_lookup(geoip_reader)
        record = parser.parse_line("total garbage\n", lookup)
        assert record is not None
        assert record.is_malformed is True
        assert record.ip_address is None
        assert parser.skipped_lines == 1

    def test_parse_line_ignored_exact_ip(self, geoip_reader):
        from geometrikks.services.logparser.logparser import LogParser, make_cached_city_lookup
        parser = LogParser(
            log_path=Path("/dev/null"), send_logs=True, ignore_ips=["2.125.160.216"]
        )
        lookup = make_cached_city_lookup(geoip_reader)
        record = parser.parse_line(make_log_line("2.125.160.216"), lookup)
        assert record is None
        assert parser.ignored_lines == 1
        assert parser.skipped_lines == 0
        assert parser.parsed_lines == 0

    def test_parse_line_ignored_cidr(self, geoip_reader):
        from geometrikks.services.logparser.logparser import LogParser, make_cached_city_lookup
        parser = LogParser(
            log_path=Path("/dev/null"), send_logs=True, ignore_ips=["2.125.160.0/24"]
        )
        lookup = make_cached_city_lookup(geoip_reader)
        record = parser.parse_line(make_log_line("2.125.160.216"), lookup)
        assert record is None
        assert parser.ignored_lines == 1

    def test_parse_line_ignored_ipv6_cidr(self, geoip_reader):
        from geometrikks.services.logparser.logparser import LogParser, make_cached_city_lookup
        parser = LogParser(
            log_path=Path("/dev/null"), send_logs=True, ignore_ips=["2001:db8::/32"]
        )
        lookup = make_cached_city_lookup(geoip_reader)
        record = parser.parse_line(make_log_line("2001:db8::1"), lookup)
        assert record is None
        assert parser.ignored_lines == 1

    def test_parse_line_non_matching_ip_passes(self, geoip_reader):
        from geometrikks.services.logparser.logparser import LogParser, make_cached_city_lookup
        parser = LogParser(
            log_path=Path("/dev/null"), send_logs=True, ignore_ips=["203.0.113.0/24"]
        )
        lookup = make_cached_city_lookup(geoip_reader)
        record = parser.parse_line(make_log_line("2.125.160.216"), lookup)
        assert record is not None
        assert record.ip_address == "2.125.160.216"
        assert parser.ignored_lines == 0
        assert parser.parsed_lines == 1

    def test_parse_line_empty_ignore_list_noop(self, geoip_reader):
        from geometrikks.services.logparser.logparser import LogParser, make_cached_city_lookup
        parser = LogParser(log_path=Path("/dev/null"), send_logs=True)
        lookup = make_cached_city_lookup(geoip_reader)
        record = parser.parse_line(make_log_line("2.125.160.216"), lookup)
        assert record is not None
        assert parser.ignored_lines == 0

    def test_parse_line_stamps_parser_hostname(self, geoip_reader):
        from geometrikks.services.logparser.logparser import LogParser, make_cached_city_lookup
        parser = LogParser(log_path=Path("/dev/null"), send_logs=True, hostname="vps-1")
        lookup = make_cached_city_lookup(geoip_reader)
        record = parser.parse_line(make_log_line("2.125.160.216"), lookup)
        assert record is not None
        assert record.hostname == "vps-1"

    def test_parse_line_unmatched_line_still_stamps_hostname(self, geoip_reader):
        from geometrikks.services.logparser.logparser import LogParser, make_cached_city_lookup
        parser = LogParser(log_path=Path("/dev/null"), send_logs=True, hostname="vps-1")
        lookup = make_cached_city_lookup(geoip_reader)
        record = parser.parse_line("total garbage\n", lookup)
        assert record is not None
        assert record.hostname == "vps-1"

    def test_parse_line_default_hostname_is_empty(self, geoip_reader):
        from geometrikks.services.logparser.logparser import LogParser, make_cached_city_lookup
        parser = LogParser(log_path=Path("/dev/null"), send_logs=True)
        lookup = make_cached_city_lookup(geoip_reader)
        record = parser.parse_line(make_log_line("2.125.160.216"), lookup)
        assert record is not None
        assert record.hostname == ""


class TestAutoFormatSniffing:
    """log_format='auto' locks a format on the first line it recognizes."""

    def test_geo_only_match_degrades_send_logs(self, geoip_reader: Reader) -> None:
        """A CLF line matches only the geo-only pattern.

        Full parsing would then drop every line, so the parser degrades to
        geo-only mode instead of locking the file into a format it cannot
        actually parse.
        """
        clf = (
            '2.125.160.216 - frank [03/Aug/2024:13:14:17 +0200] '
            '"GET /a.gif HTTP/1.0" 200 2326'
        )
        parser = LogParser(log_path=Path("/dev/null"), send_logs=True, log_format="auto")
        lookup = make_cached_city_lookup(geoip_reader)

        record = parser.parse_line(clf, lookup)

        assert parser.send_logs is False
        assert parser.format is not None and parser.format.name == "nginx"
        assert record is not None
        assert record.ip_address == "2.125.160.216"
        assert record.geo_data is not None
        assert record.access_log is None
        assert record.is_malformed is False
        assert parser.parsed_lines == 1
        assert parser.skipped_lines == 0

    def test_full_match_keeps_send_logs(self, geoip_reader: Reader) -> None:
        parser = LogParser(log_path=Path("/dev/null"), send_logs=True, log_format="auto")
        lookup = make_cached_city_lookup(geoip_reader)

        record = parser.parse_line(make_log_line("2.125.160.216"), lookup)

        assert parser.send_logs is True
        assert parser.format is not None and parser.format.name == "nginx"
        assert record is not None and record.access_log is not None

    def test_validation_sniffs_over_all_candidate_lines(
        self, tmp_path: Path, geoip_reader: Reader
    ) -> None:
        """One near-miss line among parseable ones must not degrade the file."""
        clf = (
            '2.125.160.216 - frank [03/Aug/2024:13:14:17 +0200] '
            '"GET /a.gif HTTP/1.0" 200 2326'
        )
        log_file = tmp_path / "mixed.log"
        log_file.write_text(
            "\n".join([clf, make_log_line("2.125.160.216"), make_log_line("2.125.160.216")])
            + "\n",
            encoding="utf-8",
        )
        parser = LogParser(log_path=log_file, send_logs=True, log_format="auto")

        assert parser.validate_log_format(log_file) is True
        assert parser.send_logs is True
        assert parser.format is not None and parser.format.name == "nginx"

    def test_traefik_json_still_sniffs_to_traefik(self, geoip_reader: Reader) -> None:
        import json

        line = json.dumps({
            "ClientHost": "2.125.160.216", "ClientAddr": "2.125.160.216:34567",
            "DownstreamContentSize": 1234, "DownstreamStatus": 200,
            "Duration": 45678900, "RequestHost": "app.example.com",
            "RequestMethod": "GET", "RequestPath": "/api/users",
            "RequestProtocol": "HTTP/2.0",
            "StartUTC": "2026-08-07T10:34:56.123456789Z",
            "level": "info", "msg": "", "time": "2026-08-07T10:34:56Z",
        })
        parser = LogParser(log_path=Path("/dev/null"), send_logs=True, log_format="auto")
        lookup = make_cached_city_lookup(geoip_reader)

        record = parser.parse_line(line, lookup)

        assert parser.send_logs is True
        assert parser.format is not None and parser.format.name == "traefik-json"
        assert record is not None and record.access_log is not None
        assert record.log_format == "traefik-json"


class TestAsnEnrichment:
    def test_make_cached_asn_lookup_returns_asn(self):
        from geometrikks.services.logparser.logparser import make_cached_asn_lookup

        with Reader("tests/GeoLite2-ASN-Test.mmdb") as reader:
            lookup = make_cached_asn_lookup(reader)
            result = lookup("1.128.0.0")
            assert result is not None
            assert result.autonomous_system_number == 1221
            assert result.autonomous_system_organization == "Telstra Pty Ltd"
            assert lookup("203.0.113.7") is None  # not in the test db, never raises

    def test_parsed_access_log_asn_fields_default_none(self):
        from datetime import datetime, timezone

        parsed = ParsedAccessLog(
            timestamp=datetime.now(timezone.utc), ip_address="1.2.3.4",
            remote_user=None, method="GET", url="/", http_version="HTTP/1.1",
            status_code=200, bytes_sent=0, referrer=None, user_agent=None,
            request_time=0.0, upstream_response_time=None, host=None,
            country_code=None, country_name=None, city=None,
        )
        assert parsed.autonomous_system_number is None
        assert parsed.autonomous_system_organization is None

    def test_parse_line_attaches_asn_to_access_log(self):
        """1.128.0.0 is only in the ASN test db, so the City side is faked:
        access-log rows require a City hit, and the assertion must not turn
        vacuous on a City-test-db miss."""
        from types import SimpleNamespace

        from geometrikks.services.logparser.logparser import make_cached_asn_lookup

        fake_city = SimpleNamespace(
            country=SimpleNamespace(iso_code="AU", name="Australia"),
            city=SimpleNamespace(name=None),
            location=SimpleNamespace(
                latitude=-33.5, longitude=143.2, time_zone="Australia/Sydney"
            ),
            subdivisions=SimpleNamespace(
                most_specific=SimpleNamespace(name=None, iso_code=None)
            ),
            postal=SimpleNamespace(code=None),
        )

        line = (
            '1.128.0.0 - - [07/Aug/2026:10:34:56 +0000] "GET / HTTP/1.1" 200 42 '
            '"-" example.com "curl/8.0" "0.001" "-"'
        )
        parser = LogParser(log_path=Path("/dev/null"), send_logs=True, log_format="nginx")
        with Reader("tests/GeoLite2-ASN-Test.mmdb") as asn_reader:
            asn_lookup = make_cached_asn_lookup(asn_reader)
            record = parser.parse_line(line, cast(Any, lambda ip: fake_city), asn_lookup)

        assert record is not None
        assert record.access_log is not None
        assert record.access_log.autonomous_system_number == 1221
        assert record.access_log.autonomous_system_organization == "Telstra Pty Ltd"


def make_gjson_line(ip: str) -> str:
    """One geometrikks-json line (the recommended nginx log_format, escape=json)."""
    return (
        '{"client_ip":"' + ip + '","timestamp":"2024-08-03T13:14:17+02:00","method":"GET",'
        '"path":"/index.php","protocol":"HTTP/2.0","status":"200","bytes":"1024",'
        '"host":"example.com","referrer":"","user_agent":"Mozilla/5.0","remote_user":"",'
        '"request_time":"0.002","upstream_time":"0.001","request_raw":"GET /index.php HTTP/2.0"}\n'
    )


def test_parse_line_geometrikks_json_end_to_end(tmp_path: Path, geoip_reader: Reader) -> None:
    """Geo data and the access log are assembled for the JSON format, not just normalized."""
    ip = "2.125.160.216"  # present in the GeoLite2 test database
    parser = LogParser(log_path=tmp_path / "access.json.log", send_logs=True, log_format="geometrikks-json")
    lookup = make_cached_city_lookup(geoip_reader)

    record = parser.parse_line(make_gjson_line(ip), lookup)

    assert record is not None
    assert record.ip_address == ip
    assert record.log_format == "geometrikks-json"
    assert record.is_malformed is False
    assert record.geo_data is not None
    assert record.geo_data.country_code == "GB"
    assert record.access_log is not None
    assert record.access_log.url == "/index.php"
    assert record.access_log.host == "example.com"
    assert record.access_log.status_code == 200
    assert record.access_log.request_time == pytest.approx(0.002)
    assert record.access_log.upstream_response_time == pytest.approx(0.001)
    offset = record.access_log.timestamp.utcoffset()
    assert offset is not None and offset.total_seconds() == 7200
    assert parser.parsed_lines == 1


def test_parse_line_geometrikks_json_auto_detects(tmp_path: Path, geoip_reader: Reader) -> None:
    parser = LogParser(log_path=tmp_path / "access.json.log", send_logs=True)
    lookup = make_cached_city_lookup(geoip_reader)
    record = parser.parse_line(make_gjson_line("2.125.160.216"), lookup)
    assert record is not None and record.ip_address == "2.125.160.216"
    assert parser.format is not None and parser.format.name == "geometrikks-json"
    assert parser.send_logs is True
