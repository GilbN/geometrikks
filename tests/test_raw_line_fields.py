"""Tests for splitting a JSON debug line into header, stored and other fields."""
import json
import tracemalloc
from typing import Any

from geometrikks.domain.logs.raw_line_fields import raw_line_fields
from geometrikks.domain.logs.schemas import RawLineField
from geometrikks.services.logparser.json_fields import decode_json_object, flatten

TRAEFIK_RECORD = {
    "ClientAddr": "207.175.194.80:49150",
    "ClientHost": "207.175.194.80",
    "ClientUsername": "-",
    "DownstreamContentSize": 19,
    "DownstreamStatus": 404,
    "Duration": 28906,
    "OriginDuration": 0,
    "RequestAddr": "195.0.194.210",
    "RequestHost": "195.0.194.210",
    "RequestMethod": "FQUX",
    "RequestPath": "/",
    "RequestProtocol": "HTTP/1.1",
    "StartLocal": "2026-10-29T02:25:18.637791165Z",
    "StartUTC": "2026-10-29T02:25:18.637791165Z",
    "TLSVersion": "1.3",
    "entryPointName": "https",
    "level": "info",
    "msg": "",
    "request_User-Agent": "Mozilla/5.0 (compatible)",
    "request_X-Tenant-Id": "acme-prod",
    "downstream_Content-Type": "text/plain",
    "origin_X-Upstream": "app-1",
    "time": "2026-10-29T02:25:18Z",
}
TRAEFIK_LINE = json.dumps(TRAEFIK_RECORD)

CADDY_RECORD: dict[str, Any] = {
    "level": "info",
    "ts": 1761704718.637,
    "logger": "http.log.access",
    "request": {
        "remote_ip": "10.0.0.2",
        "client_ip": "203.0.113.7",
        "proto": "HTTP/2.0",
        "method": "GET",
        "host": "example.com",
        "uri": "/admin",
        "headers": {
            "User-Agent": ["curl/8.5.0"],
            "Accept": ["text/html", "application/json"],
        },
        "tls": {"version": 772, "resumed": False},
    },
    "duration": 0.0012,
    "size": 512,
    "status": 200,
    "resp_headers": {"Server": ["Caddy"]},
}
CADDY_LINE = json.dumps(CADDY_RECORD)

GEOMETRIKKS_RECORD = {
    "client_ip": "203.0.113.7",
    "timestamp": "2026-10-29T02:25:18+00:00",
    "method": "GET",
    "path": "/",
    "status": "200",
    "request_time": "0.002",
    "request_raw": "GET / HTTP/1.1",
    "x_trace": "abc",
}
GEOMETRIKKS_LINE = json.dumps(GEOMETRIKKS_RECORD)


def by_key(fields: list[RawLineField]) -> dict[str, RawLineField]:
    return {raw_field.key: raw_field for raw_field in fields}


class TestNonJson:
    def test_plain_text_line_has_no_fields(self) -> None:
        assert raw_line_fields('203.0.113.7 - - [03/Aug/2024:13:14:17 +0200] "GET / HTTP/1.1"', linked=True) is None

    def test_truncated_json_has_no_fields(self) -> None:
        assert raw_line_fields(TRAEFIK_LINE[:-10], linked=True) is None

    def test_top_level_array_has_no_fields(self) -> None:
        assert raw_line_fields("[1, 2, 3]", linked=True) is None


class TestTraefik:
    def test_detects_the_format_and_keeps_line_order(self) -> None:
        result = raw_line_fields(TRAEFIK_LINE, linked=True)
        assert result is not None
        assert result.format == "traefik-json"
        assert [raw_field.key for raw_field in result.fields][:3] == ["ClientAddr", "ClientHost", "ClientUsername"]

    def test_prefixed_keys_become_headers_without_the_prefix(self) -> None:
        result = raw_line_fields(TRAEFIK_LINE, linked=True)
        assert result is not None
        fields = by_key(result.fields)
        assert fields["X-Tenant-Id"].group == "request_header"
        assert fields["X-Tenant-Id"].value == "acme-prod"
        assert fields["X-Tenant-Id"].stored_as is None
        assert fields["User-Agent"].group == "request_header"
        assert fields["User-Agent"].stored_as == "User agent"
        assert fields["Content-Type"].group == "response_header"
        assert fields["X-Upstream"].group == "origin_header"

    def test_marks_the_keys_the_parser_stores(self) -> None:
        result = raw_line_fields(TRAEFIK_LINE, linked=True)
        assert result is not None
        fields = by_key(result.fields)
        assert fields["DownstreamStatus"].stored_as == "Status"
        assert fields["Duration"].stored_as == "Request time"
        assert fields["RequestPath"].stored_as == "URL"
        assert fields["ClientHost"].stored_as == "IP address"
        assert fields["TLSVersion"].stored_as is None
        assert fields["entryPointName"].stored_as is None

    def test_only_the_fallback_the_parser_used_counts_as_stored(self) -> None:
        result = raw_line_fields(TRAEFIK_LINE, linked=True)
        assert result is not None
        fields = by_key(result.fields)
        assert fields["StartUTC"].stored_as == "Time"
        assert fields["StartLocal"].stored_as is None
        assert fields["time"].stored_as is None
        assert fields["ClientAddr"].stored_as is None
        assert fields["RequestHost"].stored_as == "Host"
        assert fields["RequestAddr"].stored_as is None

    def test_dash_values_are_not_stored(self) -> None:
        result = raw_line_fields(TRAEFIK_LINE, linked=True)
        assert result is not None
        assert by_key(result.fields)["ClientUsername"].stored_as is None

    def test_values_render_as_text(self) -> None:
        result = raw_line_fields(TRAEFIK_LINE, linked=True)
        assert result is not None
        fields = by_key(result.fields)
        assert fields["DownstreamStatus"].value == "404"
        assert fields["msg"].value == ""

    def test_unlinked_line_has_no_format_or_stored_marks(self) -> None:
        result = raw_line_fields(TRAEFIK_LINE, linked=False)
        assert result is not None
        assert result.format is None
        assert all(raw_field.stored_as is None for raw_field in result.fields)
        assert by_key(result.fields)["X-Tenant-Id"].group == "request_header"


class TestCaddy:
    def test_nested_objects_become_dotted_keys(self) -> None:
        result = raw_line_fields(CADDY_LINE, linked=True)
        assert result is not None
        assert result.format == "caddy-json"
        fields = by_key(result.fields)
        assert fields["request.tls.version"].value == "772"
        assert fields["request.tls.resumed"].value == "false"
        assert fields["request.method"].stored_as == "Method"

    def test_header_objects_become_headers_with_joined_values(self) -> None:
        result = raw_line_fields(CADDY_LINE, linked=True)
        assert result is not None
        fields = by_key(result.fields)
        assert fields["Accept"].group == "request_header"
        assert fields["Accept"].value == "text/html, application/json"
        assert fields["User-Agent"].stored_as == "User agent"
        assert fields["Server"].group == "response_header"

    def test_client_ip_wins_over_remote_ip(self) -> None:
        result = raw_line_fields(CADDY_LINE, linked=True)
        assert result is not None
        fields = by_key(result.fields)
        assert fields["request.client_ip"].stored_as == "IP address"
        assert fields["request.remote_ip"].stored_as is None
        assert fields["logger"].stored_as is None


class TestGeometrikksJson:
    def test_lowercase_request_keys_are_not_headers(self) -> None:
        result = raw_line_fields(GEOMETRIKKS_LINE, linked=True)
        assert result is not None
        assert result.format == "geometrikks-json"
        fields = by_key(result.fields)
        assert fields["request_time"].group == "field"
        assert fields["request_time"].stored_as == "Request time"
        assert fields["request_raw"].stored_as is None
        assert fields["x_trace"].stored_as is None

    def test_numbers_that_do_not_parse_are_not_stored(self) -> None:
        line = json.dumps({**GEOMETRIKKS_RECORD, "status": "unknown", "bytes": "abc"})
        result = raw_line_fields(line, linked=True)
        assert result is not None
        fields = by_key(result.fields)
        assert fields["status"].stored_as is None
        assert fields["bytes"].stored_as is None


class TestUnknownJson:
    def test_json_no_parser_accepts_lists_every_key(self) -> None:
        line = json.dumps({"event": "startup", "nested": {"a": [{"b": 1}]}, "request_X-Id": "7"})
        result = raw_line_fields(line, linked=True)
        assert result is not None
        assert result.format is None
        fields = by_key(result.fields)
        assert fields["event"].value == "startup"
        assert fields["nested.a"].value == '[{"b":1}]'
        assert fields["X-Id"].group == "request_header"

    def test_empty_object_value_is_kept(self) -> None:
        result = raw_line_fields(json.dumps({"tags": {}, "items": []}), linked=False)
        assert result is not None
        fields = by_key(result.fields)
        assert fields["tags"].value == "{}"
        assert fields["items"].value == "[]"


def traefik_line(**changes: object) -> str:
    return json.dumps({**TRAEFIK_RECORD, **changes})


class TestStoredMatchesParser:
    def test_unparseable_timestamp_falls_through_to_the_next_key(self) -> None:
        result = raw_line_fields(traefik_line(StartUTC="bad", StartLocal="also bad"), linked=True)
        assert result is not None
        fields = by_key(result.fields)
        assert fields["StartUTC"].stored_as is None
        assert fields["StartLocal"].stored_as is None
        assert fields["time"].stored_as == "Time"

    def test_zero_origin_duration_is_not_stored(self) -> None:
        result = raw_line_fields(TRAEFIK_LINE, linked=True)
        assert result is not None
        assert by_key(result.fields)["OriginDuration"].stored_as is None

    def test_wrongly_typed_numbers_are_not_stored(self) -> None:
        result = raw_line_fields(traefik_line(Duration="bad", DownstreamContentSize="19"), linked=True)
        assert result is not None
        fields = by_key(result.fields)
        assert fields["Duration"].stored_as is None
        assert fields["DownstreamContentSize"].stored_as is None

    def test_dash_header_value_is_not_stored(self) -> None:
        record = {**CADDY_RECORD, "request": {**CADDY_RECORD["request"], "headers": {"Referer": ["-"]}}}
        result = raw_line_fields(json.dumps(record), linked=True)
        assert result is not None
        assert by_key(result.fields)["Referer"].stored_as is None

    def test_caddy_string_duration_is_not_stored(self) -> None:
        result = raw_line_fields(json.dumps({**CADDY_RECORD, "duration": "1ms"}), linked=True)
        assert result is not None
        assert by_key(result.fields)["duration"].stored_as is None


class TestOddInput:
    def test_deep_nesting_is_flattened_without_recursion(self) -> None:
        line = '{"a":' * 5000 + "0" + "}" * 5000
        result = raw_line_fields(line, linked=False)
        assert result is not None
        assert len(result.fields) == 1
        assert result.fields[0].key.count(".") == 4999

    def test_deep_nesting_keeps_memory_linear(self) -> None:
        record = decode_json_object('{"a":' * 5000 + "0" + "}" * 5000)
        assert record is not None
        tracemalloc.start()
        try:
            list(flatten(record))
            peak = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()
        assert peak < 2 * 2**20

    def test_lone_surrogate_escape_keeps_the_raw_view_only(self) -> None:
        assert raw_line_fields('{"message":"\\ud800"}', linked=False) is None

    def test_a_parser_that_raises_on_a_foreign_line_counts_as_a_rejection(self) -> None:
        result = raw_line_fields(json.dumps({**CADDY_RECORD, "ClientHost": 123}), linked=True)
        assert result is not None
        assert result.format == "caddy-json"

    def test_header_names_may_start_with_a_digit(self) -> None:
        result = raw_line_fields(traefik_line(**{"request_3gpp-Sbi-Target-Apiroot": "x"}), linked=True)
        assert result is not None
        assert by_key(result.fields)["3gpp-Sbi-Target-Apiroot"].group == "request_header"
