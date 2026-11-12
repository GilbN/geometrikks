"""Repositories for AbuseIPDB reports and the blacklist."""
import ipaddress
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from advanced_alchemy.repository import SQLAlchemyAsyncRepository
from sqlalchemy import Text, cast, delete, func, insert, or_, select
from sqlalchemy.dialects import postgresql

from geometrikks.domain.abuseipdb.models import (
    AbuseIpdbBlacklistEntry,
    AbuseIpdbBlacklistStatus,
    AbuseIpdbReport,
    ReportStatus,
)

BLACKLIST_STATUS_ID = 1


@dataclass(frozen=True)
class ReportedIp:
    ip_address: str
    reported_at: datetime
    status: ReportStatus


def _ip_search_prefix(q: str) -> str:
    """What a matching address starts with. A whole address searches as its canonical spelling."""
    try:
        address = ipaddress.ip_address(q)
    except ValueError:
        return q.lower()
    if isinstance(address, ipaddress.IPv6Address):
        address = address.ipv4_mapped or address
    return str(address)


class AbuseIpdbReportRepository(SQLAlchemyAsyncRepository[AbuseIpdbReport]):
    model_type = AbuseIpdbReport

    def _detached(self, reports: Sequence[AbuseIpdbReport]) -> list[AbuseIpdbReport]:
        for report in reports:
            # asyncpg decodes INET into ipaddress objects; detach first so reassigning a str
            # doesn't dirty the row and issue an UPDATE.
            self.session.expunge(report)
            report.ip_address = str(report.ip_address)
        return list(reports)

    async def latest_reported_at(self, ip: str) -> datetime | None:
        statement = select(func.max(AbuseIpdbReport.reported_at)).where(
            AbuseIpdbReport.ip_address == cast(ip, postgresql.INET)
        )
        return (await self.session.execute(statement)).scalar_one()

    async def list_for_ip(self, ip: str) -> list[AbuseIpdbReport]:
        """Newest first. The rows come back detached, including instances the caller already holds in this session."""
        statement = (
            select(AbuseIpdbReport)
            .where(AbuseIpdbReport.ip_address == cast(ip, postgresql.INET))
            .order_by(AbuseIpdbReport.reported_at.desc())
        )
        return self._detached(list((await self.session.execute(statement)).scalars()))

    async def list_page(
        self,
        *,
        limit: int,
        offset: int,
        q: str | None = None,
        categories: Sequence[int] | None = None,
        statuses: Sequence[ReportStatus] | None = None,
    ) -> tuple[list[AbuseIpdbReport], int]:
        """One page of the reports that match, newest first, and how many match in all.

        ``q`` matches the start of the IP, or part of the comment or the sender's name.
        A report needs any one of ``categories`` and any one of ``statuses``.
        """
        conditions = []
        if q:
            conditions.append(
                or_(
                    func.host(AbuseIpdbReport.ip_address, type_=Text).startswith(_ip_search_prefix(q), autoescape=True),
                    AbuseIpdbReport.comment.icontains(q, autoescape=True),
                    AbuseIpdbReport.reporter_name.icontains(q, autoescape=True),
                )
            )
        if categories:
            conditions.append(AbuseIpdbReport.categories.overlap(list(categories)))
        if statuses:
            conditions.append(AbuseIpdbReport.status.in_(statuses))

        total_statement = select(func.count()).select_from(AbuseIpdbReport).where(*conditions)
        total = (await self.session.execute(total_statement)).scalar_one()
        statement = (
            select(AbuseIpdbReport)
            .where(*conditions)
            .order_by(AbuseIpdbReport.reported_at.desc(), AbuseIpdbReport.id.desc())
            .limit(limit)
            .offset(offset)
        )
        return self._detached(list((await self.session.execute(statement)).scalars())), total

    async def reported_ips(self, since: datetime) -> list[ReportedIp]:
        statement = (
            select(AbuseIpdbReport.ip_address, AbuseIpdbReport.reported_at, AbuseIpdbReport.status)
            .where(AbuseIpdbReport.reported_at >= since)
            .distinct(AbuseIpdbReport.ip_address)
            .order_by(AbuseIpdbReport.ip_address, AbuseIpdbReport.reported_at.desc())
        )
        return [
            ReportedIp(ip_address=str(ip_address), reported_at=reported_at, status=status)
            for ip_address, reported_at, status in (await self.session.execute(statement)).all()
        ]


class AbuseIpdbBlacklistRepository(SQLAlchemyAsyncRepository[AbuseIpdbBlacklistEntry]):
    model_type = AbuseIpdbBlacklistEntry

    async def status(self) -> AbuseIpdbBlacklistStatus | None:
        statement = select(AbuseIpdbBlacklistStatus).where(AbuseIpdbBlacklistStatus.id == BLACKLIST_STATUS_ID)
        return (await self.session.execute(statement)).scalar_one_or_none()

    async def ips(self) -> list[str]:
        statement = select(AbuseIpdbBlacklistEntry.ip_address).order_by(AbuseIpdbBlacklistEntry.ip_address)
        return [str(ip_address) for ip_address in (await self.session.execute(statement)).scalars()]

    async def claim_attempt(self, now: datetime, *, last_allowed: datetime) -> bool:
        """Record an attempt at ``now`` unless one happened after ``last_allowed``; False means it did."""
        statement = (
            postgresql.insert(AbuseIpdbBlacklistStatus)
            .values(id=BLACKLIST_STATUS_ID, last_attempt_at=now)
            .on_conflict_do_update(
                index_elements=["id"],
                set_={"last_attempt_at": now},
                where=or_(
                    AbuseIpdbBlacklistStatus.last_attempt_at.is_(None),
                    AbuseIpdbBlacklistStatus.last_attempt_at <= last_allowed,
                ),
            )
            .returning(AbuseIpdbBlacklistStatus.id)
        )
        return (await self.session.execute(statement)).first() is not None

    async def replace(self, ips: Sequence[str], *, generated_at: datetime, refreshed_at: datetime) -> None:
        """Swap the rows and the status inside the caller's transaction."""
        await self.session.execute(delete(AbuseIpdbBlacklistEntry))
        await self.session.execute(insert(AbuseIpdbBlacklistEntry), [{"ip_address": ip} for ip in ips])
        status_values = {"generated_at": generated_at, "refreshed_at": refreshed_at}
        statement = postgresql.insert(AbuseIpdbBlacklistStatus).values(id=BLACKLIST_STATUS_ID, **status_values)
        await self.session.execute(statement.on_conflict_do_update(index_elements=["id"], set_=status_values))
