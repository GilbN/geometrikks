"""The instances routes refuse to touch the session while the app is DB-degraded."""
from __future__ import annotations

import pytest
from litestar.datastructures import State
from litestar.di import Provide
from litestar.testing import create_async_test_client
from sqlalchemy.ext.asyncio import AsyncSession

from geometrikks.config.settings import Settings
from geometrikks.domain.instances.controllers import InstanceController

pytestmark = pytest.mark.anyio


def _provide_session() -> AsyncSession:
    """A session with no engine: any query through it fails with a 500."""
    return AsyncSession()


def _provide_settings() -> Settings:
    return Settings(_env_file=None)


@pytest.mark.parametrize(("method", "path"), [("GET", "/instances"), ("DELETE", "/instances/edge-01")])
async def test_instances_routes_answer_503_while_the_database_is_unavailable(method: str, path: str) -> None:
    async with create_async_test_client(
        route_handlers=[InstanceController],
        dependencies={
            "db_session": Provide(_provide_session, sync_to_thread=False),
            "settings": Provide(_provide_settings, sync_to_thread=False),
        },
        state=State({"db_available": False}),
    ) as client:
        response = await client.request(method, path)
    assert response.status_code == 503
    assert response.json() == {"status_code": 503, "detail": "The database is unavailable."}
