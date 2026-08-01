"""SecurityEnrichmentRepository input handling that needs no database."""
from __future__ import annotations

from typing import TYPE_CHECKING, cast

from geometrikks.domain.security.repositories import SecurityEnrichmentRepository

import pytest

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

pytestmark = pytest.mark.anyio


async def test_enrich_empty_input_skips_query():
    repo = SecurityEnrichmentRepository(session=cast("AsyncSession", None))  # would crash if queried
    assert await repo.enrich([]) == {}


async def test_enrich_all_invalid_input_skips_query():
    repo = SecurityEnrichmentRepository(session=cast("AsyncSession", None))
    assert await repo.enrich(["10.0.0.0/24", "US", "not-an-ip"]) == {}


async def test_locations_empty_input_skips_query():
    repo = SecurityEnrichmentRepository(session=cast("AsyncSession", None))
    assert await repo.locations([]) == []
    assert await repo.locations(["US", "10.0.0.0/24"]) == []
