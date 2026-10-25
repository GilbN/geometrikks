"""auth_sessions: the store round-trips values and expiry cleanup stays inside one namespace."""
from collections.abc import AsyncIterator

import pytest
from advanced_alchemy.extensions.litestar import SQLAlchemyAsyncConfig
from sqlalchemy import text

from geometrikks.server.session_store import (
    FINGERPRINT_NAMESPACE,
    SESSION_NAMESPACE,
    create_session_table_store,
)

pytestmark = pytest.mark.anyio


@pytest.fixture()
async def db_config(migrated_database_url: str) -> AsyncIterator[SQLAlchemyAsyncConfig]:
    config = SQLAlchemyAsyncConfig(connection_string=migrated_database_url)
    yield config
    await config.get_engine().dispose()


async def _count_rows(pg_engine, namespace: str) -> int:
    async with pg_engine.connect() as connection:
        return (
            await connection.execute(
                text("SELECT count(*) FROM auth_sessions WHERE namespace = :namespace"),
                {"namespace": namespace},
            )
        ).scalar_one()


async def _backdate(pg_engine, key: str, namespace: str) -> None:
    async with pg_engine.begin() as connection:
        await connection.execute(
            text(
                "UPDATE auth_sessions SET expires_at = now() - interval '1 minute' "
                "WHERE key = :key AND namespace = :namespace"
            ),
            {"key": key, "namespace": namespace},
        )


async def test_set_get_and_expires_in_round_trip(db_config, clean_auth_sessions):
    session_store = create_session_table_store(db_config)

    await session_store.set("k", b"v", expires_in=60)

    assert await session_store.get("k") == b"v"
    remaining_seconds = await session_store.expires_in("k")
    assert remaining_seconds is not None
    assert 0 < remaining_seconds <= 60


async def test_delete_expired_removes_only_expired_rows_in_its_namespace(
    db_config, pg_engine, clean_auth_sessions
):
    session_store = create_session_table_store(db_config)
    fingerprint_store = create_session_table_store(db_config, FINGERPRINT_NAMESPACE)

    await session_store.set("expired", b"v", expires_in=60)
    await session_store.set("live", b"v", expires_in=3600)
    await fingerprint_store.set("expired", b"v", expires_in=60)
    await _backdate(pg_engine, "expired", SESSION_NAMESPACE)
    await _backdate(pg_engine, "expired", FINGERPRINT_NAMESPACE)

    await session_store.delete_expired()

    assert await _count_rows(pg_engine, SESSION_NAMESPACE) == 1
    assert await session_store.get("live") == b"v"
    assert await _count_rows(pg_engine, FINGERPRINT_NAMESPACE) == 1

    await fingerprint_store.delete_expired()

    assert await _count_rows(pg_engine, SESSION_NAMESPACE) == 1
    assert await _count_rows(pg_engine, FINGERPRINT_NAMESPACE) == 0


async def test_delete_all_is_scoped_to_the_namespace(db_config, pg_engine, clean_auth_sessions):
    session_store = create_session_table_store(db_config)
    fingerprint_store = create_session_table_store(db_config, FINGERPRINT_NAMESPACE)

    await session_store.set("a", b"v", expires_in=60)
    await fingerprint_store.set("a", b"v", expires_in=60)

    await session_store.delete_all()

    assert await _count_rows(pg_engine, SESSION_NAMESPACE) == 0
    assert await _count_rows(pg_engine, FINGERPRINT_NAMESPACE) == 1
