"""api_keys against Postgres: the migration matches the model, and SqlApiKeyRepository round-trips."""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import pytest
from advanced_alchemy.extensions.litestar import EngineConfig, SQLAlchemyAsyncConfig
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import text
from sqlalchemy.pool import NullPool

from geometrikks.domain.auth.api_keys import ApiKeyScope, generate_api_key
from geometrikks.domain.auth.models import ApiKey
from geometrikks.domain.exceptions import DomainConflictError
from geometrikks.server.api_key_store import SqlApiKeyRepository

pytestmark = pytest.mark.anyio


@pytest.fixture()
async def db_config(migrated_database_url: str) -> AsyncIterator[SQLAlchemyAsyncConfig]:
    config = SQLAlchemyAsyncConfig(
        connection_string=migrated_database_url, engine_config=EngineConfig(poolclass=NullPool)
    )
    yield config
    await config.get_engine().dispose()


async def _insert(
    repository: SqlApiKeyRepository,
    name: str,
    *,
    scope: ApiKeyScope = "read",
    expires_at: datetime | None = None,
):
    material = generate_api_key()
    api_key_record = await repository.insert(
        name=name,
        scope=scope,
        key_hash=material.key_hash,
        display_prefix=material.display_prefix,
        created_by="admin",
        expires_at=expires_at,
    )
    return api_key_record, material


def _only_api_keys(schema_object, name, type_, reflected, compare_to) -> bool:
    if type_ == "table":
        return name == "api_keys"
    return schema_object.table.name == "api_keys"


async def test_migrated_table_matches_the_model(pg_engine):
    async with pg_engine.connect() as connection:
        schema_diffs = await connection.run_sync(
            lambda sync_connection: compare_metadata(
                MigrationContext.configure(
                    sync_connection, opts={"compare_type": True, "include_object": _only_api_keys}
                ),
                ApiKey.metadata,
            )
        )
        index_definitions = (
            await connection.execute(
                text("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'api_keys' ORDER BY indexname")
            )
        ).all()

    assert schema_diffs == []
    assert [tuple(index_row) for index_row in index_definitions] == [
        ("ix_api_keys_key_hash", "CREATE UNIQUE INDEX ix_api_keys_key_hash ON public.api_keys USING btree (key_hash)"),
        (
            "ix_api_keys_lower_name",
            "CREATE UNIQUE INDEX ix_api_keys_lower_name ON public.api_keys USING btree (lower((name)::text))",
        ),
        ("pk_api_keys", "CREATE UNIQUE INDEX pk_api_keys ON public.api_keys USING btree (id)"),
    ]


async def test_insert_then_find_by_hash(db_config, clean_api_keys):
    repository = SqlApiKeyRepository(db_config)
    expires_at = datetime(2027, 1, 1, tzinfo=UTC)

    api_key_record, material = await _insert(repository, "homepage", scope="read_write", expires_at=expires_at)

    assert api_key_record.name == "homepage"
    assert api_key_record.scope == "read_write"
    assert api_key_record.display_prefix == material.display_prefix
    assert api_key_record.created_by == "admin"
    assert api_key_record.expires_at == expires_at
    assert api_key_record.last_used_at is None
    assert api_key_record.last_used_ip is None
    assert abs(datetime.now(UTC) - api_key_record.created_at) < timedelta(minutes=1)
    assert await repository.find_by_hash(material.key_hash) == api_key_record
    assert await repository.find_by_hash(generate_api_key().key_hash) is None


async def test_duplicate_name_ignoring_case_conflicts(db_config, clean_api_keys):
    repository = SqlApiKeyRepository(db_config)
    await _insert(repository, "Homepage")

    with pytest.raises(DomainConflictError):
        await _insert(repository, "homepage")
    assert [api_key_record.name for api_key_record in await repository.list_records()] == ["Homepage"]


async def test_list_records_is_newest_first(db_config, clean_api_keys):
    repository = SqlApiKeyRepository(db_config)
    for name in ("first", "second", "third"):
        await _insert(repository, name)

    assert [api_key_record.name for api_key_record in await repository.list_records()] == [
        "third",
        "second",
        "first",
    ]


async def test_touch_updates_last_used_time_and_ip(db_config, clean_api_keys):
    repository = SqlApiKeyRepository(db_config)
    api_key_record, material = await _insert(repository, "homepage")
    used_at = datetime(2026, 11, 2, 10, 0, tzinfo=UTC)

    await repository.touch(api_key_record.id, at=used_at, ip="192.168.1.20")

    touched_record = await repository.find_by_hash(material.key_hash)
    assert touched_record is not None
    assert touched_record.last_used_at == used_at
    assert touched_record.last_used_ip == "192.168.1.20"


async def test_touch_of_a_revoked_key_does_nothing(db_config, clean_api_keys):
    repository = SqlApiKeyRepository(db_config)
    api_key_record, _ = await _insert(repository, "homepage")
    await repository.delete(api_key_record.id)

    await repository.touch(api_key_record.id, at=datetime(2026, 11, 2, 10, 0, tzinfo=UTC), ip="192.168.1.20")

    assert await repository.list_records() == []


async def test_delete_returns_the_record_once(db_config, clean_api_keys):
    repository = SqlApiKeyRepository(db_config)
    api_key_record, material = await _insert(repository, "homepage")

    assert await repository.delete(api_key_record.id) == api_key_record
    assert await repository.delete(api_key_record.id) is None
    assert await repository.find_by_hash(material.key_hash) is None
