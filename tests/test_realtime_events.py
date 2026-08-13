"""Wire schema for the live_events channel: hostname, truncation, size guard."""
from __future__ import annotations

from datetime import datetime, timezone

from geometrikks.domain.realtime.events import (
    PAYLOAD_MAX,
    REFERRER_MAX,
    URL_MAX,
    USER_AGENT_MAX,
    encode_guard,
    record_to_events,
)
from geometrikks.services.logparser.schemas import (
    ParsedAccessLog,
    ParsedGeoData,
    ParsedLogRecord,
)


def _record(url: str = "/index", referrer: str | None = None, user_agent: str | None = None) -> ParsedLogRecord:
    ts = datetime.now(timezone.utc)
    return ParsedLogRecord(
        ip_address="203.0.113.7",
        geo_data=ParsedGeoData(
            latitude=51.5, longitude=-0.1, geohash="gcpvj0", country_code="GB",
            country_name="United Kingdom", timestamp=ts,
        ),
        access_log=ParsedAccessLog(
            timestamp=ts, ip_address="203.0.113.7", remote_user=None, method="GET",
            url=url, http_version="HTTP/2.0", status_code=200, bytes_sent=10,
            referrer=referrer, user_agent=user_agent, request_time=0.1,
            upstream_response_time=None, host="example.com",
            country_code="GB", country_name="United Kingdom", city="London",
        ),
        raw_line="raw",
        hostname="vps-1",
    )


def test_both_event_types_carry_hostname() -> None:
    events = record_to_events(_record())
    assert [e["type"] for e in events] == ["geo_event", "access_log"]
    assert all(e["data"]["hostname"] == "vps-1" for e in events)


def test_access_log_fields_truncated_at_caps() -> None:
    events = record_to_events(
        _record(url="u" * (URL_MAX + 500), referrer="r" * (REFERRER_MAX + 500),
                user_agent="a" * (USER_AGENT_MAX + 500))
    )
    data = events[1]["data"]
    assert len(data["url"]) == URL_MAX
    assert len(data["referrer"]) == REFERRER_MAX
    assert len(data["user_agent"]) == USER_AGENT_MAX


def test_none_fields_survive_truncation() -> None:
    data = record_to_events(_record(referrer=None, user_agent=None))[1]["data"]
    assert data["referrer"] is None
    assert data["user_agent"] is None


def test_encode_guard_accepts_normal_event() -> None:
    events = record_to_events(_record())
    assert all(encode_guard(e) for e in events)


def test_encode_guard_rejects_oversize_event() -> None:
    oversize = {"type": "access_log", "data": {"url": "x" * (PAYLOAD_MAX + 1000)}}
    assert encode_guard(oversize) is False


TS = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)


def _make_record_for_legacy_tests(with_geo: bool = True, with_log: bool = True) -> ParsedLogRecord:
    """Helper for TestRecordToEvents; provides hostname required by new implementation."""
    geo = ParsedGeoData(
        latitude=51.5, longitude=-0.09, geohash="gcpvj", country_code="GB",
        country_name="UK", timestamp=TS, city="London",
    ) if with_geo else None
    log = ParsedAccessLog(
        timestamp=TS, ip_address="81.2.69.142", remote_user=None, method="GET",
        url="/x", http_version="1.1", status_code=200, bytes_sent=123,
        referrer=None, user_agent="curl", request_time=0.01,
        upstream_response_time=None, host="example.com", country_code="GB",
        country_name="UK", city="London",
    ) if with_log else None
    return ParsedLogRecord(
        ip_address="81.2.69.142", geo_data=geo, access_log=log, raw_line="x",
    )


class TestRecordToEvents:
    def test_full_record_yields_both_events(self):
        events = record_to_events(_make_record_for_legacy_tests())
        types = [e["type"] for e in events]
        assert types == ["geo_event", "access_log"]
        geo = events[0]["data"]
        assert geo["latitude"] == 51.5 and geo["country_code"] == "GB"
        log = events[1]["data"]
        assert log["status_code"] == 200 and log["url"] == "/x"
        # Wire format carries the full access-log field set.
        assert set(log) == {
            "timestamp", "ip_address", "remote_user", "method", "url",
            "http_version", "status_code", "bytes_sent", "referrer",
            "user_agent", "request_time", "upstream_response_time", "host",
            "country_code", "country_name", "city", "hostname",
        }
        assert log["http_version"] == "1.1" and log["user_agent"] == "curl"
        assert log["host"] == "example.com" and log["country_code"] == "GB"

    def test_geo_only_record(self):
        events = record_to_events(_make_record_for_legacy_tests(with_log=False))
        assert [e["type"] for e in events] == ["geo_event"]

    def test_malformed_record_yields_nothing(self):
        assert record_to_events(_make_record_for_legacy_tests(with_geo=False, with_log=False)) == []
