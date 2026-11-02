"""Spamhaus DROP lists: listed networks, listed ASNs and the state of each feed."""
from datetime import datetime

from advanced_alchemy import base
from advanced_alchemy.types import DateTimeUTC
from sqlalchemy import BigInteger, CheckConstraint, Index, Integer, Text
from sqlalchemy.dialects.postgresql import CIDR
from sqlalchemy.orm import Mapped, mapped_column


class DropNetwork(base.DefaultBase):
    """One network from the v4 or v6 DROP feed, keyed by its CIDR."""

    __tablename__ = "drop_networks"
    __table_args__ = (
        Index("ix_drop_networks_cidr_gist", "cidr", postgresql_using="gist", postgresql_ops={"cidr": "inet_ops"}),
    )

    cidr: Mapped[str] = mapped_column(CIDR, primary_key=True)
    sbl_id: Mapped[str] = mapped_column(Text, nullable=False)
    rir: Mapped[str | None] = mapped_column(Text, nullable=True)

    def __repr__(self) -> str:
        return f"<DropNetwork {self.cidr} {self.sbl_id}>"


class DropAsn(base.DefaultBase):
    """One ASN from the ASN-DROP feed."""

    __tablename__ = "drop_asns"

    asn: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=False)
    name: Mapped[str | None] = mapped_column(Text, nullable=True)
    country_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    rir: Mapped[str | None] = mapped_column(Text, nullable=True)
    domain: Mapped[str | None] = mapped_column(Text, nullable=True)

    def __repr__(self) -> str:
        return f"<DropAsn AS{self.asn}>"


class DropListState(base.DefaultBase):
    """Upstream metadata and the last fetch outcome of one feed (v4, v6 or asn)."""

    __tablename__ = "drop_list_state"
    __table_args__ = (CheckConstraint("feed IN ('v4', 'v6', 'asn')", name="feed"),)

    feed: Mapped[str] = mapped_column(Text, primary_key=True)
    upstream_timestamp: Mapped[datetime | None] = mapped_column(DateTimeUTC(timezone=True), nullable=True)
    record_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    copyright: Mapped[str | None] = mapped_column(Text, nullable=True)
    fetched_at: Mapped[datetime | None] = mapped_column(DateTimeUTC(timezone=True), nullable=True)
    checked_at: Mapped[datetime | None] = mapped_column(DateTimeUTC(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    def __repr__(self) -> str:
        return f"<DropListState {self.feed}>"
