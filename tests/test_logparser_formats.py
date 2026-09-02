"""Tests for the log line format adapters."""
import json
from datetime import datetime, timedelta, timezone

import pytest

from geometrikks.services.logparser.formats import FORMATS, sniff_format
from geometrikks.services.logparser.formats.base import (
    detect_probe,
    host_from_addr,
    parse_seconds,
)
from geometrikks.services.logparser.formats.caddy import CaddyJsonFormat
from geometrikks.services.logparser.formats.geometrikks_json import GeometrikksJsonFormat
from geometrikks.services.logparser.formats.nginx import NginxFormat
from geometrikks.services.logparser.formats.traefik import TraefikJsonFormat

NGINX_LINE = (
    '203.0.113.7 - - [03/Aug/2024:13:14:17 +0200]"GET /admin HTTP/2.0" 200 1024'
    '"https://google.com/" example.com "Mozilla/5.0""0.002" "0.001"'
)
NGINX_GARBAGE = "not a log line at all\n"

SUPPORTED_HTTP_METHODS = (
    "GET",
    "POST",
    "PUT",
    "DELETE",
    "PATCH",
    "HEAD",
    "OPTIONS",
    "CONNECT",
    "TRACE",
    "PROPFIND",
    "PROPPATCH",
    "MKCOL",
    "COPY",
    "MOVE",
    "LOCK",
    "UNLOCK",
    "REPORT",
    "MKCALENDAR",
    "ACL",
)


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


def test_nginx_connection_statuses_are_well_formed() -> None:
    """A 444 geoblock or a 499 client hang-up is a normal request the server chose not to answer."""
    fmt = NginxFormat()
    for status in (444, 499, 408):
        line = (
            f'203.0.113.7 - - [03/Aug/2024:13:14:17 +0200]"GET / HTTP/1.1" {status} 0"-" '
            f'example.com "-""0.002" "-"'
        )
        norm = fmt.parse(line)
        assert norm is not None
        assert fmt.detect_malformed(norm) == (False, None), f"status {status} should not be malformed"


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


def test_traefik_parse_xff_chain_takes_last_hop() -> None:
    """ClientHost carries the client-supplied X-Forwarded-For chain verbatim
    when the peer is trusted, and the leftmost entry is whatever the client
    sent. The rightmost entry is the address the trusted proxy appended."""
    data = json.loads(TRAEFIK_FULL)
    data["ClientHost"] = "8.8.8.8, 203.0.113.7"
    norm = TraefikJsonFormat().parse(json.dumps(data))
    assert norm is not None
    assert norm.ip_address == "203.0.113.7"


def test_traefik_parse_xff_chain_strips_whitespace_around_last_hop() -> None:
    data = json.loads(TRAEFIK_FULL)
    data["ClientHost"] = "8.8.8.8,203.0.113.7 "
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
    # a connection-level status is not a malformed line
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


def test_detect_probe_tls_escaped_text() -> None:
    """The regex format sees nginx's default escaping as literal backslash-x text."""
    is_malformed, reason = detect_probe("\\x16\\x03\\x01\\x01-\\x01\\x00", None, 400)
    assert is_malformed is True
    assert reason == "TLS handshake sent to HTTP port (escaped)"


def test_detect_probe_tls_raw_bytes() -> None:
    """escape=json writes \\u0016\\u0003; the JSON decoder turns that into raw bytes."""
    is_malformed, reason = detect_probe("\x16\x03\x01\x02\x00\x01", None, 400)
    assert is_malformed is True
    assert reason == "TLS handshake sent to HTTP port (raw)"

@pytest.mark.parametrize("method", SUPPORTED_HTTP_METHODS)
def test_detect_probe_supported_http_methods_are_well_formed(method: str) -> None:
    assert detect_probe("", method, 200) == (False, None)


@pytest.mark.parametrize("method", SUPPORTED_HTTP_METHODS)
def test_traefik_supported_http_methods_are_well_formed(method: str) -> None:
    data = json.loads(TRAEFIK_FULL)
    data["RequestMethod"] = method

    norm = TraefikJsonFormat().parse(json.dumps(data))

    assert norm is not None
    assert norm.method == method
    assert TraefikJsonFormat().detect_malformed(norm) == (False, None)


@pytest.mark.parametrize("method", SUPPORTED_HTTP_METHODS)
def test_caddy_supported_http_methods_are_well_formed(method: str) -> None:
    fmt = CaddyJsonFormat()

    norm = fmt.parse(caddy({"method": method}))

    assert norm is not None
    assert norm.method == method
    assert fmt.detect_malformed(norm) == (False, None)


def test_detect_probe_ssh_and_smb() -> None:
    assert detect_probe("SSH-2.0-OpenSSH_9.6", None, 400) == (True, "SSH probe sent to HTTP port")
    assert detect_probe("\xffSMBr\x00", None, 400) == (True, "SMB protocol probe (EternalBlue scanner)")
    assert detect_probe("\\xffSMBr\\x00", None, 400) == (True, "SMB protocol probe (EternalBlue scanner)")
    assert detect_probe("\\xffSMB\\x25", None, 400) == (True, "SMB protocol probe (EternalBlue scanner)")
    assert detect_probe("NT LM 0.12", None, 400) == (True, "SMB dialect negotiation probe")


def test_detect_probe_method_and_status_rules() -> None:
    assert detect_probe("", None, 400) == (True, "TLS probe: HTTP request sent to HTTPS port")
    assert detect_probe("", None, 200) == (True, "No HTTP method in request")
    assert detect_probe("", "UNKNOWN", 200) == (True, "Invalid HTTP method: UNKNOWN")
    assert detect_probe("GET / HTTP/1.1", "GET", 200) == (False, None)
    for status in (408, 444, 499):
        assert detect_probe("GET / HTTP/1.1", "GET", status) == (False, None)
    assert detect_probe(None, "GET", 200) == (False, None)


GJSON_BASE: dict[str, str] = {
    "client_ip": "203.0.113.7",
    "timestamp": "2026-08-25T22:00:24+02:00",
    "method": "GET",
    "path": "/api/v2/homepage/plex/recent",
    "protocol": "HTTP/2.0",
    "status": "200",
    "bytes": "20580",
    "host": "app.example.com",
    "referrer": "https://app.example.com/",
    "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/151.0.0.0",
    "remote_user": "",
    "request_time": "5.670",
    "upstream_time": "5.586",
    "request_raw": "GET /api/v2/homepage/plex/recent HTTP/2.0",
}


def gjson(**overrides: str | None) -> str:
    """One geometrikks-json line; an override of None removes the key."""
    data = {**GJSON_BASE, **{k: v for k, v in overrides.items() if v is not None}}
    for key, value in overrides.items():
        if value is None:
            data.pop(key, None)
    return json.dumps(data) + "\n"


def test_gjson_parse_full_line() -> None:
    norm = GeometrikksJsonFormat().parse(gjson())
    assert norm is not None
    assert norm.ip_address == "203.0.113.7"
    assert norm.timestamp == datetime(2026, 8, 25, 22, 0, 24, tzinfo=timezone(timedelta(hours=2)))
    assert norm.timestamp.astimezone(timezone.utc).hour == 20
    assert norm.method == "GET"
    assert norm.path == "/api/v2/homepage/plex/recent"
    assert norm.http_version == "HTTP/2.0"
    assert norm.status_code == 200
    assert norm.bytes_sent == 20580
    assert norm.host == "app.example.com"
    assert norm.referrer == "https://app.example.com/"
    assert norm.user_agent == "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/151.0.0.0"
    assert norm.remote_user is None                      # "" from escape=json
    assert norm.request_time == pytest.approx(5.670)
    assert norm.upstream_response_time == pytest.approx(5.586)
    assert norm.request_raw == "GET /api/v2/homepage/plex/recent HTTP/2.0"


def test_gjson_ipv6_client_ip() -> None:
    norm = GeometrikksJsonFormat().parse(gjson(client_ip="2001:db8::1"))
    assert norm is not None
    assert norm.ip_address == "2001:db8::1"


def test_gjson_timestamp_z_suffix() -> None:
    """A 'Z'-suffixed timestamp is a UTC offset of zero, not a naive datetime."""
    norm = GeometrikksJsonFormat().parse(gjson(timestamp="2026-08-25T20:00:24Z"))
    assert norm is not None
    offset = norm.timestamp.utcoffset()
    assert offset is not None
    assert offset.total_seconds() == 0


def test_gjson_absent_semantics() -> None:
    """'' , '-' and a missing key are all None."""
    fmt = GeometrikksJsonFormat()
    for line in (
        gjson(referrer="", host="-", user_agent=None, upstream_time=""),
        gjson(referrer="-", host="", user_agent="-", upstream_time="-"),
        gjson(referrer=None, host=None, user_agent=None, upstream_time=None),
    ):
        norm = fmt.parse(line)
        assert norm is not None
        assert norm.referrer is None
        assert norm.host is None
        assert norm.user_agent is None
        assert norm.upstream_response_time is None


def test_gjson_minimal_line_parses() -> None:
    norm = GeometrikksJsonFormat().parse(
        json.dumps({"client_ip": "203.0.113.7", "timestamp": "2026-08-25T22:00:24+02:00"})
    )
    assert norm is not None
    assert norm.method is None
    assert norm.path is None
    assert norm.status_code == 0
    assert norm.bytes_sent == 0
    assert norm.request_time is None
    assert norm.upstream_response_time is None
    assert norm.request_raw is None


def test_gjson_geo_only() -> None:
    norm = GeometrikksJsonFormat().parse(gjson(remote_user="alice"), geo_only=True)
    assert norm is not None
    assert norm.ip_address == "203.0.113.7"
    assert norm.timestamp.tzinfo is not None
    assert norm.remote_user == "alice"
    assert norm.method is None
    assert norm.status_code == 0


@pytest.mark.parametrize(
    "line",
    [
        "not json at all\n",
        "[]\n",
        json.dumps([GJSON_BASE]),
        gjson(client_ip=None),
        gjson(client_ip=""),
        gjson(client_ip="-"),
        gjson(client_ip="   "),
        gjson(timestamp=None),
        gjson(timestamp="2026-08-25T22:00:24"),           # naive
        gjson(timestamp="25/Aug/2026:22:00:24 +0200"),    # nginx $time_local
        json.dumps({**GJSON_BASE, "status": 200}),        # number, not string
    ],
    ids=[
        "text", "empty-array", "array", "no-ip", "blank-ip", "dash-ip",
        "whitespace-ip", "no-ts", "naive-ts", "time-local", "typed-status",
    ],
)
def test_gjson_rejections(line: str) -> None:
    assert GeometrikksJsonFormat().parse(line) is None
    assert GeometrikksJsonFormat().parse(line, geo_only=True) is None


def test_gjson_numeric_conversion_fallbacks() -> None:
    norm = GeometrikksJsonFormat().parse(gjson(status="-", bytes="abc", request_time="-"))
    assert norm is not None
    assert norm.status_code == 0
    assert norm.bytes_sent == 0
    assert norm.request_time is None


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("0.010", 0.010),
        ("0.010, 0.020", 0.030),
        ("0.010 : 0.020", 0.030),
        ("0.010, - : 0.005", 0.015),
        ("-, -", None),
        ("0.000", 0.0),
    ],
)
def test_gjson_upstream_time_sums_parts(raw: str, expected: float | None) -> None:
    norm = GeometrikksJsonFormat().parse(gjson(upstream_time=raw))
    assert norm is not None
    if expected is None:
        assert norm.upstream_response_time is None
    else:
        assert norm.upstream_response_time == pytest.approx(expected)


def test_gjson_unknown_keys_ignored() -> None:
    norm = GeometrikksJsonFormat().parse(gjson(scheme="https", request_id="abc123"))
    assert norm is not None
    assert norm.ip_address == "203.0.113.7"


def test_gjson_websocket_upgrade_logged_at_close() -> None:
    """Real SWAG line: a 101 upgrade is logged when the socket closes, minutes later."""
    norm = GeometrikksJsonFormat().parse(gjson(
        protocol="HTTP/1.1", status="101", bytes="399",
        path="/prowlarr/signalr/messages?access_token=REDACTED&id=REDACTED",
        request_time="258.714", upstream_time="258.576",
        request_raw="GET /prowlarr/signalr/messages?access_token=REDACTED&id=REDACTED HTTP/1.1",
    ))
    assert norm is not None
    assert norm.status_code == 101
    assert norm.http_version == "HTTP/1.1"
    assert norm.request_time == pytest.approx(258.714)
    assert norm.upstream_response_time == pytest.approx(258.576)
    assert GeometrikksJsonFormat().detect_malformed(norm) == (False, None)


def test_gjson_detect_malformed_tls_probe_via_json_escapes() -> None:
    """escape=json writes control bytes as \\uXXXX; the decoder yields raw bytes."""
    line = (
        '{"client_ip":"203.0.113.7","timestamp":"2026-08-25T22:00:24+02:00",'
        '"method":"","status":"400","bytes":"157",'
        '"request_raw":"\\u0016\\u0003\\u0001\\u0002\\u0000\\u0001\\u0000\\u0001\\u00fc\\u0003\\u0003"}\n'
    )
    fmt = GeometrikksJsonFormat()
    norm = fmt.parse(line)
    assert norm is not None
    assert norm.method is None
    assert norm.request_raw is not None and norm.request_raw.startswith("\x16\x03")
    is_malformed, reason = fmt.detect_malformed(norm)
    assert is_malformed is True
    assert reason == "TLS handshake sent to HTTP port (raw)"


def test_gjson_detect_malformed_method_rules() -> None:
    fmt = GeometrikksJsonFormat()
    cases = {
        gjson(method="", status="400", request_raw="/ HTTP/1.1"): "TLS probe: HTTP request sent to HTTPS port",
        gjson(method="", status="200", request_raw="/ HTTP/1.1"): "No HTTP method in request",
        gjson(method="UNKNOWN", request_raw="UNKNOWN / HTTP/1.1"): "Invalid HTTP method: UNKNOWN",
        gjson(method=None, request_raw=None): "No HTTP method in request",
    }
    for line, expected in cases.items():
        norm = fmt.parse(line)
        assert norm is not None
        assert fmt.detect_malformed(norm) == (True, expected)


def test_gjson_connection_statuses_are_well_formed() -> None:
    fmt = GeometrikksJsonFormat()
    for status in ("444", "499", "408"):
        norm = fmt.parse(gjson(status=status))
        assert norm is not None
        assert fmt.detect_malformed(norm) == (False, None), f"status {status} should not be malformed"


def test_gjson_detect_malformed_ok_line() -> None:
    fmt = GeometrikksJsonFormat()
    norm = fmt.parse(gjson())
    assert norm is not None
    assert fmt.detect_malformed(norm) == (False, None)


CADDY_FULL = json.dumps(
    {
        "level": "info",
        "ts": 1788204125.4837868,
        "logger": "http.log.access.log1",
        "msg": "handled request",
        "request": {
            "remote_ip": "198.51.100.9",
            "remote_port": "11085",
            "client_ip": "203.0.113.7",
            "proto": "HTTP/2.0",
            "method": "GET",
            "host": "caddy.example.com",
            "uri": "/robots.txt",
            "headers": {
                "User-Agent": ["Mozilla/5.0 (compatible; test-crawler/1.0)"],
                "Referer": ["https://caddy.example.com/"],
                "X-Forwarded-For": ["203.0.113.7"],
            },
            "tls": {"resumed": False, "version": 772},
        },
        "bytes_read": 0,
        "user_id": "",
        "duration": 0.175457236,
        "upstream_duration_ms": 43.21,
        "size": 5043,
        "status": 200,
        "resp_headers": {"Server": ["Caddy"]},
    }
)


def caddy(request_overrides: dict | None = None, **overrides) -> str:
    """One caddy-json line; an override of None removes the key."""
    data = json.loads(CADDY_FULL)
    for target, changes in ((data["request"], request_overrides or {}), (data, overrides)):
        for key, value in changes.items():
            if value is None:
                target.pop(key, None)
            else:
                target[key] = value
    return json.dumps(data) + "\n"


def test_caddy_parse_full_line() -> None:
    norm = CaddyJsonFormat().parse(caddy())
    assert norm is not None
    assert norm.ip_address == "203.0.113.7"  # client_ip, not the remote_ip peer
    assert norm.timestamp == datetime.fromtimestamp(1788204125.4837868, tz=timezone.utc)
    assert norm.method == "GET"
    assert norm.path == "/robots.txt"
    assert norm.http_version == "HTTP/2.0"
    assert norm.status_code == 200
    assert norm.bytes_sent == 5043
    assert norm.host == "caddy.example.com"
    assert norm.referrer == "https://caddy.example.com/"
    assert norm.user_agent == "Mozilla/5.0 (compatible; test-crawler/1.0)"
    assert norm.remote_user is None  # user_id ""
    assert norm.request_time == pytest.approx(0.175457236)
    assert norm.upstream_response_time == pytest.approx(0.04321)
    assert norm.request_raw is None


def test_caddy_client_ip_fallback_to_remote_ip() -> None:
    norm = CaddyJsonFormat().parse(caddy({"client_ip": None}))
    assert norm is not None
    assert norm.ip_address == "198.51.100.9"


def test_caddy_missing_both_ips_rejected() -> None:
    line = caddy({"client_ip": None, "remote_ip": None})
    assert CaddyJsonFormat().parse(line) is None
    assert CaddyJsonFormat().parse(line, geo_only=True) is None


@pytest.mark.parametrize(
    "ts",
    [
        1788204125.4837868,  # unix_seconds_float (default)
        1788204125,  # integer seconds
        1788204125483.7868,  # unix_milli_float
        1788204125483786752,  # unix_nano
        "2026-08-31T19:22:05.483786+00:00",  # rfc3339 fraction
        "2026-08-31T19:22:05Z",  # rfc3339
        "2026-08-31T21:22:05+0200",  # zap iso8601 offset style
    ],
)
def test_caddy_ts_variants(ts: float | int | str) -> None:
    norm = CaddyJsonFormat().parse(caddy(ts=ts))
    assert norm is not None
    expected = datetime(2026, 8, 31, 19, 22, 5, tzinfo=timezone.utc)
    assert abs((norm.timestamp - expected).total_seconds()) < 1


@pytest.mark.parametrize("ts", ["2026-08-31T19:22:05", "1m32s", 0, -5, ""])
def test_caddy_bad_ts_rejected(ts: float | int | str) -> None:
    assert CaddyJsonFormat().parse(caddy(ts=ts)) is None


def test_caddy_oversized_integer_ts_rejected() -> None:
    assert CaddyJsonFormat().parse(caddy(ts=10**400)) is None


def test_caddy_duration_string_is_none_not_fatal() -> None:
    norm = CaddyJsonFormat().parse(caddy(duration="1m32.05s"))
    assert norm is not None
    assert norm.request_time is None
    assert norm.status_code == 200


def test_caddy_oversized_integer_duration_is_none_not_fatal() -> None:
    norm = CaddyJsonFormat().parse(caddy(duration=10**400))
    assert norm is not None
    assert norm.request_time is None
    assert norm.status_code == 200


def test_caddy_missing_upstream_duration_is_none() -> None:
    norm = CaddyJsonFormat().parse(caddy(upstream_duration_ms=None))
    assert norm is not None
    assert norm.upstream_response_time is None


def test_caddy_zero_upstream_duration_is_preserved() -> None:
    norm = CaddyJsonFormat().parse(caddy(upstream_duration_ms=0))
    assert norm is not None
    assert norm.upstream_response_time == 0


@pytest.mark.parametrize("raw", ["43.21", 10**400])
def test_caddy_invalid_upstream_duration_is_none_not_fatal(raw: str | int) -> None:
    norm = CaddyJsonFormat().parse(caddy(upstream_duration_ms=raw))
    assert norm is not None
    assert norm.upstream_response_time is None
    assert norm.status_code == 200


def test_caddy_host_port_stripped() -> None:
    norm = CaddyJsonFormat().parse(caddy({"host": "caddy.example.com:8443"}))
    assert norm is not None
    assert norm.host == "caddy.example.com"
    norm = CaddyJsonFormat().parse(caddy({"host": "[2001:db8::1]:443"}))
    assert norm is not None
    assert norm.host == "2001:db8::1"


def test_caddy_absent_headers_and_fields_become_none() -> None:
    fmt = CaddyJsonFormat()
    for line in (
        caddy({"headers": None}),
        caddy({"headers": {}}),
        caddy({"headers": {"User-Agent": [], "Referer": []}}),
    ):
        norm = fmt.parse(line)
        assert norm is not None
        assert norm.user_agent is None
        assert norm.referrer is None
    norm = fmt.parse(
        caddy(
            {"method": None, "uri": None, "proto": None, "host": None},
            size=None,
            duration=None,
            user_id=None,
        )
    )
    assert norm is not None
    assert norm.method is None
    assert norm.path is None
    assert norm.http_version is None
    assert norm.host is None
    assert norm.bytes_sent == 0
    assert norm.request_time is None
    assert norm.remote_user is None


def test_caddy_geo_only() -> None:
    norm = CaddyJsonFormat().parse(caddy(status=None), geo_only=True)
    assert norm is not None
    assert norm.ip_address == "203.0.113.7"
    assert norm.timestamp.tzinfo is not None
    assert norm.method is None


def test_caddy_rejections() -> None:
    fmt = CaddyJsonFormat()
    runtime_line = '{"level":"info","ts":1788204125.4,"logger":"tls","msg":"certificate obtained"}\n'
    assert fmt.parse("not json") is None
    assert fmt.parse("[1, 2, 3]") is None
    assert fmt.parse(runtime_line) is None  # no request object
    assert fmt.parse(runtime_line, geo_only=True) is None
    assert fmt.parse(caddy(status=None)) is None  # full parse needs int status
    assert fmt.parse(caddy(status="200")) is None  # wrong JSON type fails the decode


def test_caddy_detect_malformed() -> None:
    fmt = CaddyJsonFormat()
    norm = fmt.parse(caddy({"method": ""}, status=400))
    assert norm is not None
    assert fmt.detect_malformed(norm) == (True, "No HTTP method in request")
    norm = fmt.parse(caddy({"method": "UNKNOWN"}))
    assert norm is not None
    assert fmt.detect_malformed(norm) == (True, "Invalid HTTP method: UNKNOWN")
    norm = fmt.parse(caddy())
    assert norm is not None
    assert fmt.detect_malformed(norm) == (False, None)


def test_registry_order() -> None:
    assert list(FORMATS) == ["geometrikks-json", "traefik-json", "caddy-json", "nginx"]
    assert FORMATS["geometrikks-json"].name == "geometrikks-json"


def test_sniff_format_gjson() -> None:
    sniffed = sniff_format([NGINX_GARBAGE, gjson()])
    assert sniffed is not None
    assert sniffed.format.name == "geometrikks-json"
    assert sniffed.geo_only is False


def test_json_adapters_decline_each_others_lines() -> None:
    for foreign in (TRAEFIK_FULL, CADDY_FULL):
        assert GeometrikksJsonFormat().parse(foreign) is None
        assert GeometrikksJsonFormat().parse(foreign, geo_only=True) is None
    for foreign in (gjson(), CADDY_FULL):
        assert TraefikJsonFormat().parse(foreign) is None
        assert TraefikJsonFormat().parse(foreign, geo_only=True) is None
    for foreign in (gjson(), TRAEFIK_FULL):
        assert CaddyJsonFormat().parse(foreign) is None
        assert CaddyJsonFormat().parse(foreign, geo_only=True) is None
    sniffed = sniff_format([TRAEFIK_FULL])
    assert sniffed is not None and sniffed.format.name == "traefik-json"


def test_sniff_format_caddy() -> None:
    sniffed = sniff_format([NGINX_GARBAGE, caddy()])
    assert sniffed is not None
    assert sniffed.format.name == "caddy-json"
    assert sniffed.geo_only is False


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("0.000", 0.0),
        ("5.670", 5.67),
        ("", None),
        ("-", None),
        ("abc", None),
        ("nan", None),
        ("inf", None),
        ("-inf", None),
        (None, None),
    ],
)
def test_parse_seconds(raw: str | None, expected: float | None) -> None:
    assert parse_seconds(raw) == expected


@pytest.mark.parametrize(
    "addr, expected",
    [
        ("203.0.113.7:443", "203.0.113.7"),
        ("[2001:db8::1]:443", "2001:db8::1"),
        ("2001:db8::1", "2001:db8::1"),
        ("caddy.example.com:8443", "caddy.example.com"),
        ("caddy.example.com", "caddy.example.com"),
    ],
)
def test_host_from_addr(addr: str, expected: str) -> None:
    assert host_from_addr(addr) == expected


def test_gjson_request_time_absent_is_none() -> None:
    fmt = GeometrikksJsonFormat()
    for line in (gjson(request_time=None), gjson(request_time=""), gjson(request_time="-"), gjson(request_time="nan")):
        norm = fmt.parse(line)
        assert norm is not None
        assert norm.request_time is None


def test_gjson_request_time_zero_is_a_measurement() -> None:
    norm = GeometrikksJsonFormat().parse(gjson(request_time="0.000"))
    assert norm is not None
    assert norm.request_time == 0.0


def test_nginx_combined_line_has_no_request_time() -> None:
    """A combined-format line has no timing groups; that is None, not 0.0."""
    line = '203.0.113.7 - - [03/Aug/2024:13:14:17 +0200] "GET /a HTTP/1.1" 200 12 "-" "Mozilla/5.0"'
    norm = NginxFormat().parse(line)
    assert norm is not None
    assert norm.request_time is None
    assert norm.upstream_response_time is None


def test_nginx_dash_request_time_is_none() -> None:
    line = (
        '203.0.113.7 - - [03/Aug/2024:13:14:17 +0200]"GET /a HTTP/1.1" 200 12'
        '"-" example.com "Mozilla/5.0""-" "-"'
    )
    norm = NginxFormat().parse(line)
    assert norm is not None
    assert norm.request_time is None


def test_traefik_missing_duration_is_none() -> None:
    data = json.loads(TRAEFIK_FULL)
    del data["Duration"]
    norm = TraefikJsonFormat().parse(json.dumps(data))
    assert norm is not None
    assert norm.request_time is None
