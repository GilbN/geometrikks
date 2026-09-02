from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    Float,
    SmallInteger,
    String,
    Text,
    Index,
    ForeignKey,
)

from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Mapped, mapped_column, relationship
from advanced_alchemy.types import DateTimeUTC
from advanced_alchemy import base
from litestar.dto import dto_field


class AccessLog(base.BigIntBase):
    """Detailed web server access log entries.

    Stores comprehensive request/response data from web server access logs.
    TimescaleDB hypertable for efficient time-series queries.
    """
    
    __tablename__ = "access_logs"
        
    # Timestamp from the log entry
    timestamp: Mapped[datetime] = mapped_column(
        DateTimeUTC(timezone=True),
        nullable=False,
        info=dto_field("read-only")
    )
    
    # Request metadata
    ip_address: Mapped[str] = mapped_column(postgresql.INET, nullable=False)
    remote_user: Mapped[str] = mapped_column(String(100), nullable=True)
    
    # HTTP request details
    # Some malformed TLS-handshake lines won't have method/url/http_version
    # For example, when China is fucking around, a log line can look like this:
    # 101.91.110.24 - - [23/Nov/2025:02:02:55 +0100]"\x16\x03\x01\x01-\x01\x00\x01)\x03\x03kf\xB1\x19\xED\xF9i\xE1\xBE\xEB\xDAv\xD61Z\xD5\xB0jxp\x01\x12\x87\x86\x0B\x99o\xC59\xA0\xA9\xEA {`V\x1D\xE3\xFF\xAF\xF9\x16\xCF;\xA6\xB3}\xBB" 400 150"-" _ "-""0.362" "-""Shanghai" "CN"
    method: Mapped[str | None] = mapped_column(String(32), nullable=True)
    url: Mapped[str | None] = mapped_column(Text, nullable=True)
    http_version: Mapped[str | None] = mapped_column(String(10), nullable=True)
    
    # Response details
    # SmallInteger: 2 bytes (0-65535) vs Integer 4 bytes - sufficient for HTTP status codes
    status_code: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    bytes_sent: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    
    # Referrer and User-Agent
    # Referrer may be absent entirely
    referrer: Mapped[str | None] = mapped_column(Text, nullable=True)
    user_agent: Mapped[str | None] = mapped_column(Text)
    
    # Performance metrics
    request_time: Mapped[float | None] = mapped_column(Float, nullable=True)
    upstream_response_time: Mapped[float | None] = mapped_column(Float, nullable=True, default=None)
    
    # Host information (may be missing on malformed lines)
    host: Mapped[str | None] = mapped_column(String(255), nullable=True)
    
    # Geographic information
    country_code: Mapped[str | None] = mapped_column(String(2))
    country_name: Mapped[str | None] = mapped_column(String(100))
    city: Mapped[str | None] = mapped_column(String(100))

    # ASN enrichment from GeoLite2-ASN; NULL on rows ingested without the
    # database (pre-feature history, or ASN disabled/unavailable).
    # BigInteger: 4-byte ASNs run to 4294967295, past signed 32-bit.
    autonomous_system_number: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    autonomous_system_organization: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Multi-source separation: which GeoMetrikks instance wrote the row
    # (LOGPARSER_HOST_NAME, mirrors geo_events.hostname) and which format
    # adapter parsed it ('nginx', 'traefik-json'). NULL on pre-feature rows
    # the backfill could not attribute.
    hostname: Mapped[str | None] = mapped_column(String(255), nullable=True)
    log_format: Mapped[str | None] = mapped_column(String(32), nullable=True)

    # Indexes for common queries
    # Note: TimescaleDB automatically creates time-based indexes on hypertables
    __table_args__ = (
        Index("ix_access_logs_ip_address", "ip_address"),
        Index("ix_access_logs_status_code", "status_code"),
        Index("ix_access_logs_host", "host"),
        Index("ix_access_logs_method_status", "method", "status_code"),
        Index("ix_access_logs_hostname", "hostname"),
        Index("ix_access_logs_asn", "autonomous_system_number"),
    )
    
    def __repr__(self) -> str:
        return f"<AccessLog(id={self.id}, ip={self.ip_address}, method={self.method}, status={self.status_code}, timestamp={self.timestamp})>"


class AccessLogDebug(base.BigIntBase):
    """Debug storage for raw log lines with automatic retention.

    Stores raw log lines for debugging purposes, particularly useful for
    diagnosing malformed requests (TLS probes, invalid HTTP, etc.).
    TimescaleDB hypertable for efficient time-series queries.

    Note: FK to access_logs removed due to TimescaleDB limitation (can't FK to hypertable).
    access_log_id is kept as soft reference for application-level lookups.
    """

    __tablename__ = "access_log_debug"

    # Soft reference to access_logs (no FK constraint - TimescaleDB limitation)
    access_log_id: Mapped[int | None] = mapped_column(
        BigInteger,
        nullable=True,
        index=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTimeUTC(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        info=dto_field("read-only")
    )

    raw_line: Mapped[str] = mapped_column(Text, nullable=False, info=dto_field("read-only"))

    is_malformed: Mapped[bool] = mapped_column(default=False, index=True)
    parse_error: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Denormalized access-log context, copied from the linked access_logs row
    # at ingestion time. The debug list filters, sorts and displays entirely
    # from these columns so it never touches the access_logs hypertable: 97 of
    # its 104 chunks are compressed with orderby=timestamp and no segmentby, so
    # a lookup by id/ip/geo decompresses whole chunks. The old LEFT JOIN cost
    # 64s at LIMIT 20 on 17M rows. NULL when the raw line never parsed into an
    # access_logs row.
    log_timestamp: Mapped[datetime | None] = mapped_column(
        DateTimeUTC(timezone=True), nullable=True
    )
    ip_address: Mapped[str | None] = mapped_column(postgresql.INET, nullable=True)
    method: Mapped[str | None] = mapped_column(String(32), nullable=True)
    url: Mapped[str | None] = mapped_column(Text, nullable=True)
    host: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status_code: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    country_code: Mapped[str | None] = mapped_column(String(2), nullable=True)
    country_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    city: Mapped[str | None] = mapped_column(String(100), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Only the IN-list filters get indexes. The table is small and under
    # retention; the sort columns do not need their own indexes at this size.
    __table_args__ = (
        Index("ix_access_log_debug_ip_address", "ip_address"),
        Index("ix_access_log_debug_country_code", "country_code"),
        Index("ix_access_log_debug_city", "city"),
    )

    def __repr__(self) -> str:
        return f"<AccessLogDebug(id={self.id}, access_log_id={self.access_log_id}, is_malformed={self.is_malformed})>"
