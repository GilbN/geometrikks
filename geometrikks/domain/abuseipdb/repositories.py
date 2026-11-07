"""Repository for AbuseIPDB reports."""
from dataclasses import dataclass
from datetime import datetime

from advanced_alchemy.repository import SQLAlchemyAsyncRepository
from sqlalchemy import cast, func, select
from sqlalchemy.dialects import postgresql

from geometrikks.domain.abuseipdb.models import AbuseIpdbReport, ReportStatus


@dataclass(frozen=True)
class ReportedIp:
    ip_address: str
    reported_at: datetime
    status: ReportStatus


class AbuseIpdbReportRepository(SQLAlchemyAsyncRepository[AbuseIpdbReport]):
    model_type = AbuseIpdbReport

    async def latest_reported_at(self, ip: str) -> datetime | None:
        statement = select(func.max(AbuseIpdbReport.reported_at)).where(
            AbuseIpdbReport.ip_address == cast(ip, postgresql.INET)
        )
        return (await self.session.execute(statement)).scalar_one()

    async def list_for_ip(self, ip: str) -> list[AbuseIpdbReport]:
        statement = (
            select(AbuseIpdbReport)
            .where(AbuseIpdbReport.ip_address == cast(ip, postgresql.INET))
            .order_by(AbuseIpdbReport.reported_at.desc())
        )
        reports = list((await self.session.execute(statement)).scalars())
        for report in reports:
            # asyncpg decodes INET into ipaddress objects. Detach first so the str is never flushed.
            self.session.expunge(report)
            report.ip_address = str(report.ip_address)
        return reports

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
