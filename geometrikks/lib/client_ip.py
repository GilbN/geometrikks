"""Resolve the real client IP behind a trusted reverse proxy.

X-Forwarded-For is a plain header any client can send, so it is only
honored when the TCP peer is inside one of the configured trusted-proxy
networks (APP_TRUSTED_PROXIES). Entries are walked right to left; the
first address not belonging to a trusted proxy is the client as seen by
the edge. Every failure mode falls back to the peer address.
"""

from __future__ import annotations

from ipaddress import IPv4Address, IPv6Address, ip_address, ip_network
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Sequence
    from ipaddress import IPv4Network, IPv6Network

    from litestar.connection import ASGIConnection


def _parse_ip(value: str) -> IPv4Address | IPv6Address | None:
    try:
        return ip_address(value.strip().strip("[]"))
    except ValueError:
        return None


def resolve_client_ip(
    connection: ASGIConnection,
    trusted_networks: Sequence[IPv4Network | IPv6Network] | None = None,
) -> str | None:
    """Return the client IP for a connection, honoring trusted proxies.

    Args:
        connection: The request or WebSocket connection.
        trusted_networks: Networks whose X-Forwarded-For is trusted. When
            None, built from ``get_settings().trusted_proxies``.

    Returns:
        The resolved client address, or None when the peer is unknown.
    """
    if trusted_networks is None:
        from geometrikks.config.settings import get_settings

        trusted_networks = [
            ip_network(entry, strict=False) for entry in get_settings().trusted_proxies
        ]

    peer = connection.client.host if connection.client else None
    if peer is None or not trusted_networks:
        return peer

    peer_ip = _parse_ip(peer)
    if peer_ip is None or not any(peer_ip in net for net in trusted_networks):
        return peer

    forwarded = connection.headers.get("x-forwarded-for")
    if not forwarded:
        return peer
    for entry in reversed(forwarded.split(",")):
        entry_ip = _parse_ip(entry)
        if entry_ip is None:
            return peer
        if not any(entry_ip in net for net in trusted_networks):
            return str(entry_ip)
    return peer
