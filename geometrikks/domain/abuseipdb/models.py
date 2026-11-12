"""AbuseIPDB reports sent from GeoMetrikks."""
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
