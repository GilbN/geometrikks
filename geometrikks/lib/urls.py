"""URL trust checks shared by settings validation and the OIDC client.

Import-time safe: standard library only.
"""

from __future__ import annotations

from ipaddress import ip_address
from urllib.parse import SplitResult, urlsplit


def is_loopback_host(host: str | None) -> bool:
    """True for localhost and loopback addresses (127.0.0.0/8, ::1)."""
    if not host:
        return False
    if host == "localhost":
        return True
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return False


def validate_https_url(value: str, *, name: str) -> SplitResult:
    """Require an absolute http(s) URL; https unless the host is loopback.

    No credentials, query or fragment: these values are used verbatim as
    trust anchors and as browser redirect targets. ``name`` is the setting
    or discovery field the error message refers to.
    """
    try:
        parts = urlsplit(value)
    except ValueError as exc:
        raise ValueError(f"{name} is not a valid URL: {value!r}") from exc
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError(f"{name} must be an absolute http(s) URL, got {value!r}")
    if parts.scheme == "http" and not is_loopback_host(parts.hostname):
        raise ValueError(
            f"{name} must use https (plain http is only allowed on localhost), got {value!r}"
        )
    if parts.username is not None or parts.password is not None or parts.query or parts.fragment:
        raise ValueError(
            f"{name} must not carry credentials, a query string or a fragment, got {value!r}"
        )
    return parts
