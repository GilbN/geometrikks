"""Tests for the log line format adapters."""
import json
from datetime import datetime, timezone

import pytest

from geometrikks.services.logparser.formats import FORMATS, sniff_format
from geometrikks.services.logparser.formats.nginx import NginxFormat
from geometrikks.services.logparser.formats.traefik import TraefikJsonFormat

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
    assert reason is not None
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
        assert reason is not None
        assert fragment in reason


def test_nginx_detect_malformed_ok_line() -> None:
    fmt = NginxFormat()
    norm = fmt.parse(NGINX_LINE)
    assert norm is not None
    assert fmt.detect_malformed(norm) == (False, None)


def test_registry_contains_nginx() -> None:
    assert "nginx" in FORMATS
    assert FORMATS["nginx"].name == "nginx"


def test_sniff_format_nginx() -> None:
    sniffed = sniff_format([NGINX_GARBAGE, NGINX_LINE])
    assert sniffed is not None
    assert sniffed.format.name == "nginx"
    assert sniffed.geo_only is False


def test_sniff_format_unrecognized() -> None:
    assert sniff_format([NGINX_GARBAGE, "{}"]) is None


# Apache/nginx common log format: the geo-only pattern matches the
# 'IP - user [date]' prefix, the full custom-format pattern does not.
CLF_LINE = '203.0.113.7 - frank [03/Aug/2024:13:14:17 +0200] "GET /a.gif HTTP/1.0" 200 2326'


def test_sniff_format_clf_line_is_geo_only() -> None:
    sniffed = sniff_format([CLF_LINE])
    assert sniffed is not None
    assert sniffed.format.name == "nginx"
    assert sniffed.geo_only is True


def test_sniff_format_full_match_wins_over_earlier_geo_only_line() -> None:
    """A near-miss line must not lock the file into geo-only mode."""
    sniffed = sniff_format([CLF_LINE, NGINX_LINE])
    assert sniffed is not None
    assert sniffed.format.name == "nginx"
    assert sniffed.geo_only is False


TRAEFIK_FULL = json.dumps({
    "ClientAddr": "172.19.0.1:34567", "ClientHost": "203.0.113.7",
    "ClientPort": "34567", "ClientUsername": "-",
    "DownstreamContentSize": 1234, "DownstreamStatus": 200,
    "Duration": 45678900, "OriginContentSize": 1234,
    "OriginDuration": 43210000, "OriginStatus": 200, "Overhead": 2468900,
    "RequestAddr": "app.example.com", "RequestContentSize": 0,
    "RequestCount": 42, "RequestHost": "app.example.com",
    "RequestMethod": "GET", "RequestPath": "/api/users?page=2",
    "RequestPort": "-", "RequestProtocol": "HTTP/2.0",
    "RequestScheme": "https", "RetryAttempts": 0,
    "RouterName": "app@docker", "ServiceAddr": "172.19.0.5:8080",
    "ServiceName": "app@docker", "ServiceURL": "http://172.19.0.5:8080",
    "StartLocal": "2026-08-07T12:34:56.123456789+02:00",
    "StartUTC": "2026-08-07T10:34:56.123456789Z",
    "entryPointName": "websecure", "level": "info", "msg": "",
    "time": "2026-08-07T10:34:56Z",
    "request_User-Agent": "Mozilla/5.0", "request_Referer": "https://ref.example/",
})


def test_traefik_parse_full_line() -> None:
    norm = TraefikJsonFormat().parse(TRAEFIK_FULL)
    assert norm is not None
    assert norm.ip_address == "203.0.113.7"
    assert norm.method == "GET"
    assert norm.path == "/api/users?page=2"
    assert norm.http_version == "HTTP/2.0"
    assert norm.status_code == 200
    assert norm.bytes_sent == 1234
    assert norm.host == "app.example.com"
    assert norm.user_agent == "Mozilla/5.0"
    assert norm.referrer == "https://ref.example/"
    assert norm.remote_user is None                       # "-" collapses
    assert norm.request_time == pytest.approx(0.0456789)  # ns -> s
    assert norm.upstream_response_time == pytest.approx(0.04321)
    assert norm.timestamp.isoformat().startswith("2026-08-07T10:34:56.123456")
    assert norm.timestamp.tzinfo is not None


def test_traefik_parse_headers_dropped() -> None:
    """Default Traefik config drops headers: UA/Referer keys absent entirely."""
    data = json.loads(TRAEFIK_FULL)
    del data["request_User-Agent"], data["request_Referer"]
    norm = TraefikJsonFormat().parse(json.dumps(data))
    assert norm is not None
    assert norm.user_agent is None
    assert norm.referrer is None


def test_traefik_parse_xff_chain_takes_first_hop() -> None:
    data = json.loads(TRAEFIK_FULL)
    data["ClientHost"] = "203.0.113.7, 10.0.0.2"
    norm = TraefikJsonFormat().parse(json.dumps(data))
    assert norm is not None
    assert norm.ip_address == "203.0.113.7"


def test_traefik_parse_ipv6_client_falls_back_to_clientaddr() -> None:
    data = json.loads(TRAEFIK_FULL)
    data["ClientHost"] = ""
    data["ClientAddr"] = "[2001:db8::1]:53324"
    norm = TraefikJsonFormat().parse(json.dumps(data))
    assert norm is not None
    assert norm.ip_address == "2001:db8::1"


def test_traefik_parse_startlocal_fallback() -> None:
    data = json.loads(TRAEFIK_FULL)
    del data["StartUTC"]
    norm = TraefikJsonFormat().parse(json.dumps(data))
    assert norm is not None
    offset = norm.timestamp.utcoffset()
    assert offset is not None
    assert offset.total_seconds() == 7200


def test_traefik_parse_origin_zero_means_no_upstream() -> None:
    data = json.loads(TRAEFIK_FULL)
    data["OriginDuration"] = 0
    data["OriginStatus"] = 0
    norm = TraefikJsonFormat().parse(json.dumps(data))
    assert norm is not None
    assert norm.upstream_response_time is None


def test_traefik_parse_fields_dropped_junk_line_skipped() -> None:
    """fields.defaultMode: drop leaves only logrus keys; not parseable."""
    assert TraefikJsonFormat().parse('{"level":"info","msg":"","time":"2026-08-07T10:34:56Z"}') is None


def test_traefik_parse_non_json_returns_none() -> None:
    assert TraefikJsonFormat().parse(NGINX_LINE) is None
    assert TraefikJsonFormat().parse("{broken json") is None


def test_traefik_geo_only_needs_ip_and_timestamp() -> None:
    data = {"ClientHost": "203.0.113.7", "StartUTC": "2026-08-07T10:34:56Z",
            "level": "info", "msg": "", "time": "2026-08-07T10:34:56Z"}
    norm = TraefikJsonFormat().parse(json.dumps(data), geo_only=True)
    assert norm is not None
    assert norm.ip_address == "203.0.113.7"


def test_traefik_detect_malformed_method_only() -> None:
    fmt = TraefikJsonFormat()
    norm = fmt.parse(TRAEFIK_FULL)
    assert norm is not None
    assert fmt.detect_malformed(norm) == (False, None)
    data = json.loads(TRAEFIK_FULL)
    data["RequestMethod"] = "BOGUS"
    norm = fmt.parse(json.dumps(data))
    assert norm is not None
    is_malformed, reason = fmt.detect_malformed(norm)
    assert is_malformed is True
    assert reason is not None
    assert "BOGUS" in reason
    # nginx-specific status heuristics must NOT apply
    data = json.loads(TRAEFIK_FULL)
    data["DownstreamStatus"] = 499
    norm = fmt.parse(json.dumps(data))
    assert norm is not None
    assert fmt.detect_malformed(norm) == (False, None)


def test_sniff_format_traefik_before_nginx() -> None:
    sniffed = sniff_format([TRAEFIK_FULL])
    assert sniffed is not None
    assert sniffed.format.name == "traefik-json"
    assert sniffed.geo_only is False
