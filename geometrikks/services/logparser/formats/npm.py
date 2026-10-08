"""Adapter for Nginx Proxy Manager's built-in access log formats.

NPM writes its own log formats and gives no per-host way to change them, so
this adapter reads them as they are. Both are defined in NPM's
``docker/rootfs/etc/nginx/conf.d/include/log-proxy.conf``:

- ``proxy``, which proxy hosts write to ``proxy-host-<id>_access.log``::

    [$time_local] $upstream_cache_status $upstream_status $status -
    $request_method $scheme $host "$request_uri" [Client $remote_addr]
    [Length $body_bytes_sent] [Gzip $gzip_ratio] [Sent-to $server]
    "$http_user_agent" "$http_referer"

- ``standard``, for redirection and 404 hosts. It is the same line without
  the two upstream fields and ``[Sent-to ...]``.

``fallback_http_access.log`` holds both: NPM's default servers write
``standard`` to it, and server blocks without their own ``access_log``
inherit an http-level ``proxy`` log to the same file.

``$upstream_status`` is a list when nginx tried several upstreams
(``502, 200`` or ``502 : 200``), so it may contain spaces. The format has no
protocol, remote user, request timings or raw request line. The stream
format (``fallback_stream_access.log``, TCP/UDP streams) carries no HTTP
request and is not an access log this adapter reads.
"""
from __future__ import annotations

import re
from datetime import datetime
from ipaddress import ip_address

from .base import NormalizedLine, classify_method, convert_dash_to_none

_TAIL = (
    r'(?P<method>\S*) \S+ (?P<host>\S*) "(?P<uri>[^"]*)" '
    r"\[Client (?P<ip>[^\]]+)\] \[Length (?P<length>[^\]]*)\] \[Gzip [^\]]*\]"
)
_PROXY = re.compile(
    r"^\[(?P<time>[^\]]+)\] \S+ [-\d ,:]+? (?P<status>\d{3}) - "
    + _TAIL
    + r' \[Sent-to \S*\] "(?P<ua>[^"]*)" "(?P<referrer>[^"]*)"\s*$'
)
_STANDARD = re.compile(
    r"^\[(?P<time>[^\]]+)\] (?P<status>\d{3}) - "
    + _TAIL
    + r' "(?P<ua>[^"]*)" "(?P<referrer>[^"]*)"\s*$'
)
# ip + timestamp only (send_logs=False mode), shared by both formats. Skips
# to the quoted URI rather than to the next '[': the URI and an IPv6-literal
# host can both contain brackets.
_GEO = re.compile(r'^\[(?P<time>[^\]]+)\] [^"]*"[^"]*" \[Client (?P<ip>[^\]]+)\]')


def _parse_timestamp(raw: str) -> datetime | None:
    try:
        return datetime.strptime(raw, "%d/%b/%Y:%H:%M:%S %z")
    except ValueError:
        return None


def _parse_ip(raw: str) -> str | None:
    try:
        return str(ip_address(raw.strip()))
    except ValueError:
        return None


class NpmFormat:
    """Parses Nginx Proxy Manager's ``proxy`` and ``standard`` log formats."""

    name = "npm"

    def parse(self, line: str, *, geo_only: bool = False) -> NormalizedLine | None:
        """Match the line against both NPM formats and normalize it.

        Args:
            line: Raw log line.
            geo_only: Only require the client IP and the timestamp
                (send_logs=False mode).

        Returns:
            NormalizedLine on a match; None for other formats, a client that
            is not an IP address, or an unparseable timestamp.
        """
        if not line.startswith("["):
            return None
        if geo_only:
            matched = _GEO.match(line)
        else:
            matched = _PROXY.match(line) or _STANDARD.match(line)
        if not matched:
            return None

        ip = _parse_ip(matched["ip"])
        ts = _parse_timestamp(matched["time"])
        if ip is None or ts is None:
            return None

        if geo_only:
            return NormalizedLine(ip_address=ip, timestamp=ts)

        try:
            bytes_sent = int(matched["length"])
        except ValueError:
            bytes_sent = 0

        return NormalizedLine(
            ip_address=ip,
            timestamp=ts,
            method=convert_dash_to_none(matched["method"]),
            path=convert_dash_to_none(matched["uri"]),
            status_code=int(matched["status"]),
            bytes_sent=bytes_sent,
            referrer=convert_dash_to_none(matched["referrer"]),
            user_agent=convert_dash_to_none(matched["ua"]),
            host=convert_dash_to_none(matched["host"]),
        )

    def detect_malformed(self, norm: NormalizedLine) -> tuple[bool, str | None]:
        """NPM logs no raw request line; only method validity applies."""
        return classify_method(norm.method)
