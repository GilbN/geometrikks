"""auth_sessions against Postgres: the store, a login across app restarts, and startup revocation.

The store tests check that values round-trip and that expiry cleanup stays inside one
namespace. The restart tests build a fresh app over the same database and check that a
login, a logout and the absolute expiry carry over. The revocation tests check that changed
auth settings end every session and unchanged ones leave them alone.
"""
from collections.abc import AsyncIterator
from datetime import datetime

import pytest
from advanced_alchemy.extensions.litestar import EngineConfig, SQLAlchemyAsyncConfig
from litestar import Request, get
from litestar.testing import AsyncTestClient
from sqlalchemy import text
from sqlalchemy.pool import NullPool

from geometrikks.config.settings import Settings
from geometrikks.server.session_revocation import revoke_sessions_if_auth_changed
from geometrikks.server.session_store import (
    FINGERPRINT_NAMESPACE,
    SESSION_NAMESPACE,
    create_session_table_store,
    hash_session_id,
)
from tests.test_auth_endpoints import make_app

pytestmark = pytest.mark.anyio


@pytest.fixture()
async def db_config(migrated_database_url: str) -> AsyncIterator[SQLAlchemyAsyncConfig]:
    # AsyncTestClient serves each app on its own event loop, so a pooled connection
    # opened by one app is unusable by the next.
    config = SQLAlchemyAsyncConfig(
        connection_string=migrated_database_url, engine_config=EngineConfig(poolclass=NullPool)
    )
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


LOGIN = {"username": "admin", "password": "bestpasswordintheworldnojoke"}


async def _login(client: AsyncTestClient) -> str:
    response = await client.post("/api/v1/auth/login", json=LOGIN)
    assert response.status_code == 200
    (session_cookie,) = client.cookies.jar
    assert session_cookie.value is not None
    return session_cookie.value


async def test_a_login_survives_a_restart(db_config, clean_auth_sessions):
    async with AsyncTestClient(
        app=make_app(inner_store=create_session_table_store(db_config))
    ) as first_process:
        session_cookie = await _login(first_process)

    async with AsyncTestClient(
        app=make_app(inner_store=create_session_table_store(db_config))
    ) as second_process:
        second_process.cookies.set("session", session_cookie)
        me = await second_process.get("/api/v1/auth/me")

    assert me.status_code == 200
    assert me.json()["username"] == "admin"


async def test_logout_on_the_second_app_deletes_the_row(db_config, pg_engine, clean_auth_sessions):
    async with AsyncTestClient(
        app=make_app(inner_store=create_session_table_store(db_config))
    ) as first_process:
        session_cookie = await _login(first_process)
    assert await _count_rows(pg_engine, SESSION_NAMESPACE) == 1

    async with AsyncTestClient(
        app=make_app(inner_store=create_session_table_store(db_config))
    ) as second_process:
        second_process.cookies.set("session", session_cookie)
        logout = await second_process.post("/api/v1/auth/logout")

    assert logout.status_code == 200
    assert await _count_rows(pg_engine, SESSION_NAMESPACE) == 0


@get("/api/v1/touch-session")
async def touch_session(request: Request) -> dict[str, bool]:
    """An authenticated request that writes to the loaded session."""
    request.set_session({**request.session, "touched": True})
    return {"ok": True}


async def _expiry(pg_engine, session_cookie: str) -> tuple[datetime, float]:
    """The row's expires_at and the seconds left on it."""
    async with pg_engine.connect() as connection:
        row = (
            await connection.execute(
                text(
                    "SELECT expires_at, extract(epoch FROM expires_at - now()) "
                    "FROM auth_sessions WHERE key = :key AND namespace = :namespace"
                ),
                {"key": hash_session_id(session_cookie), "namespace": SESSION_NAMESPACE},
            )
        ).one()
    return row[0], float(row[1])


async def test_raising_the_lifetime_does_not_extend_existing_sessions(
    db_config, pg_engine, clean_auth_sessions
):
    async with AsyncTestClient(
        app=make_app(inner_store=create_session_table_store(db_config), session_max_age_days=1)
    ) as first_process:
        session_cookie = await _login(first_process)

    async with AsyncTestClient(
        app=make_app(inner_store=create_session_table_store(db_config), session_max_age_days=30)
    ) as second_process:
        second_process.cookies.set("session", session_cookie)
        assert (await second_process.get("/api/v1/auth/me")).status_code == 200

    _, remaining_seconds = await _expiry(pg_engine, session_cookie)
    assert 86400 - 60 < remaining_seconds <= 86400


async def test_writing_a_loaded_session_keeps_its_remaining_lifetime_in_postgres(
    db_config, pg_engine, clean_auth_sessions
):
    async with AsyncTestClient(
        app=make_app(inner_store=create_session_table_store(db_config), session_max_age_days=1)
    ) as first_process:
        session_cookie = await _login(first_process)
    expires_at_after_login, _ = await _expiry(pg_engine, session_cookie)

    async with AsyncTestClient(
        app=make_app(
            extra_handlers=[touch_session],
            inner_store=create_session_table_store(db_config),
            session_max_age_days=30,
        )
    ) as second_process:
        second_process.cookies.set("session", session_cookie)
        touched = await second_process.get("/api/v1/touch-session")
        # The write-back sends a refreshed cookie; a second request proves the row still loads.
        assert (await second_process.get("/api/v1/auth/me")).status_code == 200

    assert touched.status_code == 200
    expires_at_after_write, remaining_seconds = await _expiry(pg_engine, session_cookie)
    assert expires_at_after_write <= expires_at_after_login
    assert 86400 - 60 < remaining_seconds <= 86400
    async with pg_engine.connect() as connection:
        stored_value = (
            await connection.execute(
                text("SELECT value FROM auth_sessions WHERE key = :key"),
                {"key": hash_session_id(session_cookie)},
            )
        ).scalar_one()
    assert b"touched" in stored_value


async def test_revocation_runs_against_postgres(db_config, pg_engine, clean_auth_sessions):
    sessions = create_session_table_store(db_config)
    fingerprints = create_session_table_store(db_config, FINGERPRINT_NAMESPACE)
    first = Settings(admin_user="admin", admin_password="first-password", _env_file=None)
    await revoke_sessions_if_auth_changed(sessions, fingerprints, first)
    await sessions.set("planted", b"v", expires_in=3600)

    second = Settings(admin_user="admin", admin_password="second-password", _env_file=None)
    assert await revoke_sessions_if_auth_changed(sessions, fingerprints, second) is True

    assert await _count_rows(pg_engine, SESSION_NAMESPACE) == 0
    assert await _count_rows(pg_engine, FINGERPRINT_NAMESPACE) == 1


async def test_unchanged_settings_keep_sessions_after_the_fingerprint_round_trips_postgres(
    db_config, pg_engine, clean_auth_sessions
):
    settings = Settings(admin_user="admin", admin_password="first-password", _env_file=None)
    first_sessions = create_session_table_store(db_config)
    first_fingerprints = create_session_table_store(db_config, FINGERPRINT_NAMESPACE)
    await revoke_sessions_if_auth_changed(first_sessions, first_fingerprints, settings)
    await first_sessions.set("planted", b"v", expires_in=3600)

    restarted_sessions = create_session_table_store(db_config)
    restarted_fingerprints = create_session_table_store(db_config, FINGERPRINT_NAMESPACE)
    revoked = await revoke_sessions_if_auth_changed(
        restarted_sessions, restarted_fingerprints, settings
    )

    assert revoked is False
    assert await restarted_sessions.get("planted") == b"v"
    assert await _count_rows(pg_engine, SESSION_NAMESPACE) == 1
