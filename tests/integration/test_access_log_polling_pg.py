"""Window pagination and DTO responses against real TimescaleDB."""

from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta

import pytest
from litestar import Litestar
from litestar.di import Provide
from litestar.testing import AsyncTestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from geometrikks.domain.logs.controllers.access_logs import AccessLogController
from geometrikks.server.exceptions import EXCEPTION_HANDLERS
from geometrikks.server.routes import create_api_v1_router

pytestmark = pytest.mark.anyio


async def test_window_bounds_can_be_reused_across_pages_and_polls(
    migrated_database_url, pg_session_maker, clean_tables,
):
    now = datetime.now(UTC)
    async with pg_session_maker() as session:
        ids = []
        for minutes in (11, 9, 8, 8, -1):
            result = await session.execute(
                text("INSERT INTO access_logs (timestamp, ip_address, status_code, bytes_sent) VALUES (:at, '192.0.2.1', 200, 10) RETURNING id"),
                {"at": now - timedelta(minutes=minutes)},
            )
            ids.append(result.scalar_one())
        await session.commit()

    engine = create_async_engine(migrated_database_url, poolclass=NullPool)
    session_maker = async_sessionmaker(engine, expire_on_commit=False)

    async def provide_session() -> AsyncGenerator[AsyncSession, None]:
        async with session_maker() as session:
            yield session

    app = Litestar(
        route_handlers=[create_api_v1_router([AccessLogController])],
        dependencies={"db_session": Provide(provide_session)}, exception_handlers=EXCEPTION_HANDLERS,
        # Match the SQLAlchemy plugin namespace used by generated service providers.
        signature_namespace={"AsyncSession": AsyncSession},
    )
    try:
        async with AsyncTestClient(app=app) as client:
            options = {"pageSize": 2, "orderBy": "id", "sortOrder": "asc"}
            first = await client.get("/api/v1/access-logs", params={**options, "window": "10m"})
            assert first.status_code == 200, first.text
            assert first.headers["Cache-Control"] == "no-store"
            start, end = first.headers["X-Range-Start"], first.headers["X-Range-End"]
            assert datetime.fromisoformat(end) - datetime.fromisoformat(start) == timedelta(minutes=10)
            assert first.json()["total"] == 3
            assert [item["id"] for item in first.json()["items"]] == ids[1:3]
            assert first.json()["items"][0]["bytesSent"] == 10
            assert "bytes_sent" not in first.json()["items"][0]

            async with pg_session_maker() as session:
                result = await session.execute(
                    text("INSERT INTO access_logs (timestamp, ip_address, status_code, bytes_sent) VALUES (:at, '192.0.2.2', 200, 20) RETURNING id"),
                    {"at": datetime.fromisoformat(end) + timedelta(microseconds=1)},
                )
                new_id = result.scalar_one()
                await session.commit()

            second = await client.get("/api/v1/access-logs", params={
                **options, "currentPage": 2, "fromTimestamp": start, "toTimestamp": end,
            })
            assert second.status_code == 200
            assert second.json()["total"] == 3
            assert [item["id"] for item in second.json()["items"]] == [ids[3]]
            assert second.headers["X-Range-Start"] == start and second.headers["X-Range-End"] == end

            repeated = await client.get("/api/v1/access-logs", params={
                "window": "10m", "pageSize": 1000, "orderBy": "id", "sortOrder": "asc",
            })
            assert repeated.status_code == 200
            previous_ids = set(ids[1:4])
            assert {item["id"] for item in repeated.json()["items"]} - previous_ids == {new_id}
    finally:
        await engine.dispose()
