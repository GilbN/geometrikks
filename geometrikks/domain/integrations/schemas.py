"""Small dashboard responses with explicit per-section availability."""

from datetime import datetime
from typing import Annotated, Generic, Literal, TypeVar

import msgspec

from geometrikks.domain.analytics.dtos import PeriodSummary
from geometrikks.domain.system.controllers.health import IngestionHealth

DataT = TypeVar("DataT")
SummaryReason = Literal[
    "disabled", "not_running", "not_started", "services_inactive", "database_unavailable",
    "crowdsec_unreachable", "crowdsec_timeout", "crowdsec_credentials_rejected", "invalid_response",
]


class SummarySection(msgspec.Struct, Generic[DataT], rename="camel", kw_only=True):
    """Unavailable sections have a reason and null data; available sections may contain zero counts."""

    available: bool
    reason: SummaryReason | None = None
    data: DataT | None = None


class TrafficSummary(msgspec.Struct, rename="camel", kw_only=True):
    """Uses analytics/summary semantics, including whole aggregate buckets above 24 hours."""

    totals: PeriodSummary
    latest_event_at: Annotated[
        datetime | None,
        msgspec.Meta(description=(
            "Latest retained access-log timestamp in the requested window, not ingestion or commit time. "
            "Null when no raw rows remain in that window, even if aggregate totals are nonzero."
        )),
    ]


class InstanceSummary(msgspec.Struct, rename="camel", kw_only=True):
    """One instance using the same health evaluation as the instances API."""

    instance_name: str
    mode: str
    checking_in: bool
    status: Literal["ok", "warning", "critical"]
    last_seen: datetime
    last_parsed_at: Annotated[
        str | None, msgspec.Meta(
            description="The process's last parsed-record time from its heartbeat, not a commit time.",
            extra_json_schema={"format": "date-time"},
        )
    ]


class InstancesSummary(msgspec.Struct, rename="camel", kw_only=True):
    """Head and agent heartbeat counts, with their individual states."""

    checked_at: datetime
    total: int
    checking_in: int
    warning: int
    critical: int
    items: list[InstanceSummary]


class CrowdSecSummary(msgspec.Struct, rename="camel", kw_only=True):
    """Current decisions across all scopes and origins, counted by one bounded LAPI request."""

    active_decisions: int
    write_enabled: bool
    checked_at: datetime


class IntegrationSummary(msgspec.Struct, rename="camel", kw_only=True):
    """A dashboard overview whose sections are observed in sequence, not one atomic snapshot."""

    generated_at: datetime
    start_date: datetime
    end_date: datetime
    traffic: SummarySection[TrafficSummary]
    instances: SummarySection[InstancesSummary]
    ingestion: Annotated[
        SummarySection[IngestionHealth],
        msgspec.Meta(description="This head process only. Agent ingestion freshness is in instances.items[].lastParsedAt."),
    ]
    crowdsec: SummarySection[CrowdSecSummary]
