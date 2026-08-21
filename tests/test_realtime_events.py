"""Wire schema for the live_events channel: envelope shape, truncation, size guard."""
from __future__ import annotations

from datetime import datetime, timezone

from geometrikks.domain.realtime.events import (
    PAYLOAD_MAX,
    REFERRER_MAX,
    URL_MAX,
    USER_AGENT_MAX,
    encode_guard,
    record_to_event,
)
from geometrikks.services.logparser.schemas import (
    ParsedAccessLog,
    ParsedGeoData,
    ParsedLogRecord,
)

TS = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)


def _record(
    url: str = "/x",
    referrer: str | None = None,
    user_agent: str | None = "curl",
    with_geo: bool = True,
    with_log: bool = True,
) -> ParsedLogRecord:
    geo = ParsedGeoData(
        latitude=51.5, longitude=-0.09, geohash="gcpvj", country_code="GB",
        country_name="UK", timestamp=TS, city="London",
    ) if with_geo else None
    log = ParsedAccessLog(
        timestamp=TS, ip_address="81.2.69.142", remote_user=None, method="GET",
        url=url, http_version="1.1", status_code=200, bytes_sent=123,
        referrer=referrer, user_agent=user_agent, request_time=0.01,
        upstream_response_time=None, host="example.com", country_code="GB",
        country_name="UK", city="London",
    ) if with_log else None
    return ParsedLogRecord(
        ip_address="81.2.69.142", geo_data=geo, access_log=log, raw_line="x",
        hostname="vps-1",
    )


def test_full_record_yields_single_envelope() -> None:
    event = record_to_event(_record())
    assert event is not None
    assert event["type"] == "request"
    geo = event["geo"]
    assert geo["latitude"] == 51.5 and geo["country_code"] == "GB"
    log = event["log"]
    assert log["status_code"] == 200 and log["url"] == "/x"
    # Wire format carries the full access-log field set.
    assert set(log) == {
        "timestamp", "ip_address", "remote_user", "method", "url",
        "http_version", "status_code", "bytes_sent", "referrer",
        "user_agent", "request_time", "upstream_response_time", "host",
        "country_code", "country_name", "city", "hostname",
        "autonomous_system_number", "autonomous_system_organization",
    }
    assert log["http_version"] == "1.1" and log["user_agent"] == "curl"
    assert log["host"] == "example.com" and log["country_code"] == "GB"


def test_both_sides_carry_hostname() -> None:
    event = record_to_event(_record())
    assert event is not None
    assert event["geo"]["hostname"] == "vps-1"
    assert event["log"]["hostname"] == "vps-1"


def test_geo_only_record() -> None:
    event = record_to_event(_record(with_log=False))
    assert event is not None
    assert event["geo"] is not None
    assert event["log"] is None


def test_log_only_record() -> None:
    event = record_to_event(_record(with_geo=False))
    assert event is not None
    assert event["geo"] is None
    assert event["log"] is not None


def test_empty_record_yields_none() -> None:
    assert record_to_event(_record(with_geo=False, with_log=False)) is None


def test_access_log_fields_truncated_at_caps() -> None:
    event = record_to_event(
        _record(url="u" * (URL_MAX + 500), referrer="r" * (REFERRER_MAX + 500),
                user_agent="a" * (USER_AGENT_MAX + 500))
    )
    assert event is not None
    log = event["log"]
    assert len(log["url"]) == URL_MAX
    assert len(log["referrer"]) == REFERRER_MAX
    assert len(log["user_agent"]) == USER_AGENT_MAX


def test_none_fields_survive_truncation() -> None:
    event = record_to_event(_record(referrer=None, user_agent=None))
    assert event is not None
    assert event["log"]["referrer"] is None
    assert event["log"]["user_agent"] is None


def test_encode_guard_accepts_normal_envelope() -> None:
    event = record_to_event(_record())
    assert event is not None
    assert encode_guard(event) is True


def test_encode_guard_rejects_oversize_envelope() -> None:
    oversize = {"type": "request", "geo": None, "log": {"url": "x" * (PAYLOAD_MAX + 1000)}}
    assert encode_guard(oversize) is False


def test_event_carries_clipped_asn_fields() -> None:
    from geometrikks.domain.realtime.events import ASN_ORG_MAX

    record = _record()
    assert record.access_log is not None
    record.access_log.autonomous_system_number = 24940
    record.access_log.autonomous_system_organization = "H" * 500

    event = record_to_event(record)
    assert event is not None and event["log"] is not None
    assert event["log"]["autonomous_system_number"] == 24940
    assert event["log"]["autonomous_system_organization"] == "H" * ASN_ORG_MAX
    assert ASN_ORG_MAX == 100


def test_encode_guard_bills_non_ascii_as_utf8_bytes() -> None:
    """A URL of 2000 two-byte characters is 4000 bytes on the wire. Billing it
    at six chars each, the way json.dumps' \\uXXXX escaping does, would drop an
    envelope that fits well inside the NOTIFY budget."""
    event = {"type": "request", "geo": None, "log": {"url": "\u00e9" * 2000}}
    assert encode_guard(event) is True


def test_encode_guard_measures_what_the_channels_plugin_sends() -> None:
    """The guard is only meaningful if it counts the same bytes the backend
    hands to NOTIFY."""
    from litestar.channels import ChannelsPlugin
    from litestar.channels.backends.memory import MemoryChannelsBackend

    plugin = ChannelsPlugin(backend=MemoryChannelsBackend(), channels=["live_events"])
    event = record_to_event(_record(url="/\u00e9" * 200))
    assert event is not None
    assert len(plugin.encode_data(event)) <= PAYLOAD_MAX
    assert encode_guard(event) is True
