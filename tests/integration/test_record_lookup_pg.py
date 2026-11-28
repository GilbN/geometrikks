"""One access log line and one stored raw line by id and time, as a record link asks for them."""

from collections.abc import AsyncGenerator, AsyncIterator
from datetime import UTC, datetime, timedelta

import pytest
from litestar import Litestar
from litestar.di import Provide
from litestar.testing import AsyncTestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from geometrikks.domain.logs.controllers.access_log_debug import (
    AccessLogDebugController,
)
from geometrikks.domain.logs.controllers.access_logs import AccessLogController
from geometrikks.server.exceptions import EXCEPTION_HANDLERS
from geometrikks.server.routes import create_api_v1_router

pytestmark = pytest.mark.anyio


@pytest.fixture()
async def client(migrated_database_url) -> AsyncIterator[AsyncTestClient]:
    engine = create_async_engine(migrated_database_url, poolclass=NullPool)
    session_maker = async_sessionmaker(engine, expire_on_commit=False)

    async def provide_session() -> AsyncGenerator[AsyncSession]:
        async with session_maker() as session:
            yield session

    app = Litestar(
        route_handlers=[create_api_v1_router([AccessLogController, AccessLogDebugController])],
        dependencies={
            "db_session": Provide(provide_session),
            "db_engine": Provide(lambda: engine, sync_to_thread=False),
        },
        exception_handlers=EXCEPTION_HANDLERS,
        signature_namespace={"AsyncSession": AsyncSession},
    )
    try:
        async with AsyncTestClient(app=app) as test_client:
            yield test_client
    finally:
        await engine.dispose()


async def test_access_log_line_by_id_and_time(pg_session_maker, clean_tables, client) -> None:
    # Microseconds on purpose: the link carries the timestamp exactly as the list returned it.
    at = datetime.now(UTC).replace(microsecond=123456) - timedelta(minutes=5)
    async with pg_session_maker() as session:
        ids = [
            (
                await session.execute(
                    text(
                        "INSERT INTO access_logs (timestamp, ip_address, status_code, bytes_sent, url) "
                        "VALUES (:at, :ip, 200, 10, :url) RETURNING id"
                    ),
                    {"at": at, "ip": ip, "url": url},
                )
            ).scalar_one()
            for ip, url in (("192.0.2.1", "/first"), ("192.0.2.2", "/second"))
        ]
        await session.commit()

    listed = (await client.get("/api/v1/access-logs", params={"window": "1h"})).json()["items"]
    second = next(item for item in listed if item["id"] == ids[1])

    response = await client.get(f"/api/v1/access-logs/{ids[1]}", params={"at": second["timestamp"]})
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == ids[1]
    assert body["ipAddress"] == "192.0.2.2"
    assert body["url"] == "/second"

    moved = (at + timedelta(seconds=1)).isoformat()
    missing = await client.get(f"/api/v1/access-logs/{ids[1]}", params={"at": moved})
    assert missing.status_code == 404


async def test_access_log_line_needs_its_time(client) -> None:
    response = await client.get("/api/v1/access-logs/1")
    assert response.status_code == 400


async def test_stored_line_by_id_and_time(pg_session_maker, clean_tables, client) -> None:
    created = datetime.now(UTC).replace(microsecond=654321) - timedelta(minutes=5)
    async with pg_session_maker() as session:
        line_id = (
            await session.execute(
                text(
                    "INSERT INTO access_log_debug (created_at, raw_line, is_malformed, parse_error, ip_address) "
                    "VALUES (:created, 'GET /broken', true, 'bad line', '192.0.2.9') RETURNING id"
                ),
                {"created": created},
            )
        ).scalar_one()
        await session.execute(
            text(
                "INSERT INTO access_log_debug (created_at, raw_line, is_malformed) "
                "VALUES (:created, 'GET /other', false)"
            ),
            {"created": created},
        )
        await session.commit()

    listed = (await client.get("/api/v1/access-log-debug")).json()["items"]
    stored = next(item for item in listed if item["id"] == line_id)

    response = await client.get(f"/api/v1/access-log-debug/{line_id}", params={"at": stored["createdAt"]})
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == line_id
    assert body["rawLine"] == "GET /broken"
    assert body["parseError"] == "bad line"
    assert body["ipAddress"] == "192.0.2.9"

    moved = (created - timedelta(seconds=1)).isoformat()
    missing = await client.get(f"/api/v1/access-log-debug/{line_id}", params={"at": moved})
    assert missing.status_code == 404
