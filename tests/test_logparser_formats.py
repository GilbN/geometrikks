"""Tests for the log line format adapters."""
from datetime import datetime, timezone

from geometrikks.services.logparser.formats import FORMATS, sniff_format
from geometrikks.services.logparser.formats.nginx import NginxFormat

NGINX_LINE = (
    '203.0.113.7 - - [03/Aug/2024:13:14:17 +0200]"GET /admin HTTP/2.0" 200 1024'
    '"https://google.com/" example.com "Mozilla/5.0""0.002" "0.001"'
)
NGINX_GARBAGE = "not a log line at all\n"


def test_nginx_parse_full_line_corrected_semantics() -> None:
    """path comes from the request line; referrer from the Referer position."""
    norm = NginxFormat().parse(NGINX_LINE)
    assert norm is not None
    assert norm.ip_address == "203.0.113.7"
    assert norm.method == "GET"
    assert norm.path == "/admin"                      # was group 'referrer'
    assert norm.referrer == "https://google.com/"     # was group 'url'
    assert norm.host == "example.com"                 # stripped, no spaces
    assert norm.http_version == "HTTP/2.0"
    assert norm.status_code == 200
    assert norm.bytes_sent == 1024
    assert norm.user_agent == "Mozilla/5.0"
    assert norm.request_time == 0.002
    assert norm.upstream_response_time == 0.001
    assert norm.timestamp.isoformat() == "2024-08-03T13:14:17+02:00"


def test_nginx_parse_dash_fields_become_none() -> None:
    line = (
        '203.0.113.7 - - [03/Aug/2024:13:14:17 +0200]"GET /index.php HTTP/2.0" 200 1024"-" '
        'example.com "-""0.002" "-"'
    )
    norm = NginxFormat().parse(line)
    assert norm is not None
    assert norm.referrer is None
    assert norm.user_agent is None
    assert norm.upstream_response_time is None
    assert norm.remote_user is None


def test_nginx_parse_geo_only() -> None:
    norm = NginxFormat().parse(NGINX_LINE, geo_only=True)
    assert norm is not None
    assert norm.ip_address == "203.0.113.7"
    assert norm.timestamp.tzinfo is not None
    assert norm.method is None  # geo pattern captures no request data


def test_nginx_parse_unmatched_returns_none() -> None:
    assert NginxFormat().parse(NGINX_GARBAGE) is None


def test_nginx_detect_malformed_tls_probe() -> None:
    line = (
        '101.91.110.24 - - [23/Nov/2025:02:02:55 +0100]"\\x16\\x03\\x01\\x01-\\x01\\x00" 400 150'
        '"-" _ "-""0.362" "-"'
    )
    fmt = NginxFormat()
    norm = fmt.parse(line)
    assert norm is not None
    is_malformed, reason = fmt.detect_malformed(norm)
    assert is_malformed is True
    assert "TLS" in reason


def test_nginx_detect_malformed_nginx_statuses() -> None:
    fmt = NginxFormat()
    for status, fragment in ((444, "444"), (499, "499"), (408, "408")):
        line = (
            f'203.0.113.7 - - [03/Aug/2024:13:14:17 +0200]"GET / HTTP/1.1" {status} 0"-" '
            f'example.com "-""0.002" "-"'
        )
        norm = fmt.parse(line)
        assert norm is not None
        is_malformed, reason = fmt.detect_malformed(norm)
        assert is_malformed is True, f"status {status} should be malformed"
        assert fragment in reason


def test_nginx_detect_malformed_ok_line() -> None:
    fmt = NginxFormat()
    norm = fmt.parse(NGINX_LINE)
    assert fmt.detect_malformed(norm) == (False, None)


def test_registry_contains_nginx() -> None:
    assert "nginx" in FORMATS
    assert FORMATS["nginx"].name == "nginx"


def test_sniff_format_nginx() -> None:
    fmt = sniff_format([NGINX_GARBAGE, NGINX_LINE])
    assert fmt is not None and fmt.name == "nginx"


def test_sniff_format_unrecognized() -> None:
    assert sniff_format([NGINX_GARBAGE, "{}"]) is None
