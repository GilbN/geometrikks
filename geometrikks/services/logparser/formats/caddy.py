"""Adapter for Caddy JSON access logs (zap encoder, one object per line).

Field shapes verified against Caddy v2.11.4 and a production instance
behind Cloudflare (2026-08-30 caddy-json spec). ``request.client_ip`` is
Caddy's own trusted_proxies resolution (2.7+), so this adapter never reads
X-Forwarded-For; ``remote_ip`` is the fallback for older logs or filter
configs that delete ``client_ip``. ``ts`` is unix seconds by default but
the encoder is configurable: numbers pick their unit by magnitude and
strings go through ``fromisoformat``. ``duration`` is read as seconds, the
default; the ms/ns variants are numerically indistinguishable from it and
stay unsupported. Caddy logs no upstream timing and no raw request bytes.
"""

import math
from datetime import datetime, timezone

import msgspec

from .base import NormalizedLine, VALID_HTTP_METHODS, convert_dash_to_none, host_from_addr


class CaddyRequest(msgspec.Struct, kw_only=True):
    """The nested ``request`` object; presence marks an access-log line."""

    remote_ip: str | None = None
    client_ip: str | None = None
    proto: str | None = None
    method: str | None = None
    host: str | None = None
    uri: str | None = None
    headers: dict[str, list[str]] | None = None


class CaddyLine(msgspec.Struct, kw_only=True):
    """One access-log entry; user-configurable fields get lenient unions."""

    ts: float | int | str | None = None
    request: CaddyRequest | None = None
    status: int | None = None
    size: int | None = None
    duration: float | int | str | None = None
    user_id: str | None = None


_decoder = msgspec.json.Decoder(CaddyLine)


def _parse_timestamp(raw: float | int | str | None) -> datetime | None:
    if isinstance(raw, (int, float)):
        if raw <= 0:
            return None
        try:
            value = float(raw)
            # Unit by magnitude: seconds below 1e11 (year 5138), millis below
            # 1e14, else nanos. Covers unix_seconds_float (the default),
            # unix_milli_float and unix_nano without ambiguity for real dates.
            if raw < 1e11:
                seconds = value
            elif raw < 1e14:
                seconds = value / 1e3
            else:
                seconds = value / 1e9
            if not math.isfinite(seconds):
                return None
            return datetime.fromtimestamp(seconds, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(raw, str) and raw:
        try:
            ts = datetime.fromisoformat(raw)
        except ValueError:
            return None
        return ts if ts.tzinfo is not None else None
    return None


def _parse_duration(raw: float | int | str | None) -> float | None:
    if not isinstance(raw, (int, float)):
        return None
    try:
        value = float(raw)
    except OverflowError:
        return None
    return value if math.isfinite(value) else None


def _header(headers: dict[str, list[str]] | None, name: str) -> str | None:
    """First value of a header; names arrive Go-canonicalized, exact lookup."""
    if not headers:
        return None
    values = headers.get(name)
    if not values:
        return None
    return convert_dash_to_none(values[0])


class CaddyJsonFormat:
    """Parses one Caddy JSON access-log object per line."""

    name = "caddy-json"

    def parse(self, line: str, *, geo_only: bool = False) -> NormalizedLine | None:
        """Parse one Caddy JSON access-log line into a NormalizedLine.

        Args:
            line: Raw log line (one JSON object).
            geo_only: Only require the client IP and the timestamp
                (send_logs=False mode).

        Returns:
            NormalizedLine on success; None for non-JSON lines, runtime log
            objects without a ``request``, or lines missing the client IP /
            parseable timestamp.
        """
        stripped = line.strip()
        if not stripped.startswith("{"):
            return None
        try:
            data = _decoder.decode(stripped)
        except msgspec.DecodeError:
            # ValidationError (wrong type for a field) is a DecodeError subclass.
            return None
        req = data.request
        if req is None:
            return None

        ip = convert_dash_to_none(req.client_ip) or convert_dash_to_none(req.remote_ip)
        ts = _parse_timestamp(data.ts)
        if ip is None or ts is None:
            return None

        if geo_only:
            return NormalizedLine(ip_address=ip, timestamp=ts)

        if data.status is None:
            return None

        raw_host = convert_dash_to_none(req.host)
        return NormalizedLine(
            ip_address=ip,
            timestamp=ts,
            remote_user=convert_dash_to_none(data.user_id),
            method=convert_dash_to_none(req.method),
            path=convert_dash_to_none(req.uri),
            http_version=convert_dash_to_none(req.proto),
            status_code=data.status,
            bytes_sent=data.size if isinstance(data.size, int) else 0,
            referrer=_header(req.headers, "Referer"),
            user_agent=_header(req.headers, "User-Agent"),
            request_time=_parse_duration(data.duration),
            upstream_response_time=None,
            host=host_from_addr(raw_host) if raw_host else None,
        )

    def detect_malformed(self, norm: NormalizedLine) -> tuple[bool, str | None]:
        """Caddy never logs raw probe garbage; only method validity applies."""
        if norm.method is None:
            return True, "No HTTP method in request"
        if norm.method.upper() not in VALID_HTTP_METHODS:
            return True, f"Invalid HTTP method: {norm.method}"
        return False, None
