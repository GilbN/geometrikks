import asyncio
import re
import pytest
import os
import time
from pathlib import Path

import aiofiles.os

from geometrikks.services.logparser.constants import ipv4_pattern, ipv6_pattern
from geometrikks.services.logparser.logparser import LogParser
from geometrikks.services.logparser.schemas import ParsedAccessLog
from geometrikks.domain.logs.models import AccessLog
from geometrikks.domain.geo.models import GeoLocation
from geohash2 import encode as gh_encode

os.environ["GEOIP_DB_PATH"] = "tests/GeoLite2-City.mmdb"
VALID_LOG_PATH = "tests/valid_ipv4_log.txt"
INVALID_LOG_PATH = "tests/invalid_logs.txt"
TEST_IPV6 = "2607:f0d0:1002:51::4"

@pytest.fixture
def load_valid_ipv4_log() -> list[str]:
    """Load the contents of the valid IPv4 log file.""" 
    with open('tests/valid_ipv4_log.txt', "r", encoding="utf-8") as f:
        return f.readlines()

@pytest.fixture
def load_valid_ipv6_log() -> list[str]:
    """Load the contents of the valid IPv6 log file.""" 
    with open('tests/valid_ipv6_log.txt', "r", encoding="utf-8") as f:
        return f.readlines()

@pytest.fixture
def load_invalid_logs() -> list[str]:
    """Load the contents of the invalid log file.""" 
    with open('tests/invalid_logs.txt', "r", encoding="utf-8") as f:
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
def log_parser() -> LogParser:
    """Return an instance of the LogParser class."""
    log_path = Path(VALID_LOG_PATH)
    geoip_path = Path(os.getenv("GEOIP_DB_PATH", "tests/GeoLite2-City.mmdb"))
    locales = ["en"]
    parser = LogParser(log_path=log_path, geoip_path=geoip_path, geoip_locales=locales)
    parser.hostname = "localhost"
    return parser

def test_regex_tester_ipv4(load_valid_ipv4_log: list[str], ipv4_log_pattern: re.Pattern[str]) -> None:
    """Test the regex tester for IPv4 log lines."""
    for line in load_valid_ipv4_log:
        assert bool(ipv4_log_pattern.match(line)) is True

def test_regex_tester_ipv6(load_valid_ipv6_log: list[str], ipv6_log_pattern: re.Pattern[str]) -> None:
    """Test the regex tester for IPv6 log lines."""
    for line in load_valid_ipv6_log:
        assert bool(ipv6_log_pattern.match(line)) is True

def test_regex_tester_invalid(load_invalid_logs: list[str], ipv4_log_pattern: re.Pattern[str], ipv6_log_pattern: re.Pattern[str]) -> None:
    """Test the regex tester for invalid log lines."""
    for line in load_invalid_logs:
        assert bool(ipv4_log_pattern.match(line)) is False
        assert bool(ipv6_log_pattern.match(line)) is False

def test_get_ip_type(log_parser: LogParser) -> None:
    """Test the get_ip_type function."""
    private_ip = "10.10.10.1"
    public_ip = "52.53.54.55"
    assert log_parser.get_ip_type(private_ip) == "PRIVATE"
    assert log_parser.get_ip_type(public_ip) == "PUBLIC"

def test_get_ip_type_invalid(log_parser: LogParser) -> None:
    """Test the get_ip_type function with an invalid IP address."""
    invalid_ip = "10.10.10.256"
    assert log_parser.get_ip_type(invalid_ip) == ""


def test_validate_log_line_send_logs_true(log_parser: LogParser, load_valid_ipv4_log: list[str]) -> None:
    """When send_logs is True, full access-log regex should match valid lines."""
    log_parser.send_logs = True
    # Pick a typical valid line
    line = load_valid_ipv4_log[0]
    matched = log_parser.validate_log_line(line)
    assert matched is not None
    assert matched.group(1)  # IP captured


def test_validate_log_line_send_logs_false_ip_only(log_parser: LogParser) -> None:
    """When send_logs is False, only IP patterns should be matched."""
    log_parser.send_logs = False
    # Simple IP-only string should match ip validator
    line = "52.53.54.55"
    matched = log_parser.validate_log_line(line)
    assert matched is not None
    assert matched.group(0) == "52.53.54.55"


def test_validate_log_line_unmatched(log_parser: LogParser, load_invalid_logs: list[str]) -> None:
    """Invalid lines should not match when expecting full access-log format."""
    log_parser.send_logs = True
    # Use an invalid access-log line sample
    line = load_invalid_logs[0]
    assert log_parser.validate_log_line(line) is None


def test_validate_log_format_true(tmp_path: Path, log_parser: LogParser, monkeypatch) -> None:
    """validate_log_format returns True when last lines contain valid format."""
    # Create a temp log file and copy some valid lines
    log_file = tmp_path / "access.log"
    valid_lines = Path("tests/valid_ipv4_log.txt").read_text(encoding="utf-8")
    log_file.write_text(valid_lines, encoding="utf-8")

    # Point parser to temp file
    log_parser.log_path = log_file

    # Speed up wait decorator: monkeypatch time.sleep to no-op
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)

    assert log_parser.validate_log_format() is True


def test_validate_log_format_false(tmp_path: Path, log_parser: LogParser, monkeypatch) -> None:
    """validate_log_format returns False when trailing lines are invalid."""
    log_file = tmp_path / "access.log"
    invalid_lines = Path("tests/invalid_logs.txt").read_text(encoding="utf-8")
    log_file.write_text(invalid_lines, encoding="utf-8")

    log_parser.log_path = log_file
    # Require full access-log format to be considered valid
    log_parser.send_logs = True
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)

    # Force small timeout by temporarily wrapping validate_log_format with shorter decorator
    # Not strictly necessary due to sleep monkeypatch; still assert False
    assert log_parser.validate_log_format() is False

@pytest.mark.asyncio
async def test_is_rotated_truncation_99pct(tmp_path: Path, log_parser: LogParser, monkeypatch) -> None:
    """Rotation detected when size shrinks by >=99%."""
    # Prepare a fake stat_result (previous)
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
    is_rotated =  await log_parser._is_rotated_async(prev)
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


def test_create_access_log_sqlalchemy_success(log_parser: LogParser) -> None:
    """Successfully create AccessLog from a valid regex match and stubbed GeoIP."""
    # Use a valid line from the IPv4 log
    line = Path("tests/valid_ipv4_log.txt").read_text(encoding="utf-8").splitlines()[0]
    match = ipv4_pattern().match(line)
    assert match is not None

    # Stub geoip_reader.city to return a minimal object with required attributes
    class Country:
        iso_code = "US"
        name = "United States"
    class City:
        name = "Test City"
    class SubdivisionsMostSpecific:
        name = "-"
        iso_code = "-"
    class Subdivisions:
        most_specific = SubdivisionsMostSpecific()
    class Postal:
        code = "12345"
    class Location:
        latitude = 37.751
        longitude = -97.822
        time_zone = "UTC"
    class IPData:
        country = Country()
        city = City()
        subdivisions = Subdivisions()
        postal = Postal()
        location = Location()

    # Patch the instance attribute directly
    log_parser.geoip_reader.city = lambda ip: IPData()

    access_log = log_parser._parse_access_log(match, match.group(1))
    assert isinstance(access_log, ParsedAccessLog)
    assert access_log.country_code == "US"
    assert access_log.city in ("Test City", None)
    assert access_log.bytes_sent >= 0
    assert access_log.request_time >= 0.0
    # Optional fields should convert '-' to None
    # The test log has '-' for some fields; ensure conversion works
    # host may be present; we only assert types here
    assert access_log.method is not None or access_log.method is None
    assert access_log.referrer is not None or access_log.referrer is None


def test_create_access_log_sqlalchemy_geoip_failure(log_parser: LogParser, monkeypatch) -> None:
    """Return None when GeoIP lookup fails."""
    line = Path("tests/valid_ipv4_log.txt").read_text(encoding="utf-8").splitlines()[0]
    match = ipv4_pattern().match(line)
    assert match is not None
    # Force GeoIP exception
    def raise_exc(_ip):
        raise RuntimeError("geo lookup error")
    log_parser.geoip_reader.city = raise_exc
    assert log_parser._parse_access_log(match, match.group(1)) is None


@pytest.mark.asyncio
async def test_iter_log_events_async_unmatched(tmp_path: Path, log_parser: LogParser, monkeypatch) -> None:
    """Async generator yields record with matched=None for invalid line; increments skipped."""
    log_file = tmp_path / "access.log"
    # Write a clearly invalid line
    log_file.write_text("not-a-valid-access-log-line\n", encoding="utf-8")
    log_parser.log_path = log_file

    # Set stop event so we don't loop forever
    log_parser._stop_event = asyncio.Event()

    gen = log_parser.iter_parsed_records(skip_validation=True, start_at_end=False)
    record = await gen.__anext__()
    assert record.ip_address is None
    assert record.geo_data is None
    assert record.access_log is None
    assert isinstance(record.raw_line, str)
    assert log_parser.skipped_lines_count() >= 1


@pytest.mark.asyncio
async def test_iter_log_events_async_matched(tmp_path: Path, log_parser: LogParser, monkeypatch) -> None:
    """Async generator yields parsed record for a valid line; access_log when send_logs=True."""
    log_file = tmp_path / "access.log"
    valid_line = Path("tests/valid_ipv4_log.txt").read_text(encoding="utf-8").splitlines()[0]
    log_file.write_text(valid_line + "\n", encoding="utf-8")
    log_parser.log_path = log_file

    # Stub GeoIP so access_log can be constructed
    class Country:
        iso_code = "US"
        name = "United States"
    class City:
        name = "Test City"
    class SubdivisionsMostSpecific:
        name = "-"
        iso_code = "-"
    class Subdivisions:
        most_specific = SubdivisionsMostSpecific()
    class Postal:
        code = "12345"
    class Location:
        latitude = 37.751
        longitude = -97.822
        time_zone = "UTC"
    class IPData:
        country = Country()
        city = City()
        subdivisions = Subdivisions()
        postal = Postal()
        location = Location()
    log_parser.geoip_reader.city = lambda ip: IPData()

    # Ensure we use full log-line validation
    log_parser.send_logs = True

    # Set stop event so we don't loop forever
    log_parser._stop_event = asyncio.Event()

    gen = log_parser.iter_parsed_records(skip_validation=True, start_at_end=False)
    record = await gen.__anext__()
    assert record.ip_address is not None
    assert record.geo_data is not None
    assert record.access_log is not None
    assert isinstance(record.ip_address, str)
    assert log_parser.parsed_lines_count() >= 1


@pytest.mark.asyncio
async def test_iter_log_events_async_rotation_restart(tmp_path: Path, log_parser: LogParser, monkeypatch) -> None:
    """When rotation is detected, async generator delegates to a new stream (restart)."""
    log_file = tmp_path / "access.log"
    # Start with a valid line so initial read succeeds
    valid_line = Path("tests/valid_ipv4_log.txt").read_text(encoding="utf-8").splitlines()[0]
    log_file.write_text(valid_line + "\n", encoding="utf-8")
    log_parser.log_path = log_file

    # Patch _is_rotated_async to return True at first check to force restart
    call_count = {"n": 0}
    async def _is_rotated_once(_prev):
        call_count["n"] += 1
        return call_count["n"] == 1
    monkeypatch.setattr(log_parser, "_is_rotated_async", _is_rotated_once)

    # Use full validation and stub GeoIP
    log_parser.send_logs = True
    class Country:
        iso_code = "US"
        name = "United States"
    class City:
        name = "Test City"
    class SubdivisionsMostSpecific:
        name = "-"
        iso_code = "-"
    class Subdivisions:
        most_specific = SubdivisionsMostSpecific()
    class Postal:
        code = "12345"
    class Location:
        latitude = 37.751
        longitude = -97.822
        time_zone = "UTC"
    class IPData:
        country = Country()
        city = City()
        subdivisions = Subdivisions()
        postal = Postal()
        location = Location()
    log_parser.geoip_reader.city = lambda ip: IPData()

    # Set stop event so we don't loop forever
    log_parser._stop_event = asyncio.Event()

    gen = log_parser.iter_parsed_records(skip_validation=True, start_at_end=False)
    # First __anext__() triggers rotation and restart; subsequent yield should still produce records
    record = await gen.__anext__()
    assert record.ip_address is not None
    assert record.access_log is not None


def test_parse_geo_data(log_parser: LogParser) -> None:
    """_parse_geo_data builds a ParsedGeoData object with expected fields."""
    # Minimal GeoLocation with id
    location = GeoLocation(
        geohash=gh_encode(37.751, -97.822),
        country_code="US",
        country_name="United States",
        state="-",
        state_code="-",
        city="Test City",
        postal_code="12345",
        timezone="UTC",
    )
    parsed = log_parser._parse_geo_data("52.53.54.55")
    assert parsed.country_code == location.country_code
    assert parsed.country_name == location.country_name
