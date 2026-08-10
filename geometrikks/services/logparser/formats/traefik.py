"""Adapter for Traefik JSON access logs (accessLog.format: json).

Field reference verified against Traefik v2.11/v3.x source
(pkg/middlewares/accesslog/): Duration/OriginDuration are integer
nanoseconds; ClientHost is the raw X-Forwarded-For value (possibly a
comma-separated chain) when XFF is present, else the peer IP; header
fields (request_User-Agent, request_Referer) exist only when the user
keeps headers; every line also carries logrus level/msg/time keys.
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from .base import NormalizedLine, VALID_HTTP_METHODS, convert_dash_to_none


def _host_from_addr(addr: str) -> str:
    """IP from an 'IP:port' / '[v6]:port' ClientAddr; best effort."""
    if addr.startswith("["):
        end = addr.find("]")
        return addr[1:end] if end > 0 else addr
    if addr.count(":") == 1:
        return addr.rsplit(":", 1)[0]
    return addr


def _parse_timestamp(data: dict[str, Any]) -> datetime | None:
    for key in ("StartUTC", "StartLocal", "time"):
        raw = data.get(key)
        if isinstance(raw, str) and raw:
            try:
                # fromisoformat handles 'Z' and long fractions on 3.11+
                return datetime.fromisoformat(raw)
            except ValueError:
                continue
    return None


class TraefikJsonFormat:
    """Parses one Traefik JSON access-log object per line."""

    name = "traefik-json"

    def parse(self, line: str, *, geo_only: bool = False) -> NormalizedLine | None:
        """Parse one Traefik JSON access-log line into a NormalizedLine.

        Args:
            line: Raw log line (one JSON object).
            geo_only: Only require the client IP and the timestamp
                (send_logs=False mode).

        Returns:
            NormalizedLine on success; None for non-JSON lines, non-access-log
            objects (e.g. fields.defaultMode drop leftovers), or lines missing
            the client IP / timestamp.
        """
        stripped = line.strip()
        if not stripped.startswith("{"):
            return None
        try:
            data = json.loads(stripped)
        except json.JSONDecodeError:
            return None
        if not isinstance(data, dict):
            return None

        ip = data.get("ClientHost") or ""
        if "," in ip:
            ip = ip.split(",", 1)[0]
        ip = ip.strip()
        if not ip:
            ip = _host_from_addr(str(data.get("ClientAddr") or ""))
        ts = _parse_timestamp(data)
        if not ip or ts is None:
            return None

        if geo_only:
            return NormalizedLine(ip_address=ip, timestamp=ts)

        status = data.get("DownstreamStatus")
        if not isinstance(status, int):
            # fields.defaultMode drop, or not an access-log object at all
            return None

        duration_ns = data.get("Duration")
        request_time = (
            duration_ns / 1e9 if isinstance(duration_ns, (int, float)) else 0.0
        )
        origin_ns = data.get("OriginDuration")
        upstream = (
            origin_ns / 1e9
            if isinstance(origin_ns, (int, float)) and origin_ns > 0
            else None
        )
        bytes_sent = data.get("DownstreamContentSize")

        return NormalizedLine(
            ip_address=ip,
            timestamp=ts,
            remote_user=convert_dash_to_none(data.get("ClientUsername")),
            method=convert_dash_to_none(data.get("RequestMethod")),
            path=convert_dash_to_none(data.get("RequestPath")),
            http_version=convert_dash_to_none(data.get("RequestProtocol")),
            status_code=status,
            bytes_sent=bytes_sent if isinstance(bytes_sent, int) else 0,
            referrer=convert_dash_to_none(data.get("request_Referer")),
            user_agent=convert_dash_to_none(data.get("request_User-Agent")),
            request_time=request_time,
            upstream_response_time=upstream,
            host=convert_dash_to_none(data.get("RequestHost"))
            or convert_dash_to_none(data.get("RequestAddr")),
        )

    def detect_malformed(self, norm: NormalizedLine) -> tuple[bool, str | None]:
        """Traefik never logs raw probe garbage; only method validity applies."""
        if norm.method is None:
            return True, "No HTTP method in request"
        if norm.method.upper() not in VALID_HTTP_METHODS:
            return True, f"Invalid HTTP method: {norm.method}"
        return False, None
