"""Adapter for the project's custom nginx log_format (see README, Nginx setup)."""
from __future__ import annotations

from datetime import datetime, timezone

from geometrikks.server.logging import get_logger
from geometrikks.services.logparser.constants import (
    ipv4_geo_pattern,
    ipv4_pattern,
    ipv6_geo_pattern,
    ipv6_pattern,
)
from .base import NormalizedLine, VALID_HTTP_METHODS, convert_dash_to_none

logger = get_logger(__name__)


class NginxFormat:
    """Parses the custom nginx log_format via the existing regexes."""

    name = "nginx"

    def parse(self, line: str, *, geo_only: bool = False) -> NormalizedLine | None:
        if geo_only:
            matched = ipv4_geo_pattern().match(line) or ipv6_geo_pattern().match(line)
        else:
            matched = ipv4_pattern().match(line) or ipv6_pattern().match(line)
        if not matched:
            return None
        d = matched.groupdict()

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

        try:
            request_time = float(d.get("request_time") or 0)
        except (ValueError, TypeError):
            request_time = 0.0
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
        request = norm.request_raw or ""
        method = norm.method
        status_code = norm.status_code

        if request:
            if "\\x16\\x03" in request:
                return True, "TLS handshake sent to HTTP port (escaped)"
            if "\x16\x03" in request:
                return True, "TLS handshake sent to HTTP port (raw)"
            if request.startswith("SSH-") or "\\x53\\x53\\x48" in request:
                return True, "SSH probe sent to HTTP port"
            if (
                "\\xffSMB" in request.lower()
                or "\xffSMB" in request
                or "SMBr" in request
            ):
                return True, "SMB protocol probe (EternalBlue scanner)"
            if "NT LM" in request:
                return True, "SMB dialect negotiation probe"

        if method is None and status_code == 400:
            return True, "TLS probe: HTTP request sent to HTTPS port"
        if method is None:
            return True, "No HTTP method in request"
        if method.upper() not in VALID_HTTP_METHODS:
            return True, f"Invalid HTTP method: {method}"

        if status_code == 408:
            return True, "Request timeout (408)"
        if status_code == 444:
            return True, "Connection closed without response (nginx 444)"
        if status_code == 499:
            return True, "Client closed connection before response (nginx 499)"

        return False, None
