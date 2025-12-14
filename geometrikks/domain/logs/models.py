from datetime import datetime, timezone
from typing import Optional

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
from advanced_alchemy.extensions.litestar import base
from litestar.dto import dto_field


class AccessLog(base.BigIntBase):
    """Detailed nginx access log entries.
    
    Stores comprehensive request/response data from nginx access logs.
    High-volume time-series data with partitioning support.
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
    method: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    http_version: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    
    # Response details
    # SmallInteger: 2 bytes (0-65535) vs Integer 4 bytes - sufficient for HTTP status codes
    status_code: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    bytes_sent: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    
    # Referrer and User-Agent
    # Referrer may be absent entirely
    referrer: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    user_agent: Mapped[Optional[str]] = mapped_column(Text)
    
    # Performance metrics
    request_time: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    connect_time: Mapped[Optional[float]] = mapped_column(Float, nullable=True, default=None)
    
    # Host information (may be missing on malformed lines)
    host: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    
    # Geographic information
    country_code: Mapped[Optional[str]] = mapped_column(String(2))
    country_name: Mapped[Optional[str]] = mapped_column(String(100))
    city: Mapped[Optional[str]] = mapped_column(String(100))
    
    # Indexes optimized for common queries
    __table_args__ = (
        Index("ix_access_logs_timestamp_desc", "timestamp", postgresql_using="brin"),
        Index("ix_access_logs_ip_timestamp", "ip_address", "timestamp"),
        Index("ix_access_logs_host_timestamp", "host", "timestamp"),
        Index("ix_access_logs_status_timestamp", "status_code", "timestamp"),
        Index("ix_access_logs_country_timestamp", "country_code", "timestamp"),
        Index("ix_access_logs_method_status", "method", "status_code"),
    )
    
    def __repr__(self) -> str:
        return f"<AccessLog(id={self.id}, ip={self.ip_address}, method={self.method}, status={self.status_code}, timestamp={self.timestamp})>"


class AccessLogDebug(base.BigIntBase):
    """Debug storage for raw log lines with automatic retention.
    
    Stores raw log lines for debugging purposes, particularly useful for
    diagnosing malformed requests (TLS probes, invalid HTTP, etc.).
    Retention is managed via scheduled cleanup task.
    """
    
    __tablename__ = "access_log_debug"
    
    access_log_id: Mapped[Optional[int]] = mapped_column(
        BigInteger,
        ForeignKey("access_logs.id", ondelete="SET NULL"),
        nullable=True,
        unique=True,
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
    parse_error: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    
    access_log: Mapped[Optional["AccessLog"]] = relationship(
        "AccessLog", foreign_keys=[access_log_id], lazy="joined"
    )
    
    # BRIN index for efficient retention cleanup by time
    __table_args__ = (
        Index("ix_access_log_debug_created_at", "created_at", postgresql_using="brin"),
    )
    
    def __repr__(self) -> str:
        return f"<AccessLogDebug(id={self.id}, access_log_id={self.access_log_id}, is_malformed={self.is_malformed})>"
