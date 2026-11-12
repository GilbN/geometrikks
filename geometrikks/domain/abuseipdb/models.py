"""AbuseIPDB reports sent from GeoMetrikks, and the local copy of AbuseIPDB's blacklist."""
from datetime import datetime
from typing import Literal
from uuid import UUID

from advanced_alchemy import base
from advanced_alchemy.types import DateTimeUTC
from sqlalchemy import CheckConstraint, ForeignKey, Index, SmallInteger, Text, Uuid, desc
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Mapped, mapped_column

ReportStatus = Literal["unconfirmed", "sent"]
ReporterKind = Literal["user", "api_key", "anonymous"]


class AbuseIpdbReport(base.UUIDBase):
    """One report that may have reached AbuseIPDB, with who sent it."""

    __tablename__ = "abuseipdb_reports"
    __table_args__ = (
        CheckConstraint("status IN ('unconfirmed', 'sent')", name="ck_abuseipdb_reports_status"),
        CheckConstraint(
            "reporter_kind IN ('user', 'api_key', 'anonymous')", name="ck_abuseipdb_reports_reporter_kind"
        ),
    )

    ip_address: Mapped[str] = mapped_column(postgresql.INET, nullable=False)
    categories: Mapped[list[int]] = mapped_column(postgresql.ARRAY(SmallInteger), nullable=False)
    comment: Mapped[str] = mapped_column(Text, nullable=False)
    attack_time: Mapped[datetime] = mapped_column(DateTimeUTC(timezone=True), nullable=False)
    reported_at: Mapped[datetime] = mapped_column(DateTimeUTC(timezone=True), nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    abuse_confidence_score: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    reporter_kind: Mapped[str] = mapped_column(Text, nullable=False)
    reporter_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    api_key_id: Mapped[UUID | None] = mapped_column(
        Uuid,
        ForeignKey("api_keys.id", ondelete="SET NULL", name="fk_abuseipdb_reports_api_key_id_api_keys"),
        nullable=True,
    )


Index("ix_abuseipdb_reports_ip_reported_at", AbuseIpdbReport.ip_address, desc(AbuseIpdbReport.reported_at))


class AbuseIpdbBlacklistEntry(base.DefaultBase):
    """One IP on AbuseIPDB's blacklist. Only the address, since the mark needs nothing else."""

    __tablename__ = "abuseipdb_blacklist"

    ip_address: Mapped[str] = mapped_column(postgresql.INET, primary_key=True)

    def __repr__(self) -> str:
        return f"<AbuseIpdbBlacklistEntry {self.ip_address}>"


class AbuseIpdbBlacklistStatus(base.DefaultBase):
    """The single row saying how current the blacklist is and when a download was last tried."""

    __tablename__ = "abuseipdb_blacklist_status"
    __table_args__ = (CheckConstraint("id = 1", name="single_row"),)

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True, autoincrement=False)
    generated_at: Mapped[datetime | None] = mapped_column(DateTimeUTC(timezone=True), nullable=True)
    refreshed_at: Mapped[datetime | None] = mapped_column(DateTimeUTC(timezone=True), nullable=True)
    last_attempt_at: Mapped[datetime | None] = mapped_column(DateTimeUTC(timezone=True), nullable=True)

    def __repr__(self) -> str:
        return f"<AbuseIpdbBlacklistStatus refreshed_at={self.refreshed_at}>"
