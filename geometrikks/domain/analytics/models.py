from datetime import date as dt, datetime, timezone

from sqlalchemy import (
    BigInteger,
    Date,
    Float,
    Integer,
    SmallInteger,
    Index,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column
from advanced_alchemy.types import DateTimeUTC
from advanced_alchemy.extensions.litestar import base


class HourlyStats(base.BigIntBase):
    """Hourly aggregated statistics for real-time dashboards.

    Provides high-resolution metrics with 30-day retention.
    Updated in real-time during log ingestion batch commits.
    """

    __tablename__ = "hourly_stats"

    # Time bucket (truncated to hour)
    hour: Mapped[datetime] = mapped_column(
        DateTimeUTC(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc).replace(
            minute=0, second=0, microsecond=0
        ),
    )

    # Request metrics
    total_requests: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    total_geo_events: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    unique_ips: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    unique_countries: Mapped[int] = mapped_column(
        SmallInteger, default=0, nullable=False
    )

    # Bandwidth metrics
    total_bytes_sent: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)

    # Status code distribution
    status_2xx: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status_3xx: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status_4xx: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status_5xx: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # Performance metrics (in seconds)
    avg_request_time: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    max_request_time: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)

    # Malformed/suspicious activity
    malformed_requests: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    __table_args__ = (
        UniqueConstraint("hour", name="uq_hourly_stats_hour"),
        Index("ix_hourly_stats_hour_desc", "hour", postgresql_using="brin"),
    )

    def __repr__(self) -> str:
        return f"<HourlyStats(id={self.id}, hour={self.hour}, requests={self.total_requests})>"


class DailyStats(base.BigIntBase):
    """Daily aggregated statistics for long-term trends.

    Permanent storage for historical analytics (no retention limit).
    Computed from HourlyStats via daily rollup task.
    """

    __tablename__ = "daily_stats"

    # Date for this aggregation
    date: Mapped[dt] = mapped_column(Date, nullable=False)

    # Request metrics
    total_requests: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    total_geo_events: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    unique_ips: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    unique_countries: Mapped[int] = mapped_column(
        SmallInteger, default=0, nullable=False
    )

    # Bandwidth metrics
    total_bytes_sent: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    avg_bytes_per_request: Mapped[float] = mapped_column(
        Float, default=0.0, nullable=False
    )

    # Status code distribution
    status_2xx: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status_3xx: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status_4xx: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status_5xx: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # Performance metrics (in seconds)
    avg_request_time: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    max_request_time: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)

    # Peak hour metrics
    peak_hour_requests: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    peak_hour: Mapped[int] = mapped_column(
        SmallInteger, default=0, nullable=False
    )  # 0-23

    # Malformed/suspicious activity
    malformed_requests: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    __table_args__ = (
        UniqueConstraint("date", name="uq_daily_stats_date"),
        Index("ix_daily_stats_date_desc", "date"),
    )

    def __repr__(self) -> str:
        return f"<DailyStats(id={self.id}, date={self.date}, requests={self.total_requests})>"
