"""Wire schema for the live_events channel.

One committed ParsedLogRecord becomes at most one compact JSON envelope
published to Postgres NOTIFY, carrying the record's geo view and access-log
view together. One envelope rather than one event per view: concurrent
agent publishers interleave NOTIFYs, so halves shipped separately could not
be reliably re-paired client-side. NOTIFY payloads cap at 8000 bytes, so
attacker-controlled fields are truncated here and encode_guard() drops
anything still over budget - the DB row is untouched; the live feed is a
preview.
"""
from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from geometrikks.services.logparser.schemas import ParsedLogRecord

LIVE_EVENTS_CHANNEL = "live_events"

URL_MAX = 2000
REFERRER_MAX = 1000
USER_AGENT_MAX = 500
ASN_ORG_MAX = 100
PAYLOAD_MAX = 7500


def _clip(value: str | None, limit: int) -> str | None:
    if value is None or len(value) <= limit:
        return value
    return value[:limit]


def record_to_event(record: "ParsedLogRecord") -> dict[str, Any] | None:
    """Convert one committed record to its wire envelope; None when empty."""
    geo: dict[str, Any] | None = None
    log: dict[str, Any] | None = None
    if record.geo_data and record.ip_address:
        g = record.geo_data
        geo = {
            "timestamp": g.timestamp.isoformat(),
            "ip_address": record.ip_address,
            "latitude": g.latitude,
            "longitude": g.longitude,
            "city": g.city,
            "country_code": g.country_code,
            "hostname": record.hostname,
        }
    if record.access_log:
        a = record.access_log
        log = {
            "timestamp": a.timestamp.isoformat(),
            "ip_address": a.ip_address,
            "remote_user": a.remote_user,
            "method": a.method,
            "url": _clip(a.url, URL_MAX),
            "http_version": a.http_version,
            "status_code": a.status_code,
            "bytes_sent": a.bytes_sent,
            "referrer": _clip(a.referrer, REFERRER_MAX),
            "user_agent": _clip(a.user_agent, USER_AGENT_MAX),
            "request_time": a.request_time,
            "upstream_response_time": a.upstream_response_time,
            "host": a.host,
            "country_code": a.country_code,
            "country_name": a.country_name,
            "city": a.city,
            "autonomous_system_number": a.autonomous_system_number,
            "autonomous_system_organization": _clip(
                a.autonomous_system_organization, ASN_ORG_MAX
            ),
            "hostname": record.hostname,
        }
    if geo is None and log is None:
        return None
    return {"type": "request", "geo": geo, "log": log}


def encode_guard(event: dict[str, Any]) -> bool:
    """True when the encoded event fits the NOTIFY budget; False = drop it."""
    return len(json.dumps(event)) <= PAYLOAD_MAX
