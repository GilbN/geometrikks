"""Format-agnostic normalized line shape and the adapter protocol.

Semantics are fixed here and identical for every format:
- ``path`` is the request target (nginx: the URI inside "$request";
  traefik: RequestPath). Persisted to the ``url`` column.
- ``referrer`` is the HTTP Referer header. Persisted to the ``referrer``
  column.
The historical nginx regex group names have these two crossed; adapters are
the single place where that gets corrected.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, runtime_checkable


@dataclass
class NormalizedLine:
    """One parsed access-log line, format quirks already resolved."""

    ip_address: str
    timestamp: datetime
    remote_user: str | None = None
    method: str | None = None
    path: str | None = None
    http_version: str | None = None
    status_code: int = 0
    bytes_sent: int = 0
    referrer: str | None = None
    user_agent: str | None = None
    request_time: float = 0.0
    upstream_response_time: float | None = None
    host: str | None = None
    # Raw request-line text ("GET / HTTP/1.1" or probe garbage); nginx only,
    # consumed by malformed-request detection.
    request_raw: str | None = None


@runtime_checkable
class LogLineFormat(Protocol):
    """One access-log line format (nginx custom, traefik JSON, ...)."""

    name: str

    def parse(self, line: str, *, geo_only: bool = False) -> NormalizedLine | None:
        """Parse one raw line; None when the line does not match this format.

        geo_only relaxes requirements to ip + timestamp (send_logs=False mode).
        """
        ...

    def detect_malformed(self, norm: NormalizedLine) -> tuple[bool, str | None]:
        """(is_malformed, reason) for probe/garbage detection; format-specific."""
        ...


VALID_HTTP_METHODS: frozenset[str] = frozenset(
    {"GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "CONNECT", "TRACE"}
)


def convert_dash_to_none(value: str | None) -> str | None:
    """'-' and '' mean absent in access logs; normalize to None."""
    if value is None:
        return None
    stripped = value.strip()
    return stripped if stripped not in ("", "-") else None
