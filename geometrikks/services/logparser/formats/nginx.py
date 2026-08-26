"""Adapter for the project's custom nginx log_format (see README, Nginx setup)."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from geometrikks.server.logging import get_logger
from geometrikks.services.logparser.constants import (
    ipv4_geo_pattern,
    ipv4_pattern,
    ipv6_geo_pattern,
    ipv6_pattern,
)
from .base import NormalizedLine, convert_dash_to_none, detect_probe, parse_seconds

logger = get_logger(__name__)


class NginxFormat:
    """Parses the custom nginx log_format via the existing regexes."""

    name = "nginx"

    def parse(self, line: str, *, geo_only: bool = False) -> NormalizedLine | None:
        """Validate the line against the IPv4/IPv6 patterns and normalize it.

        Args:
            line: Raw log line.
            geo_only: Only require the IP address and the timestamp (send_logs=False mode).

        Returns:
            NormalizedLine on a match, None when the line does not match.
        """
        if geo_only:
            matched = ipv4_geo_pattern().match(line) or ipv6_geo_pattern().match(line)
        else:
            matched = ipv4_pattern().match(line) or ipv6_pattern().match(line)
        if not matched:
            return None
        d: dict[str, str | Any] = matched.groupdict()

        try:
            ts = datetime.strptime(d["dateandtime"], "%d/%b/%Y:%H:%M:%S %z")
        except Exception as e:
            logger.error("Failed to parse timestamp '%s': %s", d.get("dateandtime"), e)
            ts = datetime.now(timezone.utc)

        if geo_only:
            return NormalizedLine(
                ip_address=matched.group(1),
                timestamp=ts,
                remote_user=convert_dash_to_none(d.get("remote_user")),
            )

        request_time = parse_seconds(d.get("request_time"))
        upstream_raw = d.get("upstream_response_time")
        try:
            upstream = (
                float(upstream_raw)
                if upstream_raw and upstream_raw != "-"
                else None
            )
        except (ValueError, TypeError):
            upstream = None
        try:
            status_code = int(d.get("status_code") or 0)
        except (ValueError, TypeError):
            status_code = 0
        try:
            bytes_sent = int(d.get("bytes_sent") or 0)
        except (ValueError, TypeError):
            bytes_sent = 0

        return NormalizedLine(
            ip_address=matched.group(1),
            timestamp=ts,
            remote_user=convert_dash_to_none(d.get("remote_user")),
            method=convert_dash_to_none(d.get("method")),
            # Historical group names are crossed: 'referrer' captures the URI
            # inside "$request", 'url' captures $http_referer.
            path=convert_dash_to_none(d.get("referrer")),
            referrer=convert_dash_to_none(d.get("url")),
            http_version=convert_dash_to_none(d.get("http_version")),
            status_code=status_code,
            bytes_sent=bytes_sent,
            user_agent=convert_dash_to_none(d.get("user_agent")),
            request_time=request_time,
            upstream_response_time=upstream,
            host=convert_dash_to_none(d.get("host")),
            request_raw=d.get("request", ""),
        )

    def detect_malformed(self, norm: NormalizedLine) -> tuple[bool, str | None]:
        """Probe and connection-status classification; see ``detect_probe``."""
        return detect_probe(norm.request_raw, norm.method, norm.status_code)
