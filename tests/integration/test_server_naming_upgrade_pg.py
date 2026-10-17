"""In-place rename of the legacy hostname/site_homes storage to server.

Each test builds its own scratch database the way the previous release
leaves it: alembic at the last pre-rename revision, the affected continuous
aggregates in their legacy shape, seeded rows, refreshed buckets and a
compressed chunk. Startup (alembic head plus setup_timescaledb) must rename
everything in place and keep every row.
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterator
from datetime import datetime, timedelta, timezone

import pytest
import structlog
from advanced_alchemy.alembic.commands import AlembicCommands
from advanced_alchemy.config import AlembicAsyncConfig, SQLAlchemyAsyncConfig
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from geometrikks.config.settings import get_settings
from geometrikks.server import timescale
from geometrikks.server.migrations import upgrade_to_head
from tests.integration.conftest import ADMIN_URL, PG_HOST, PG_PASSWORD, PG_PORT, PG_USER

pytestmark = pytest.mark.anyio

RENAME_DBNAME = "geometrikks_it_rename"
RENAME_URL = f"postgresql+asyncpg://{PG_USER}:{PG_PASSWORD}@{PG_HOST}:{PG_PORT}/{RENAME_DBNAME}"
LEGACY_REVISION = "a4d1f0c2b7e9"

NOW = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
SEEDED_AT = NOW - timedelta(days=2)
SERVER_NAMES = ("Nostromo", "edge-01")

LEGACY_LOCATION_DDL = [
    f"""
    CREATE MATERIALIZED VIEW location_{suffix}_stats
    WITH (timescaledb.continuous) AS
    SELECT
        time_bucket('{interval}', timestamp) AS bucket,
        location_id,
        hostname,
        COUNT(*) AS event_count
    FROM geo_events
    GROUP BY bucket, location_id, hostname
    WITH NO DATA
    """
    for suffix, interval in (("hourly", "1 hour"), ("daily", "1 day"))
] + [
    statement
    for suffix in ("hourly", "daily")
    for statement in (
        f"CREATE INDEX ix_location_{suffix}_bucket ON location_{suffix}_stats (bucket DESC)",
        f"CREATE INDEX ix_location_{suffix}_location ON location_{suffix}_stats (location_id)",
        f"CREATE INDEX ix_location_{suffix}_hostname ON location_{suffix}_stats (hostname, bucket DESC)",
    )
]

PRE_HOSTNAME_LOCATION_DDL = [
    f"""
    CREATE MATERIALIZED VIEW location_{suffix}_stats
    WITH (timescaledb.continuous) AS
    SELECT
        time_bucket('{interval}', timestamp) AS bucket,
        location_id,
        COUNT(*) AS event_count
    FROM geo_events
    GROUP BY bucket, location_id
    WITH NO DATA
    """
    for suffix, interval in (("hourly", "1 hour"), ("daily", "1 day"))
]

LEGACY_CAGG_DDL = [
    statement
    for suffix, interval in (("hourly", "1 hour"), ("daily", "1 day"))
    for statement in (
        f"""
        CREATE MATERIALIZED VIEW ip_location_{suffix}_stats
        WITH (timescaledb.continuous) AS
        SELECT
            time_bucket('{interval}', timestamp) AS bucket,
            location_id,
            ip_address,
            COUNT(*) AS event_count,
            MAX(autonomous_system_number) AS asn,
            MAX(autonomous_system_organization) AS as_org,
            COUNT(autonomous_system_number) AS asn_hits,
            array_agg(DISTINCT hostname) AS hostnames,
            COUNT(hostname) AS hostname_hits
        FROM geo_events
        GROUP BY bucket, location_id, ip_address
        WITH NO DATA
        """,
        f"CREATE INDEX ix_ip_location_{suffix}_stats_bucket ON ip_location_{suffix}_stats (bucket DESC)",
        f"CREATE INDEX ix_ip_location_{suffix}_stats_location ON ip_location_{suffix}_stats (location_id)",
        f"CREATE INDEX ix_ip_location_{suffix}_stats_location_ip "
        f"ON ip_location_{suffix}_stats (location_id, ip_address)",
        f"CREATE INDEX ix_ip_location_{suffix}_stats_ip_bucket "
        f"ON ip_location_{suffix}_stats (ip_address, bucket DESC)",
    )
] + [
    """
    CREATE MATERIALIZED VIEW hostname_daily_stats
    WITH (timescaledb.continuous) AS
    SELECT
        time_bucket('1 day', timestamp) AS bucket,
        hostname,
        COUNT(*) AS event_count
    FROM geo_events
    GROUP BY bucket, hostname
    WITH NO DATA
    """,
    "CREATE INDEX ix_hostname_daily_stats_bucket ON hostname_daily_stats (bucket DESC)",
    """
    CREATE MATERIALIZED VIEW log_source_daily_stats
    WITH (timescaledb.continuous) AS
    SELECT
        time_bucket('1 day', timestamp) AS bucket,
        hostname,
        log_format,
        COUNT(*) AS hits
    FROM access_logs
    WHERE hostname IS NOT NULL OR log_format IS NOT NULL
    GROUP BY bucket, hostname, log_format
    WITH NO DATA
    """,
    "CREATE INDEX ix_log_source_daily_stats_bucket ON log_source_daily_stats (bucket DESC)",
]

LEGACY_TO_NEW_VIEWS = {
    "location_hourly_stats": "location_hourly_stats",
    "location_daily_stats": "location_daily_stats",
    "ip_location_hourly_stats": "ip_location_hourly_stats",
    "ip_location_daily_stats": "ip_location_daily_stats",
    "hostname_daily_stats": "server_daily_stats",
    "log_source_daily_stats": "log_source_daily_stats",
}

NEW_COLUMNS = {
    ("geo_events", "server"),
    ("access_logs", "server"),
    ("loki_imports", "server"),
    ("server_locations", "server"),
    ("location_hourly_stats", "server"),
    ("location_daily_stats", "server"),
    ("ip_location_hourly_stats", "servers"),
    ("ip_location_hourly_stats", "server_hits"),
    ("ip_location_daily_stats", "servers"),
    ("ip_location_daily_stats", "server_hits"),
    ("server_daily_stats", "server"),
    ("log_source_daily_stats", "server"),
}
LEGACY_COLUMNS = {
    ("geo_events", "hostname"),
    ("access_logs", "hostname"),
    ("loki_imports", "hostname"),
    ("site_homes", "hostname"),
    ("location_hourly_stats", "hostname"),
    ("location_daily_stats", "hostname"),
    ("ip_location_hourly_stats", "hostnames"),
    ("ip_location_hourly_stats", "hostname_hits"),
    ("ip_location_daily_stats", "hostnames"),
    ("ip_location_daily_stats", "hostname_hits"),
    ("hostname_daily_stats", "hostname"),
    ("log_source_daily_stats", "hostname"),
}
NEW_RELATIONS = {
    "server_locations",
    "server_locations_id_seq",
    "server_daily_stats",
    "ix_geo_events_server",
    "ix_access_logs_server",
    "ix_location_hourly_server",
    "ix_location_daily_server",
    "ix_server_daily_stats_bucket",
    "pk_server_locations",
    "uq_server_locations_server",
}
LEGACY_RELATIONS = {
    "site_homes",
    "site_homes_id_seq",
    "hostname_daily_stats",
    "ix_geo_events_hostname",
    "ix_access_logs_hostname",
    "ix_location_hourly_hostname",
    "ix_location_daily_hostname",
    "ix_hostname_daily_stats_bucket",
    "pk_site_homes",
    "uq_site_homes_hostname",
}
NEW_CONSTRAINTS = {"pk_server_locations", "uq_server_locations_server", "ck_server_locations_source"}
LEGACY_CONSTRAINTS = {"pk_site_homes", "uq_site_homes_hostname", "ck_site_homes_source"}


async def _admin_exec(sql: str) -> None:
    engine = create_async_engine(ADMIN_URL, isolation_level="AUTOCOMMIT")
    try:
        async with engine.connect() as conn:
            await conn.execute(text(sql))
    finally:
        await engine.dispose()


async def _create_scratch_database() -> None:
    await _admin_exec(f"DROP DATABASE IF EXISTS {RENAME_DBNAME} WITH (FORCE)")
    await _admin_exec(f"CREATE DATABASE {RENAME_DBNAME}")
    # Refresh-policy jobs would otherwise race the DDL in these tests.
    engine = create_async_engine(RENAME_URL, isolation_level="AUTOCOMMIT")
    try:
        async with engine.connect() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE"))
            stopped = (
                await conn.execute(text("SELECT _timescaledb_functions.stop_background_workers()"))
            ).scalar()
            assert stopped, f"could not stop the TimescaleDB background workers in {RENAME_DBNAME}"
    finally:
        await engine.dispose()


def _alembic_commands() -> AlembicCommands:
    return AlembicCommands(SQLAlchemyAsyncConfig(
        connection_string=RENAME_URL,
        alembic_config=AlembicAsyncConfig(script_config="alembic.ini", script_location="migrations"),
    ))


async def _seed_legacy_rows(engine: AsyncEngine) -> None:
    async with engine.begin() as conn:
        location_id = (await conn.execute(text(
            "INSERT INTO geo_locations (latitude, longitude, geohash, geographic_point, "
            "country_code, country_name, city, created_at, updated_at) "
            "VALUES (59.9, 10.7, 'u4xsx', ST_SetSRID(ST_MakePoint(10.7, 59.9), 4326), "
            "'NO', 'Norway', 'Oslo', now(), now()) RETURNING id"
        ))).scalar_one()
        for server_index, server_name in enumerate(SERVER_NAMES):
            for minute in range(3 + server_index):
                await conn.execute(text(
                    "INSERT INTO geo_events (timestamp, ip_address, hostname, location_id, "
                    "autonomous_system_number) VALUES (:ts, '203.0.113.7', :server, :location, 64500)"
                ), {"ts": SEEDED_AT - timedelta(minutes=minute), "server": server_name, "location": location_id})
                await conn.execute(text(
                    "INSERT INTO access_logs (timestamp, ip_address, status_code, bytes_sent, "
                    "url, hostname, log_format) "
                    "VALUES (:ts, '203.0.113.7', 200, 10, '/', :server, 'nginx')"
                ), {"ts": SEEDED_AT - timedelta(minutes=minute), "server": server_name})
        await conn.execute(text(
            "INSERT INTO site_homes (hostname, latitude, longitude, source, created_at, updated_at) "
            "VALUES ('Nostromo', 59.9, 10.7, 'override', now(), now())"
        ))
        await conn.execute(text(
            "INSERT INTO loki_imports (url, query, hostname, range_start, range_end, cursor, "
            "created_at, updated_at) VALUES ('http://loki:3100', '{job=\"nginx\"}', 'edge-01', "
            ":start, :end, :start, now(), now())"
        ), {"start": SEEDED_AT - timedelta(days=1), "end": SEEDED_AT})


async def _refresh_and_compress(engine: AsyncEngine, views: list[str]) -> None:
    async with engine.connect() as conn:
        autocommit = await conn.execution_options(isolation_level="AUTOCOMMIT")
        for view in views:
            await autocommit.execute(
                text(f"CALL refresh_continuous_aggregate('{view}', CAST(:start AS timestamptz), CAST(:end AS timestamptz))"),
                {"start": NOW - timedelta(days=4), "end": NOW - timedelta(days=1)},
            )
            await autocommit.execute(
                text(f"ALTER MATERIALIZED VIEW {view} SET (timescaledb.materialized_only = false)")
            )
        for table in ("geo_events", "access_logs"):
            await autocommit.execute(text(
                f"ALTER TABLE {table} SET (timescaledb.compress, "
                "timescaledb.compress_orderby = 'timestamp DESC')"
            ))
            compressed = (await autocommit.execute(text(
                f"SELECT compress_chunk(chunk) FROM show_chunks('{table}', "
                "older_than => INTERVAL '1 day') AS chunk"
            ))).all()
            assert compressed, f"no {table} chunk was old enough to compress"
        await autocommit.execute(
            text("ALTER MATERIALIZED VIEW location_daily_stats SET (timescaledb.compress = true)")
        )
        compressed_cagg_chunks = (await autocommit.execute(text(
            "SELECT compress_chunk(chunk) FROM show_chunks('location_daily_stats') AS chunk"
        ))).all()
        assert compressed_cagg_chunks, "location_daily_stats had no chunk to compress"


async def _compressed_chunks(conn, hypertable: str) -> list[str]:
    return list((await conn.execute(text(
        "SELECT chunk_name FROM timescaledb_information.chunks "
        "WHERE hypertable_name = :hypertable AND is_compressed ORDER BY chunk_name"
    ), {"hypertable": hypertable})).scalars())


async def _snapshot(engine: AsyncEngine, view_names: dict[str, str], *, legacy: bool) -> dict[str, object]:
    """What a rename must keep: rows, aggregate contents, view identity, compression.

    Keyed by the legacy view name so a before and an after snapshot compare equal.
    """
    server_column, servers_column, server_hits_column = (
        ("hostname", "hostnames", "hostname_hits") if legacy else ("server", "servers", "server_hits")
    )
    async with engine.connect() as conn:
        counts = {
            table: (await conn.execute(text(f"SELECT count(*) FROM {table}"))).scalar_one()
            for table in ("geo_events", "access_logs", "loki_imports")
        }
        view_oids: dict[str, int] = {}
        materialization_hypertable_ids: dict[str, int] = {}
        for legacy_view, current_view in view_names.items():
            counts[legacy_view] = (
                await conn.execute(text(f"SELECT count(*) FROM {current_view}"))
            ).scalar_one()
            view_oids[legacy_view] = (await conn.execute(
                text("SELECT CAST(to_regclass(CAST(:view AS text)) AS oid)"),
                {"view": f"public.{current_view}"},
            )).scalar_one()
            materialization_hypertable_ids[legacy_view] = (await conn.execute(text(
                "SELECT mat_hypertable_id FROM _timescaledb_catalog.continuous_agg "
                "WHERE user_view_schema = 'public' AND user_view_name = :view"
            ), {"view": current_view})).scalar_one()
        per_server = dict((await conn.execute(text(
            f"SELECT {server_column}, sum(event_count) FROM location_daily_stats GROUP BY 1"
        ))).tuples().all())
        ip_location_servers = [
            tuple(row) for row in await conn.execute(text(
                "SELECT location_id, host(ip_address), bucket, "
                f"ARRAY(SELECT unnest({servers_column}) ORDER BY 1), {server_hits_column} "
                "FROM ip_location_daily_stats ORDER BY 1, 2, 3"
            ))
        ]
        location_daily_hypertable = (await conn.execute(text(
            "SELECT materialization_hypertable_name FROM timescaledb_information.continuous_aggregates "
            "WHERE view_schema = 'public' AND view_name = 'location_daily_stats'"
        ))).scalar_one()
        compressed_chunks = {
            "geo_events": await _compressed_chunks(conn, "geo_events"),
            "access_logs": await _compressed_chunks(conn, "access_logs"),
            "location_daily_stats": await _compressed_chunks(conn, location_daily_hypertable),
        }
    assert all(compressed_chunks.values()), compressed_chunks
    assert ip_location_servers, "ip_location_daily_stats has no materialized rows"
    return {
        "counts": counts,
        "per_server": per_server,
        "ip_location_servers": ip_location_servers,
        "view_oids": view_oids,
        "materialization_hypertable_ids": materialization_hypertable_ids,
        "compressed_chunks": compressed_chunks,
    }


def _build_legacy_database(*, location_has_hostname: bool) -> dict[str, object]:
    async def _build() -> dict[str, object]:
        engine = create_async_engine(RENAME_URL)
        try:
            async with engine.begin() as conn:
                await timescale._enable_extensions(conn)
                await timescale._create_hypertables(conn)
                location_ddl = LEGACY_LOCATION_DDL if location_has_hostname else PRE_HOSTNAME_LOCATION_DDL
                for statement in location_ddl + LEGACY_CAGG_DDL:
                    await conn.execute(text(statement))
            await _seed_legacy_rows(engine)
            await _refresh_and_compress(engine, list(LEGACY_TO_NEW_VIEWS))
            if not location_has_hostname:
                return {}
            return await _snapshot(engine, {view: view for view in LEGACY_TO_NEW_VIEWS}, legacy=True)
        finally:
            await engine.dispose()

    asyncio.run(_create_scratch_database())
    _alembic_commands().upgrade(revision=LEGACY_REVISION)
    return asyncio.run(_build())


@pytest.fixture()
def legacy_database() -> Iterator[dict[str, object]]:
    """Previous-release database; yields the pre-upgrade snapshot."""
    yield _build_legacy_database(location_has_hostname=True)
    asyncio.run(_admin_exec(f"DROP DATABASE IF EXISTS {RENAME_DBNAME} WITH (FORCE)"))


@pytest.fixture()
def legacy_database_without_location_server() -> Iterator[None]:
    """Previous release whose location CAGGs never got the hostname column."""
    _build_legacy_database(location_has_hostname=False)
    yield
    asyncio.run(_admin_exec(f"DROP DATABASE IF EXISTS {RENAME_DBNAME} WITH (FORCE)"))


@pytest.fixture()
async def rename_engine() -> AsyncIterator[AsyncEngine]:
    engine = create_async_engine(RENAME_URL)
    yield engine
    await engine.dispose()


async def _start_up(engine: AsyncEngine) -> None:
    await asyncio.to_thread(upgrade_to_head, RENAME_URL)
    await timescale.setup_timescaledb(engine, get_settings().analytics)


async def _public_columns(engine: AsyncEngine) -> set[tuple[str, str]]:
    async with engine.connect() as conn:
        return {
            (row.table_name, row.column_name)
            for row in await conn.execute(text(
                "SELECT table_name, column_name FROM information_schema.columns "
                "WHERE table_schema = 'public'"
            ))
        }


async def _relation_names(engine: AsyncEngine, names: set[str]) -> set[str]:
    async with engine.connect() as conn:
        return set((await conn.execute(
            text("SELECT relname FROM pg_class WHERE relname = ANY(:names)"),
            {"names": list(names)},
        )).scalars())


async def _constraint_names(engine: AsyncEngine, names: set[str]) -> set[str]:
    async with engine.connect() as conn:
        return set((await conn.execute(
            text("SELECT conname FROM pg_constraint WHERE conname = ANY(:names)"),
            {"names": list(names)},
        )).scalars())


async def _assert_server_names(engine: AsyncEngine) -> None:
    columns = await _public_columns(engine)
    assert NEW_COLUMNS <= columns, NEW_COLUMNS - columns
    assert not LEGACY_COLUMNS & columns, LEGACY_COLUMNS & columns
    assert await _relation_names(engine, NEW_RELATIONS) == NEW_RELATIONS
    assert await _relation_names(engine, LEGACY_RELATIONS) == set()
    assert await _constraint_names(engine, NEW_CONSTRAINTS) == NEW_CONSTRAINTS
    assert await _constraint_names(engine, LEGACY_CONSTRAINTS) == set()


async def test_upgrade_renames_in_place(legacy_database, rename_engine):
    with structlog.testing.capture_logs() as captured_logs:
        await _start_up(rename_engine)

    await _assert_server_names(rename_engine)
    after = await _snapshot(rename_engine, LEGACY_TO_NEW_VIEWS, legacy=False)
    assert after == legacy_database
    assert after["per_server"] == {"Nostromo": 3, "edge-01": 4}
    async with rename_engine.connect() as conn:
        server_location = (await conn.execute(text(
            "SELECT server, source FROM server_locations"
        ))).one()
        loki_import_server = (await conn.execute(text("SELECT server FROM loki_imports"))).scalar_one()
    assert tuple(server_location) == ("Nostromo", "override")
    assert loki_import_server == "edge-01"
    renamed_events = [log for log in captured_logs if log["event"] == "legacy_server_objects_renamed"]
    assert len(renamed_events) == 1
    assert "hostname_daily_stats: hostname_daily_stats -> server_daily_stats" in renamed_events[0]["renamed"]


async def test_upgrade_is_idempotent(legacy_database, rename_engine):
    await _start_up(rename_engine)

    with structlog.testing.capture_logs() as captured_logs:
        await timescale.setup_timescaledb(rename_engine, get_settings().analytics)
    async with rename_engine.begin() as conn:
        assert await timescale._rename_legacy_server_objects(conn) == []

    assert not [log for log in captured_logs if log["event"] == "legacy_server_objects_renamed"]
    await _assert_server_names(rename_engine)


async def test_partial_upgrade_resumes(legacy_database, rename_engine):
    """Startup stopped after alembic: the base column is already `server`
    while every CAGG still says `hostname`, and ingestion keeps writing."""
    await asyncio.to_thread(upgrade_to_head, RENAME_URL)
    async with rename_engine.begin() as conn:
        await conn.execute(text(
            "INSERT INTO geo_events (timestamp, ip_address, server, location_id) "
            "SELECT now(), '198.51.100.9', 'Nostromo', id FROM geo_locations LIMIT 1"
        ))

    await timescale.setup_timescaledb(rename_engine, get_settings().analytics)

    await _assert_server_names(rename_engine)
    async with rename_engine.connect() as conn:
        per_server = dict((await conn.execute(text(
            "SELECT server, sum(event_count) FROM location_daily_stats GROUP BY 1"
        ))).tuples().all())
    assert per_server == {"Nostromo": 4, "edge-01": 4}


async def test_location_caggs_without_server_dimension(
    legacy_database_without_location_server, rename_engine
):
    await _start_up(rename_engine)

    await _assert_server_names(rename_engine)
    assert timescale.location_caggs_have_server() is True


async def test_downgrade_restores_legacy_table_names(legacy_database, rename_engine):
    await _start_up(rename_engine)

    await asyncio.to_thread(_alembic_commands().downgrade, "-1")

    columns = await _public_columns(rename_engine)
    assert LEGACY_COLUMNS <= columns, LEGACY_COLUMNS - columns
    assert not NEW_COLUMNS & columns, NEW_COLUMNS & columns
    assert await _relation_names(rename_engine, LEGACY_RELATIONS) == LEGACY_RELATIONS
    assert await _relation_names(rename_engine, NEW_RELATIONS) == set()
    assert await _constraint_names(rename_engine, LEGACY_CONSTRAINTS) == LEGACY_CONSTRAINTS
    async with rename_engine.connect() as conn:
        site_home = (await conn.execute(text("SELECT hostname FROM site_homes"))).scalar_one()
    assert site_home == "Nostromo"

    await _start_up(rename_engine)
    await _assert_server_names(rename_engine)


DECOY_INDEX_NAMES = {
    "ix_geo_events_hostname",
    "ix_geo_events_server",
    "ix_location_hourly_hostname",
    "ix_location_hourly_server",
    "ix_hostname_daily_stats_bucket",
    "ix_server_daily_stats_bucket",
}


async def _owned_index_names(engine: AsyncEngine) -> set[tuple[str, str]]:
    """(owner, index) for the hypertables in public and each CAGG's materialization."""
    async with engine.connect() as conn:
        rows = await conn.execute(text("""
            SELECT tablename AS owner, indexname FROM pg_indexes
            WHERE schemaname = 'public' AND tablename IN ('geo_events', 'access_logs')
            UNION ALL
            SELECT c.view_name, i.indexname
            FROM timescaledb_information.continuous_aggregates c
            JOIN pg_indexes i
              ON i.schemaname = c.materialization_hypertable_schema
             AND i.tablename = c.materialization_hypertable_name
            WHERE c.view_schema = 'public'
        """))
        return {(row.owner, row.indexname) for row in rows}


async def test_same_named_indexes_in_another_schema_are_left_alone(legacy_database, rename_engine):
    async with rename_engine.begin() as conn:
        await conn.execute(text("CREATE SCHEMA decoy"))
        await conn.execute(text("CREATE TABLE decoy.lookalike (value integer)"))
        for index_name in sorted(DECOY_INDEX_NAMES):
            await conn.execute(text(f"CREATE INDEX {index_name} ON decoy.lookalike (value)"))

    await _start_up(rename_engine)

    owned = await _owned_index_names(rename_engine)
    assert {
        ("geo_events", "ix_geo_events_server"),
        ("access_logs", "ix_access_logs_server"),
        ("location_hourly_stats", "ix_location_hourly_server"),
        ("location_daily_stats", "ix_location_daily_server"),
        ("server_daily_stats", "ix_server_daily_stats_bucket"),
    } <= owned
    assert not {index_name for _, index_name in owned} & {
        "ix_geo_events_hostname", "ix_access_logs_hostname", "ix_location_hourly_hostname",
        "ix_location_daily_hostname", "ix_hostname_daily_stats_bucket",
    }
    async with rename_engine.connect() as conn:
        decoys = set((await conn.execute(text(
            "SELECT indexname FROM pg_indexes WHERE schemaname = 'decoy'"
        ))).scalars())
    assert decoys == DECOY_INDEX_NAMES


async def test_teardown_drops_legacy_views_before_drop_all(legacy_database, rename_engine):
    """DB_DROP_ON_STARTUP on a database the upgrade has not reached yet."""
    from advanced_alchemy import base

    import geometrikks.domain.geo.models  # noqa: F401
    import geometrikks.domain.imports.models  # noqa: F401
    import geometrikks.domain.logs.models  # noqa: F401

    async with rename_engine.begin() as conn:
        await timescale.teardown_timescaledb(conn)
        await conn.run_sync(base.DefaultBase.metadata.drop_all)

    assert await _relation_names(
        rename_engine, {"hostname_daily_stats", "geo_events", "access_logs"}
    ) == set()
