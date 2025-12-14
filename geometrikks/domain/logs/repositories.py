"""Repositories for access log and access log debug data."""
from __future__ import annotations

from advanced_alchemy.repository import SQLAlchemyAsyncRepository

from geometrikks.domain.logs.models import AccessLog, AccessLogDebug


class AccessLogRepository(SQLAlchemyAsyncRepository[AccessLog]):
    """Repository for AccessLog model."""

    model_type = AccessLog


class AccessLogDebugRepository(SQLAlchemyAsyncRepository[AccessLogDebug]):
    """Repository for AccessLogDebug model."""

    model_type = AccessLogDebug