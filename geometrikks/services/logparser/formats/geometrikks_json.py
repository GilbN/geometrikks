"""Adapter for the GeoMetrikks keyed JSON access-log format.

The recommended nginx setup (README, Nginx setup). nginx has no typed
output, so every value is a JSON string and this adapter does the number
parsing; an unquoted empty variable would break the whole line. ``""``,
``"-"`` and a missing key all mean absent. Only ``client_ip`` and
``timestamp`` are required. Unknown keys are ignored so users can add
fields for other consumers of the same file.
"""
from __future__ import annotations

from datetime import datetime

import msgspec

from .base import NormalizedLine, convert_dash_to_none, detect_probe, parse_seconds


class GeometrikksJsonLine(msgspec.Struct):
    """One line as written by the documented ``log_format``; all values strings."""

    client_ip: str | None = None
    timestamp: str | None = None
    method: str | None = None
    path: str | None = None
    protocol: str | None = None
    status: str | None = None
    bytes: str | None = None
    host: str | None = None
    referrer: str | None = None
    user_agent: str | None = None
    remote_user: str | None = None
    request_time: str | None = None
    upstream_time: str | None = None
    request_raw: str | None = None


_decoder = msgspec.json.Decoder(GeometrikksJsonLine)


def _parse_timestamp(raw: str | None) -> datetime | None:
    """ISO 8601 with a UTC offset; naive timestamps are rejected, not assumed UTC."""
    if not raw:
        return None
    try:
        ts = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return ts if ts.tzinfo is not None else None


def _to_int(raw: str | None) -> int:
    try:
        return int(raw) if raw else 0
    except ValueError:
        return 0


def _sum_upstream(raw: str | None) -> float | None:
    """Total time upstream.

    nginx joins per-upstream times with ", " and internal-redirect legs with
    " : ", and writes "-" for a leg with no upstream. Summing matches what
    Traefik's OriginDuration measures.
    """
    if not raw:
        return None
    total = 0.0
    seen = False
    for part in raw.replace(":", ",").split(","):
        part = part.strip()
        if not part or part == "-":
            continue
        try:
            total += float(part)
        except ValueError:
            continue
        seen = True
    return total if seen else None


class GeometrikksJsonFormat:
    """Parses one keyed JSON object per line against a fixed schema."""

    name = "geometrikks-json"

    def parse(self, line: str, *, geo_only: bool = False) -> NormalizedLine | None:
        """Decode one line into a NormalizedLine.

        Args:
            line: Raw log line (one JSON object).
            geo_only: Only require the client IP and the timestamp
                (send_logs=False mode).

        Returns:
            NormalizedLine on success; None for non-JSON lines, wrong value
            types, or lines missing the client IP / offset-bearing timestamp.
        """
        stripped = line.strip()
        if not stripped.startswith("{"):
            return None
        try:
            data = _decoder.decode(stripped)
        except msgspec.DecodeError:
            # ValidationError (wrong type for a field) is a DecodeError subclass.
            return None

        ip = convert_dash_to_none(data.client_ip)
        ts = _parse_timestamp(data.timestamp)
        if ip is None or ts is None:
            return None

        remote_user = convert_dash_to_none(data.remote_user)
        if geo_only:
            return NormalizedLine(ip_address=ip, timestamp=ts, remote_user=remote_user)

        return NormalizedLine(
            ip_address=ip,
            timestamp=ts,
            remote_user=remote_user,
            method=convert_dash_to_none(data.method),
            path=convert_dash_to_none(data.path),
            http_version=convert_dash_to_none(data.protocol),
            status_code=_to_int(data.status),
            bytes_sent=_to_int(data.bytes),
            referrer=convert_dash_to_none(data.referrer),
            user_agent=convert_dash_to_none(data.user_agent),
            request_time=parse_seconds(data.request_time),
            upstream_response_time=_sum_upstream(data.upstream_time),
            host=convert_dash_to_none(data.host),
            request_raw=convert_dash_to_none(data.request_raw),
        )

    def detect_malformed(self, norm: NormalizedLine) -> tuple[bool, str | None]:
        """Probe and connection-status classification; see ``detect_probe``."""
        return detect_probe(norm.request_raw, norm.method, norm.status_code)
