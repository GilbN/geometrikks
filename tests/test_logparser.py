import re
from pathlib import Path
from typing import Any, cast

import pytest
from geoip2.database import Reader

from geometrikks.services.logparser.constants import ipv4_pattern, ipv6_pattern
from geometrikks.services.logparser.logparser import (
    LogParser,
    check_ip_type,
    get_ip_type,
    make_cached_city_lookup,
)
from geometrikks.services.logparser.schemas import ParsedAccessLog, ParsedGeoData

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
    return LogParser(source_label=VALID_LOG_PATH, send_logs=True)


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

def test_lock_format_from_true(log_parser: LogParser) -> None:
    """lock_format_from returns True when the sample lines contain valid format."""
    lines = Path("tests/valid_ipv4_log.txt").read_text(encoding="utf-8").splitlines()

    assert log_parser.lock_format_from(lines[-3:]) is True


def test_lock_format_from_false(log_parser: LogParser) -> None:
    """lock_format_from returns False when the sample lines are unparseable."""
    lines = Path(UNPARSEABLE_LOG_PATH).read_text(encoding="utf-8").splitlines()

    assert log_parser.lock_format_from(lines[-3:]) is False
    assert log_parser.lock_format_from([]) is False


def test_parse_line_unmatched(log_parser: LogParser, geoip_reader: Reader) -> None:
    """An invalid line yields a record with no IP and increments skipped."""
    record = log_parser.parse_line("not-a-valid-access-log-line\n", make_cached_city_lookup(geoip_reader))

    assert record is not None
    assert record.ip_address is None
    assert record.geo_data is None
    assert record.access_log is None
    assert isinstance(record.raw_line, str)
    assert log_parser.skipped_lines_count() >= 1


def test_parse_line_matched(log_parser: LogParser, geoip_reader: Reader) -> None:
    """A valid line yields a parsed record; access_log when send_logs=True."""
    valid_line = Path("tests/valid_ipv4_log.txt").read_text(encoding="utf-8").splitlines()[0]

    record = log_parser.parse_line(valid_line + "\n", make_cached_city_lookup(geoip_reader))

    assert record is not None
    assert record.ip_address is not None
    assert record.geo_data is not None
    assert record.access_log is not None
    assert log_parser.parsed_lines_count() >= 1


def test_parse_line_geometrikks_json_survives_undecodable_bytes(geoip_reader: Reader) -> None:
    """The decoded line still classifies as the raw-bytes TLS probe."""
    parser = LogParser(source_label="/dev/null", send_logs=True, log_format="geometrikks-json")
    lookup = make_cached_city_lookup(geoip_reader)
    line = GJSON_TLS_PROBE_LINE_BYTES.decode("utf-8", errors="replace")

    record = parser.parse_line(line, lookup)

    assert record is not None
    assert record.is_malformed is True
    assert record.parse_error == "TLS handshake sent to HTTP port (raw)"


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
    assert access_log.request_time is not None and access_log.request_time >= 0.0


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


class TestParseLine:
    def test_parse_line_tags_source_label(self, geoip_reader):
        """Every record carries the label of the source it was read from."""
        parser = LogParser(source_label="/logs/a.log", send_logs=True)
        lookup = make_cached_city_lookup(geoip_reader)

        matched = parser.parse_line(make_log_line("2.125.160.216"), lookup)
        unmatched = parser.parse_line("garbage", lookup)

        assert matched is not None and matched.source == "/logs/a.log"
        assert unmatched is not None and unmatched.source == "/logs/a.log"

    def test_parser_has_no_file_state(self):
        parser = LogParser(source_label="x")
        for gone in (
            "log_path", "poll_interval", "file_missing", "set_stop_event",
            "validate_log_format", "await_valid_log_format", "iter_parsed_records",
        ):
            assert not hasattr(parser, gone), gone

    def test_parse_line_valid(self, geoip_reader):
        from geometrikks.services.logparser.logparser import LogParser, make_cached_city_lookup
        parser = LogParser(source_label="/dev/null", send_logs=True)
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
        parser = LogParser(source_label="/dev/null", send_logs=True)
        lookup = make_cached_city_lookup(geoip_reader)
        record = parser.parse_line("total garbage\n", lookup)
        assert record is not None
        assert record.is_malformed is True
        assert record.ip_address is None
        assert parser.skipped_lines == 1

    def test_parse_line_ignored_exact_ip(self, geoip_reader):
        from geometrikks.services.logparser.logparser import LogParser, make_cached_city_lookup
        parser = LogParser(
            source_label="/dev/null", send_logs=True, ignore_ips=["2.125.160.216"]
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
            source_label="/dev/null", send_logs=True, ignore_ips=["2.125.160.0/24"]
        )
        lookup = make_cached_city_lookup(geoip_reader)
        record = parser.parse_line(make_log_line("2.125.160.216"), lookup)
        assert record is None
        assert parser.ignored_lines == 1

    def test_parse_line_ignored_ipv6_cidr(self, geoip_reader):
        from geometrikks.services.logparser.logparser import LogParser, make_cached_city_lookup
        parser = LogParser(
            source_label="/dev/null", send_logs=True, ignore_ips=["2001:db8::/32"]
        )
        lookup = make_cached_city_lookup(geoip_reader)
        record = parser.parse_line(make_log_line("2001:db8::1"), lookup)
        assert record is None
        assert parser.ignored_lines == 1

    def test_parse_line_non_matching_ip_passes(self, geoip_reader):
        from geometrikks.services.logparser.logparser import LogParser, make_cached_city_lookup
        parser = LogParser(
            source_label="/dev/null", send_logs=True, ignore_ips=["203.0.113.0/24"]
        )
        lookup = make_cached_city_lookup(geoip_reader)
        record = parser.parse_line(make_log_line("2.125.160.216"), lookup)
        assert record is not None
        assert record.ip_address == "2.125.160.216"
        assert parser.ignored_lines == 0
        assert parser.parsed_lines == 1

    def test_parse_line_empty_ignore_list_noop(self, geoip_reader):
        from geometrikks.services.logparser.logparser import LogParser, make_cached_city_lookup
        parser = LogParser(source_label="/dev/null", send_logs=True)
        lookup = make_cached_city_lookup(geoip_reader)
        record = parser.parse_line(make_log_line("2.125.160.216"), lookup)
        assert record is not None
        assert parser.ignored_lines == 0

    def test_parse_line_leaves_the_hostname_to_the_caller(self, geoip_reader):
        from geometrikks.services.logparser.logparser import LogParser, make_cached_city_lookup
        parser = LogParser(source_label="/dev/null", send_logs=True)
        lookup = make_cached_city_lookup(geoip_reader)
        matched = parser.parse_line(make_log_line("2.125.160.216"), lookup)
        unmatched = parser.parse_line("total garbage\n", lookup)
        assert matched is not None and matched.hostname == ""
        assert unmatched is not None and unmatched.hostname == ""

    def test_parse_line_default_hostname_is_empty(self, geoip_reader):
        from geometrikks.services.logparser.logparser import LogParser, make_cached_city_lookup
        parser = LogParser(source_label="/dev/null", send_logs=True)
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
        parser = LogParser(source_label="/dev/null", send_logs=True, log_format="auto")
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
        parser = LogParser(source_label="/dev/null", send_logs=True, log_format="auto")
        lookup = make_cached_city_lookup(geoip_reader)

        record = parser.parse_line(make_log_line("2.125.160.216"), lookup)

        assert parser.send_logs is True
        assert parser.format is not None and parser.format.name == "nginx"
        assert record is not None and record.access_log is not None

    def test_validation_sniffs_over_all_candidate_lines(self) -> None:
        """One near-miss line among parseable ones must not degrade the file."""
        clf = (
            '2.125.160.216 - frank [03/Aug/2024:13:14:17 +0200] '
            '"GET /a.gif HTTP/1.0" 200 2326'
        )
        parser = LogParser(source_label="mixed.log", send_logs=True, log_format="auto")

        assert parser.lock_format_from(
            [clf, make_log_line("2.125.160.216"), make_log_line("2.125.160.216")]
        ) is True
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
        parser = LogParser(source_label="/dev/null", send_logs=True, log_format="auto")
        lookup = make_cached_city_lookup(geoip_reader)

        record = parser.parse_line(line, lookup)

        assert parser.send_logs is True
        assert parser.format is not None and parser.format.name == "traefik-json"
        assert record is not None and record.access_log is not None
        assert record.log_format == "traefik-json"


def _fake_city_au():
    from types import SimpleNamespace

    return SimpleNamespace(
        country=SimpleNamespace(iso_code="AU", name="Australia"),
        city=SimpleNamespace(name=None),
        location=SimpleNamespace(latitude=-33.5, longitude=143.2, time_zone="Australia/Sydney"),
        subdivisions=SimpleNamespace(most_specific=SimpleNamespace(name=None, iso_code=None)),
        postal=SimpleNamespace(code=None),
    )


ASN_TEST_LINE = (
    '1.128.0.0 - - [07/Aug/2026:10:34:56 +0000] "GET / HTTP/1.1" 200 42 '
    '"-" example.com "curl/8.0" "0.001" "-"'
)


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
        from geometrikks.services.logparser.logparser import make_cached_asn_lookup

        parser = LogParser(source_label="/dev/null", send_logs=True, log_format="nginx")
        with Reader("tests/GeoLite2-ASN-Test.mmdb") as asn_reader:
            asn_lookup = make_cached_asn_lookup(asn_reader)
            record = parser.parse_line(
                ASN_TEST_LINE, cast(Any, lambda ip: _fake_city_au()), asn_lookup
            )

        assert record is not None
        assert record.access_log is not None
        assert record.access_log.autonomous_system_number == 1221
        assert record.access_log.autonomous_system_organization == "Telstra Pty Ltd"

    def test_parse_line_attaches_asn_to_geo_data_in_geo_only_mode(self):
        """send_logs=False writes no access log, so the geo record must carry
        the ASN itself or geo-only installs never get one."""
        from geometrikks.services.logparser.logparser import make_cached_asn_lookup

        parser = LogParser(source_label="/dev/null", send_logs=False, log_format="nginx")
        with Reader("tests/GeoLite2-ASN-Test.mmdb") as asn_reader:
            record = parser.parse_line(
                ASN_TEST_LINE, cast(Any, lambda ip: _fake_city_au()),
                make_cached_asn_lookup(asn_reader),
            )

        assert record is not None
        assert record.access_log is None
        assert record.geo_data is not None
        assert record.geo_data.autonomous_system_number == 1221
        assert record.geo_data.autonomous_system_organization == "Telstra Pty Ltd"

    def test_parse_line_resolves_the_asn_once_for_both_records(self):
        calls: list[str] = []

        def counting_lookup(ip: str):
            calls.append(ip)
            with Reader("tests/GeoLite2-ASN-Test.mmdb") as reader:
                return reader.asn(ip)

        parser = LogParser(source_label="/dev/null", send_logs=True, log_format="nginx")
        record = parser.parse_line(
            ASN_TEST_LINE, cast(Any, lambda ip: _fake_city_au()), cast(Any, counting_lookup)
        )

        assert record is not None
        assert record.geo_data is not None and record.access_log is not None
        assert record.geo_data.autonomous_system_number == 1221
        assert record.access_log.autonomous_system_number == 1221
        assert calls == ["1.128.0.0"]

    def test_parsed_geo_data_asn_fields_default_none(self):
        from datetime import datetime, timezone

        geo = ParsedGeoData(
            latitude=1.0, longitude=2.0, geohash="s00", country_code="AU",
            country_name="Australia", timestamp=datetime.now(timezone.utc),
        )
        assert geo.autonomous_system_number is None
        assert geo.autonomous_system_organization is None


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
    parser = LogParser(source_label=str(tmp_path / "access.json.log"), send_logs=True, log_format="geometrikks-json")
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
    parser = LogParser(source_label=str(tmp_path / "access.json.log"), send_logs=True)
    lookup = make_cached_city_lookup(geoip_reader)
    record = parser.parse_line(make_gjson_line("2.125.160.216"), lookup)
    assert record is not None and record.ip_address == "2.125.160.216"
    assert parser.format is not None and parser.format.name == "geometrikks-json"
    assert parser.send_logs is True


def make_caddy_line(ip: str) -> str:
    """One Caddy JSON access-log line (zap encoder defaults)."""
    return (
        '{"level":"info","ts":1722683657.123,"logger":"http.log.access.log0","msg":"handled request",'
        '"request":{"remote_ip":"' + ip + '","remote_port":"56002","client_ip":"' + ip + '",'
        '"proto":"HTTP/2.0","method":"GET","host":"caddy.example.com","uri":"/index.php",'
        '"headers":{"User-Agent":["Mozilla/5.0"]}},'
        '"bytes_read":0,"user_id":"","duration":0.002,"upstream_duration_ms":1.25,'
        '"size":1024,"status":200,'
        '"resp_headers":{"Server":["Caddy"]}}\n'
    )


def test_parse_line_caddy_json_end_to_end(tmp_path: Path, geoip_reader: Reader) -> None:
    """Geo data and the access log are assembled for the Caddy format."""
    ip = "2.125.160.216"  # present in the GeoLite2 test database
    parser = LogParser(source_label=str(tmp_path / "caddy.log"), send_logs=True, log_format="caddy-json")
    lookup = make_cached_city_lookup(geoip_reader)

    record = parser.parse_line(make_caddy_line(ip), lookup)

    assert record is not None
    assert record.ip_address == ip
    assert record.log_format == "caddy-json"
    assert record.is_malformed is False
    assert record.geo_data is not None
    assert record.geo_data.country_code == "GB"
    assert record.access_log is not None
    assert record.access_log.url == "/index.php"
    assert record.access_log.host == "caddy.example.com"
    assert record.access_log.status_code == 200
    assert record.access_log.request_time == pytest.approx(0.002)
    assert record.access_log.upstream_response_time == pytest.approx(0.00125)
    offset = record.access_log.timestamp.utcoffset()
    assert offset is not None and offset.total_seconds() == 0
    assert parser.parsed_lines == 1


def test_parse_line_caddy_json_auto_detects(tmp_path: Path, geoip_reader: Reader) -> None:
    parser = LogParser(source_label=str(tmp_path / "caddy.log"), send_logs=True)
    lookup = make_cached_city_lookup(geoip_reader)
    record = parser.parse_line(make_caddy_line("2.125.160.216"), lookup)
    assert record is not None and record.ip_address == "2.125.160.216"
    assert parser.format is not None and parser.format.name == "caddy-json"
    assert parser.send_logs is True
