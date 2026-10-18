import re

from sqlalchemy.dialects import postgresql

from geometrikks.domain.instances.models import INSTANCE_HEARTBEAT_COLUMNS, InstanceHeartbeat
from geometrikks.domain.instances.repositories import _UPSERT_HEARTBEAT

# (postgres type, server default) of the nine original columns, all NOT NULL.
ORIGINAL_COLUMNS = {
    "id": ("BIGINT", None),
    "instance_name": ("VARCHAR(255)", None),
    "boot_id": ("UUID", None),
    "mode": ("VARCHAR(16)", None),
    "app_version": ("VARCHAR(64)", None),
    "schema_revision": ("VARCHAR(64)", None),
    "started_at": ("TIMESTAMP WITH TIME ZONE", None),
    "last_seen": ("TIMESTAMP WITH TIME ZONE", "now()"),
    "payload": ("JSONB", "'{}'::jsonb"),
}


def _column_shape(column) -> tuple[str, str | None]:
    server_default = None if column.server_default is None else str(column.server_default.arg)
    return column.type.compile(dialect=postgresql.dialect()), server_default


def test_heartbeat_columns_are_pinned() -> None:
    """Older instances read this table during a rolling upgrade, so it only
    gains nullable columns. Any column beyond the original nine must be
    nullable, and the nine keep their type, nullability and server default."""
    columns = {column.name: column for column in InstanceHeartbeat.__table__.columns}
    assert set(columns) == INSTANCE_HEARTBEAT_COLUMNS
    assert set(ORIGINAL_COLUMNS) <= set(columns)

    for column_name, expected_shape in ORIGINAL_COLUMNS.items():
        column = columns[column_name]
        assert _column_shape(column) == expected_shape, column_name
        assert column.nullable is False, column_name

    for column_name in set(columns) - set(ORIGINAL_COLUMNS):
        assert columns[column_name].nullable is True, column_name


def test_upsert_insert_columns_are_pinned() -> None:
    """An older head's table may lack any column added later, so the upsert
    names only the original columns and new data goes in the payload."""
    insert_columns = re.search(r"INSERT INTO instance_heartbeats\s*\(([^)]*)\)", _UPSERT_HEARTBEAT.text)
    assert insert_columns is not None
    assert [column_name.strip() for column_name in insert_columns.group(1).split(",")] == [
        "instance_name",
        "boot_id",
        "mode",
        "app_version",
        "schema_revision",
        "started_at",
        "last_seen",
        "payload",
    ]
