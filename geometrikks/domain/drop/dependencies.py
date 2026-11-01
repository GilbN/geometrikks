"""Dependency providers for the DROP domain."""
from __future__ import annotations

from litestar.di import NamedDependency
from litestar.params import SkipValidation
from sqlalchemy.ext.asyncio import AsyncSession

from geometrikks.config.settings import Settings
from geometrikks.domain.drop.snapshot import DropSnapshot, ensure_drop_snapshot


async def provide_drop_snapshot(
    db_session: NamedDependency[AsyncSession],
    settings: NamedDependency[SkipValidation[Settings]],
) -> DropSnapshot:
    """Bring the process-wide DROP snapshot up to date before the handler runs."""
    return await ensure_drop_snapshot(db_session, enabled=settings.drop.enabled)
