"""Wire schema for the live_events channel.

One committed ParsedLogRecord becomes 0-2 compact JSON events published to
Postgres NOTIFY. NOTIFY payloads cap at 8000 bytes, so attacker-controlled
fields are truncated here and encode_guard() drops anything still over
budget - the DB row is untouched; the live feed is a preview.
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
PAYLOAD_MAX = 7500


def _clip(value: str | None, limit: int) -> str | None:
    if value is None or len(value) <= limit:
        return value
    return value[:limit]


def record_to_events(record: "ParsedLogRecord") -> list[dict[str, Any]]:
    """Convert one committed record to wire events (0, 1, or 2)."""
    events: list[dict[str, Any]] = []
    if record.geo_data and record.ip_address:
        g = record.geo_data
        events.append({
            "type": "geo_event",
            "data": {
                "timestamp": g.timestamp.isoformat(),
                "ip_address": record.ip_address,
                "latitude": g.latitude,
                "longitude": g.longitude,
                "city": g.city,
                "country_code": g.country_code,
                "hostname": record.hostname,
            },
        })
    if record.access_log:
        a = record.access_log
        events.append({
            "type": "access_log",
            "data": {
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
                "hostname": record.hostname,
            },
        })
    return events


def encode_guard(event: dict[str, Any]) -> bool:
    """True when the encoded event fits the NOTIFY budget; False = drop it."""
    return len(json.dumps(event)) <= PAYLOAD_MAX
