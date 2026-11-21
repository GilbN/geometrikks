"""Request and response shapes of the muted IPs API."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated
from uuid import UUID

import msgspec

from geometrikks.domain.muted_ips.networks import NOTE_MAX_LENGTH


class MutedIpView(msgspec.Struct, kw_only=True, rename="camel"):
    """One muted IP or range."""

    id: UUID
    network: Annotated[
        str,
        msgspec.Meta(
            description="The IP or range in CIDR form. A single IP is stored as /32 or /128, host bits are cleared."
        ),
    ]
    note: Annotated[str | None, msgspec.Meta(description="Free text about why it is muted.")]
    created_at: datetime


class CreateMutedIpPayload(msgspec.Struct, kw_only=True, rename="camel", forbid_unknown_fields=True):
    """The IP or range to mute and an optional note."""

    network: Annotated[
        str,
        msgspec.Meta(
            description=(
                "An IPv4 or IPv6 address, or a range in CIDR form. IPv4-mapped IPv6 addresses count as their IPv4 form."
            )
        ),
    ]
    note: Annotated[
        str | None,
        msgspec.Meta(
            description=f"Up to {NOTE_MAX_LENGTH} characters once surrounding whitespace is trimmed. Blank means none."
        ),
    ] = None


