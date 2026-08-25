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


def detect_probe(
    request_raw: str | None, method: str | None, status_code: int
) -> tuple[bool, str | None]:
    """Classify probe garbage and connection-level statuses; shared by the nginx adapters.

    ``request_raw`` arrives in two escapings. The regex format sees nginx's
    default escaping as literal text (``\\x16\\x03``); ``escape=json`` writes
    ``\\u0016\\u0003``, which the JSON decoder turns into raw bytes. Each
    probe therefore has an escaped-text and a raw-bytes branch.

    Args:
        request_raw: The raw request line, or None when the format did not log one.
        method: Normalized HTTP method, None when absent.
        status_code: Response status.

    Returns:
        (is_malformed, reason) with reason None when the request looks normal.
    """
    request = request_raw or ""
    if request:
        if "\\x16\\x03" in request:
            return True, "TLS handshake sent to HTTP port (escaped)"
        if "\x16\x03" in request:
            return True, "TLS handshake sent to HTTP port (raw)"
        if request.startswith("SSH-") or "\\x53\\x53\\x48" in request:
            return True, "SSH probe sent to HTTP port"
        if (
            "\\xffsmb" in request.lower()
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
