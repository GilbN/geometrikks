import asyncio
import os
import re
import time
from pathlib import Path

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

    lookup = make_cached_city_lookup(CountingReader())  # type: ignore[arg-type]
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
    assert matched.group(1)  # IP captured


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
    assert matched.group(1) is not None
    # Should capture dateandtime
    assert matched.group("dateandtime") is not None

def test_validate_log_line_unmatched(log_parser: LogParser, load_unparseable_logs: list[str]) -> None:
    """Unparseable lines should not match when expecting full access-log format."""
    log_parser.send_logs = True
    for line in load_unparseable_logs:
        assert log_parser.validate_log_line(line) is None

def test_validate_log_format_true(tmp_path: Path, log_parser: LogParser, monkeypatch) -> None:
    """validate_log_format returns True when last lines contain valid format."""
    # Create a temp log file and copy some valid lines
    log_file = tmp_path / "access.log"
    valid_lines = Path("tests/valid_ipv4_log.txt").read_text(encoding="utf-8")
    log_file.write_text(valid_lines, encoding="utf-8")

    # Speed up wait decorator: monkeypatch time.sleep to no-op
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)

    # validate_log_format now takes log_path as parameter
    assert log_parser.validate_log_format(log_file) is True

def test_validate_log_format_false(tmp_path: Path, log_parser: LogParser, monkeypatch) -> None:
    """validate_log_format returns False when trailing lines are unparseable."""
    log_file = tmp_path / "access.log"
    unparseable = Path(UNPARSEABLE_LOG_PATH).read_text(encoding="utf-8")
    log_file.write_text(unparseable, encoding="utf-8")

    log_parser.send_logs = True
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)

    assert log_parser.validate_log_format(log_file) is False

def test_nonstandard_lines_match_loosened_pattern(load_nonstandard_logs: list[str], ipv4_log_pattern: re.Pattern[str]) -> None:
    """The loosened request group ([^"]*) accepts nonstandard/garbage requests so they
    can be flagged by _detect_malformed_request instead of being skipped."""
    for line in load_nonstandard_logs:
        assert ipv4_log_pattern.match(line) is not None


def test_binary_probe_flagged_malformed(log_parser: LogParser, load_nonstandard_logs: list[str], ipv4_log_pattern: re.Pattern[str]) -> None:
    """A binary probe (frp handshake) matches the pattern but is detected as malformed."""
    log_parser.send_logs = True
    line = next(ln for ln in load_nonstandard_logs if "\\x00\\x01" in ln)
    match = ipv4_log_pattern.match(line)
    assert match is not None
    is_malformed, error = log_parser._detect_malformed_request(match)
    assert is_malformed is True
    assert error == "No HTTP method in request"

@pytest.mark.asyncio
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


@pytest.mark.asyncio
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


@pytest.mark.asyncio
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
    """Successfully create AccessLog from a valid regex match and GeoIP lookup."""
    # Use a valid line from the IPv4 log
    line = Path("tests/valid_ipv4_log.txt").read_text(encoding="utf-8").splitlines()[0]
    match = ipv4_pattern().match(line)
    assert match is not None

    ip = match.group(1)
    lookup = make_cached_city_lookup(geoip_reader)
    access_log = log_parser._parse_access_log(match, ip, lookup)

    assert isinstance(access_log, ParsedAccessLog)
    assert access_log.country_code is not None
    assert access_log.bytes_sent >= 0
    assert access_log.request_time >= 0.0


def test_create_access_log_sqlalchemy_geoip_failure(log_parser: LogParser, monkeypatch) -> None:
    """Return None when GeoIP lookup fails."""
    line = Path("tests/valid_ipv4_log.txt").read_text(encoding="utf-8").splitlines()[0]
    match = ipv4_pattern().match(line)
    assert match is not None

    # Create a mock reader that raises an exception
    class MockReader:
        def city(self, ip):
            raise RuntimeError("geo lookup error")

    mock_reader = MockReader()
    ip = match.group(1)
    lookup = make_cached_city_lookup(mock_reader)  # type: ignore[arg-type]
    result = log_parser._parse_access_log(match, ip, lookup)
    assert result is None


@pytest.mark.asyncio
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
    assert record.ip_address is None
    assert record.geo_data is None
    assert record.access_log is None
    assert isinstance(record.raw_line, str)
    assert log_parser.skipped_lines_count() >= 1


@pytest.mark.asyncio
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
    assert record.ip_address is not None
    assert record.geo_data is not None
    assert record.access_log is not None
    assert isinstance(record.ip_address, str)
    assert log_parser.parsed_lines_count() >= 1


@pytest.mark.asyncio
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
    assert record.ip_address is not None
    assert record.access_log is not None


def test_parse_geo_data(log_parser: LogParser, geoip_reader: Reader) -> None:
    """_parse_geo_data builds a ParsedGeoData object with expected fields."""
    # Use a valid log line to get the match object
    valid_line = (
        Path("tests/valid_ipv4_log.txt").read_text(encoding="utf-8").splitlines()[0]
    )
    match = ipv4_pattern().match(valid_line)
    assert match is not None

    ip = match.group(1)
    lookup = make_cached_city_lookup(geoip_reader)
    parsed = log_parser._parse_geo_data(ip, match, lookup)

    # The IP should resolve to a location (test with real GeoIP DB)
    assert parsed is not None
    assert parsed.country_code is not None
    assert parsed.latitude is not None
    assert parsed.longitude is not None
    assert parsed.geohash is not None


@pytest.mark.asyncio
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
    assert record.source == str(log_file)


@pytest.mark.asyncio
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
        assert record.ip_address == "2.125.160.216"
        assert record.geo_data is not None
        assert record.access_log is not None
        assert parser.parsed_lines == 1

    def test_parse_line_garbage_is_malformed(self, geoip_reader):
        from geometrikks.services.logparser.logparser import LogParser, make_cached_city_lookup
        parser = LogParser(log_path=Path("/dev/null"), send_logs=True)
        lookup = make_cached_city_lookup(geoip_reader)
        record = parser.parse_line("total garbage\n", lookup)
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
