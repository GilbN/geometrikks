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

import math
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
    request_time: float | None = None
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


def parse_seconds(raw: str | None) -> float | None:
    """A timing in seconds, or None when the line carries no measurement.

    '', '-' and unparseable text are absence. nan and inf parse as floats
    but are not measurements either.
    """
    if not raw or raw.strip() == "-":
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def detect_probe(
    request_raw: str | None, method: str | None, status_code: int
) -> tuple[bool, str | None]:
    """Classify probe garbage; shared by the nginx adapters.

    Status codes are not a signal. 408, 444 and 499 used to mark a line
    malformed, but a 444 is usually a block rule and a 499 is a client that
    gave up, both well-formed requests the server chose not to answer.

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

    # TLS handshake sent to HTTP port - starts with \x16\x03 (TLS record header)
    # Common patterns: \x16\x03\x01 (TLS 1.0), \x16\x03\x03 (TLS 1.2/1.3)
    # Check both escaped string representation and raw bytes
    if request:
        # Escaped form in log: \x16\x03 (nginx default escaping, regex format)
        if "\\x16\\x03" in request:
            return True, "TLS handshake sent to HTTP port (escaped)"
        # Raw bytes form: what the JSON decoder yields for escape=json's \u0016\u0003
        if "\x16\x03" in request:
            return True, "TLS handshake sent to HTTP port (raw)"
        # SSH probe
        if request.startswith("SSH-") or "\\x53\\x53\\x48" in request:
            return True, "SSH probe sent to HTTP port"
        # SMB probe - \xFFSMB or escaped \x00...\xFFSMB
        if (
            "\\xffsmb" in request.lower()
            or "\xffSMB" in request
            or "SMBr" in request
        ):
            return True, "SMB protocol probe (EternalBlue scanner)"
        if "NT LM" in request:
            return True, "SMB dialect negotiation probe"

    # TLS probe: No HTTP method and 400 status (client sent HTTP to HTTPS port)
    if method is None and status_code == 400:
        return True, "TLS probe: HTTP request sent to HTTPS port"
    # Invalid HTTP method (connection closed before sending valid request)
    if method is None:
        return True, "No HTTP method in request"
    # Check for non-standard/invalid HTTP methods
    if method.upper() not in VALID_HTTP_METHODS:
        return True, f"Invalid HTTP method: {method}"

    return False, None
