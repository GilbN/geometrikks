"""The saved list of IPs and networks hidden from the log views."""

from datetime import datetime

from advanced_alchemy import base
from advanced_alchemy.types import DateTimeUTC
from sqlalchemy import Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import CIDR
from sqlalchemy.orm import Mapped, mapped_column


class MutedIp(base.UUIDBase):
    __tablename__ = "muted_ips"
    __table_args__ = (UniqueConstraint("network", name="uq_muted_ips_network"),)

    network: Mapped[str] = mapped_column(CIDR, nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTimeUTC(timezone=True), nullable=False, server_default=func.now()
    )
