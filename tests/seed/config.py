"""Settings for one seeding run."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone


# Ten years; also keeps the window start clear of datetime overflow.
MAX_DAYS = 3650


class SeedError(RuntimeError):
    """The seed cannot run as asked; the message says why."""


@dataclass(frozen=True, slots=True)
class SeedConfig:
    """What to generate.

    Attributes:
        rows: Requests to write. Each is an access log plus a geo event, the
            pair live ingestion writes for a public IP it can place.
        days: How far back the traffic reaches from ``end``.
        seed: Random seed. The same seed and GeoLite2 build give the same visitors.
        visitors: Distinct client IPs; None scales with ``rows``.
        servers: Server names to record the traffic under, one host group and
            log format each.
        home_country: ISO code that most human visitors come from, as on a
            homelab whose users are local. None spreads them worldwide.
        home_share: Fraction of human visitors placed in ``home_country``.
        debug_share: Fraction of well-formed rows that also keep their raw line
            in access_log_debug, as with LOGPARSER_STORE_DEBUG_LINES. Probe
            lines are always kept.
        batch_size: Rows per COPY round trip.
        end: Newest timestamp.
    """

    rows: int = 100_000
    days: float = 30
    seed: int = 42
    visitors: int | None = None
    servers: tuple[str, ...] = ("seed-edge", "seed-nas")
    home_country: str | None = None
    home_share: float = 0.4
    debug_share: float = 0.02
    batch_size: int = 20_000
    end: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def __post_init__(self) -> None:
        if self.rows < 1:
            raise ValueError("rows must be at least 1")
        if not 0 < self.days <= MAX_DAYS:
            raise ValueError(f"days must be above 0 and at most {MAX_DAYS}")
        if not self.servers or any(not name.strip() for name in self.servers):
            raise ValueError("servers needs at least one non-empty name")
        if self.end.tzinfo is None:
            raise ValueError("end must be timezone-aware")
        if self.batch_size < 1:
            raise ValueError("batch_size must be at least 1")
        if self.visitors is not None and self.visitors < 1:
            raise ValueError("visitors must be at least 1")
        for name in ("home_share", "debug_share"):
            if not 0 <= getattr(self, name) <= 1:
                raise ValueError(f"{name} must be between 0 and 1")

    @property
    def start(self) -> datetime:
        return self.end - timedelta(days=self.days)

    @property
    def visitor_count(self) -> int:
        return self.visitors if self.visitors is not None else max(100, min(20_000, self.rows // 40))
