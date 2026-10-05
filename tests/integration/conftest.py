"""Fixtures for real-TimescaleDB integration tests.

Creates a scratch database `geometrikks_it` on the compose `timescale_db`
server, migrates it to alembic head, runs setup_timescaledb, and drops it
at session end. All tests in this package are marked `integration` and are
skipped automatically when the server is unreachable.
"""
from __future__ import annotations

import asyncio
import os
import socket
from collections.abc import AsyncIterator, Iterator

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine

PG_HOST = os.getenv("IT_DB_HOST", "localhost")
PG_PORT = int(os.getenv("IT_DB_PORT", "5432"))
PG_USER = os.getenv("IT_DB_USER", "geouser")
PG_PASSWORD = os.getenv("IT_DB_PASSWORD", "geopass")
IT_DBNAME = "geometrikks_it"

ADMIN_URL = f"postgresql+asyncpg://{PG_USER}:{PG_PASSWORD}@{PG_HOST}:{PG_PORT}/postgres"
IT_URL = f"postgresql+asyncpg://{PG_USER}:{PG_PASSWORD}@{PG_HOST}:{PG_PORT}/{IT_DBNAME}"


def _server_reachable() -> bool:
    try:
        with socket.create_connection((PG_HOST, PG_PORT), timeout=1):
            return True
    except OSError:
        return False


def pytest_collection_modifyitems(config, items):
    """Mark everything in this package `integration`; skip if no server."""
    integration_items = [
        item
        for item in items
        if "tests/integration" in str(item.fspath).replace(os.sep, "/")
    ]
    if not integration_items:
        return
    reachable = _server_reachable()
    skip = pytest.mark.skip(reason="TimescaleDB not reachable (docker compose up -d timescale_db)")
    for item in integration_items:
        item.add_marker(pytest.mark.integration)
        if not reachable:
            item.add_marker(skip)


@pytest.fixture(scope="session")
def it_database_url() -> Iterator[str]:
    """Create the scratch DB (dropping any stale one), yield its URL, drop it."""

    async def _admin_exec(sql: str) -> None:
        engine = create_async_engine(ADMIN_URL, isolation_level="AUTOCOMMIT")
        try:
            async with engine.connect() as conn:
                await conn.execute(text(sql))
        finally:
            await engine.dispose()

    async def _stop_background_workers() -> None:
        """Keep TimescaleDB's policy jobs from running in the scratch DB.

        A refresh policy runs the moment it is created, and setup_timescaledb
        creates one per continuous aggregate, in the session fixture and again
        in every test that rebuilds a view. Left running, those jobs
        materialize whatever rows the current test has seeded, and they race
        the next DROP MATERIALIZED VIEW ("tuple concurrently deleted"). The
        CREATE EXTENSION covers a server whose template database does
        not already carry the extension.
        """
        engine = create_async_engine(IT_URL, isolation_level="AUTOCOMMIT")
        try:
            async with engine.connect() as conn:
                await conn.execute(text("CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE"))
                stopped = (
                    await conn.execute(text("SELECT _timescaledb_functions.stop_background_workers()"))
                ).scalar()
                assert stopped, f"could not stop the TimescaleDB background workers in {IT_DBNAME}"
        finally:
            await engine.dispose()

    asyncio.run(_admin_exec(f"DROP DATABASE IF EXISTS {IT_DBNAME} WITH (FORCE)"))
    asyncio.run(_admin_exec(f"CREATE DATABASE {IT_DBNAME}"))
    asyncio.run(_stop_background_workers())
    yield IT_URL
    asyncio.run(_admin_exec(f"DROP DATABASE IF EXISTS {IT_DBNAME} WITH (FORCE)"))


@pytest.fixture(scope="session")
def it_asyncpg_dsn(it_database_url: str) -> str:
    """Plain postgresql:// DSN for the scratch DB, for asyncpg-based backends.

    Mirrors DatabaseSettings.asyncpg_dsn: AsyncPgChannelsBackend hands the DSN
    straight to asyncpg, which does not understand the +asyncpg driver suffix.
    """
    return it_database_url.replace("postgresql+asyncpg://", "postgresql://", 1)


@pytest.fixture(scope="session")
def monkeypatch_session():
    """Session-scoped monkeypatch (pytest's default fixture is function-scoped)."""
    from _pytest.monkeypatch import MonkeyPatch

    mp = MonkeyPatch()
    yield mp
    mp.undo()


@pytest.fixture(scope="session")
def migrated_database_url(it_database_url: str, monkeypatch_session) -> Iterator[str]:
    """Scratch DB migrated to head with timescale objects set up."""
    from geometrikks.config.settings import get_settings
    from geometrikks.server.migrations import upgrade_to_head
    from geometrikks.server.timescale import setup_timescaledb

    # Point settings at the scratch DB for the duration of the session.
    # NOTE: the DatabaseSettings field is `database` (env prefix DB_), so the
    # env var is DB_DATABASE — DB_NAME would silently leave settings on the
    # dev `geometrikks` database and alembic would migrate THAT instead.
    monkeypatch_session.setenv("DB_HOST", PG_HOST)
    monkeypatch_session.setenv("DB_PORT", str(PG_PORT))
    monkeypatch_session.setenv("DB_USER", PG_USER)
    monkeypatch_session.setenv("DB_PASSWORD", PG_PASSWORD)
    monkeypatch_session.setenv("DB_DATABASE", IT_DBNAME)
    get_settings.cache_clear()
    assert get_settings().database.database == IT_DBNAME

    upgrade_to_head()  # sync; runs alembic upgrade head against DB_* env

    async def _setup() -> None:
        engine = create_async_engine(it_database_url)
        try:
            await setup_timescaledb(engine, get_settings().analytics)
        finally:
            await engine.dispose()

    asyncio.run(_setup())
    yield it_database_url
    get_settings.cache_clear()


@pytest.fixture()
async def pg_engine(migrated_database_url: str) -> AsyncIterator[AsyncEngine]:
    engine = create_async_engine(migrated_database_url)
    yield engine
    await engine.dispose()


@pytest.fixture()
def pg_session_maker(pg_engine: AsyncEngine):
    return async_sessionmaker(pg_engine, expire_on_commit=False)


@pytest.fixture()
async def clean_tables(pg_engine: AsyncEngine):
    """Clear data tables before each test that requests this fixture.

    The raw hypertables (access_logs, geo_events) are cleared with DELETE and
    the continuous aggregates with TRUNCATE. A materialized bucket outlives
    the raw rows it came from and leaves the aggregate's watermark past it.
    Real-time aggregation only reads raw rows above the watermark, so without
    the TRUNCATE the next test's older rows would be invisible. TRUNCATE on a
    continuous aggregate resets the watermark.
    """
    async with pg_engine.begin() as conn:
        await conn.execute(text("DELETE FROM geo_events"))
        await conn.execute(text("DELETE FROM access_logs"))
        caggs = (await conn.execute(text(
            "SELECT format('%I.%I', view_schema, view_name) "
            "FROM timescaledb_information.continuous_aggregates"
        ))).scalars().all()
        if caggs:
            await conn.execute(text("TRUNCATE " + ", ".join(caggs)))
        await conn.execute(
            text(
                "TRUNCATE access_log_debug, geo_locations, import_jobs "
                "RESTART IDENTITY CASCADE"
            )
        )
    yield


@pytest.fixture()
async def clean_site_homes(pg_engine: AsyncEngine):
    """Clear site_homes before each test that requests this fixture.

    Not a hypertable, so a plain DELETE (no CAGG invalidation concerns).
    """
    async with pg_engine.begin() as conn:
        await conn.execute(text("DELETE FROM site_homes"))
    yield
