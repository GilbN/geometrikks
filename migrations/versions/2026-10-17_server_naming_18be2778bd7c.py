"""rename hostname columns and site_homes to server

Revision ID: 18be2778bd7c
Revises: a4d1f0c2b7e9
Create Date: 2026-10-17 00:00:00.000000

Catalog renames only, no data rewrite. The continuous aggregates over these
columns keep working under their old column names until setup_timescaledb
renames them, which runs after migrations on every start.
"""

import sqlalchemy as sa
from alembic import op

revision = "18be2778bd7c"
down_revision = "a4d1f0c2b7e9"
branch_labels = None
depends_on = None

TABLE_COLUMN_RENAMES = (
    ("geo_events", "hostname", "server"),
    ("access_logs", "hostname", "server"),
    ("loki_imports", "hostname", "server"),
)
INDEX_RENAMES = (
    ("ix_geo_events_hostname", "ix_geo_events_server"),
    ("ix_access_logs_hostname", "ix_access_logs_server"),
)
SERVER_LOCATIONS_RENAME = ("site_homes", "server_locations")
SERVER_LOCATIONS_SEQUENCE_RENAME = ("site_homes_id_seq", "server_locations_id_seq")
SERVER_LOCATIONS_CONSTRAINT_RENAMES = (
    ("pk_site_homes", "pk_server_locations"),
    ("uq_site_homes_hostname", "uq_server_locations_server"),
    ("ck_site_homes_source", "ck_server_locations_source"),
)

# setup_timescaledb renames these forward. The previous release's
# setup_timescaledb knows only the legacy names and would rebuild the views
# it cannot find, so the downgrade renames them back as well.
CAGG_VIEW_RENAMES = (("hostname_daily_stats", "server_daily_stats"),)
CAGG_COLUMN_RENAMES = (
    ("location_hourly_stats", "hostname", "server"),
    ("location_daily_stats", "hostname", "server"),
    ("ip_location_hourly_stats", "hostnames", "servers"),
    ("ip_location_hourly_stats", "hostname_hits", "server_hits"),
    ("ip_location_daily_stats", "hostnames", "servers"),
    ("ip_location_daily_stats", "hostname_hits", "server_hits"),
    ("server_daily_stats", "hostname", "server"),
    ("log_source_daily_stats", "hostname", "server"),
)
CAGG_INDEX_RENAMES = (
    ("ix_location_hourly_hostname", "ix_location_hourly_server"),
    ("ix_location_daily_hostname", "ix_location_daily_server"),
    ("ix_hostname_daily_stats_bucket", "ix_server_daily_stats_bucket"),
)


def _relation_exists(name: str) -> bool:
    return bool(op.get_bind().execute(
        sa.text("SELECT to_regclass(:name) IS NOT NULL"), {"name": f"public.{name}"}
    ).scalar())


def _column_exists(table: str, column: str) -> bool:
    return bool(op.get_bind().execute(sa.text(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema = 'public' AND table_name = :table AND column_name = :column"
    ), {"table": table, "column": column}).scalar())


def _rename_column(kind: str, table: str, old: str, new: str) -> None:
    if _column_exists(table, old) and not _column_exists(table, new):
        op.execute(f"ALTER {kind} {table} RENAME COLUMN {old} TO {new}")


def _rename_relation(kind: str, old: str, new: str) -> None:
    if _relation_exists(old) and not _relation_exists(new):
        op.execute(f"ALTER {kind} {old} RENAME TO {new}")


def _rename_index(old: str, new: str) -> None:
    """Continuous-aggregate indexes live in _timescaledb_internal, not public."""
    bind = op.get_bind()
    schema = bind.execute(
        sa.text("SELECT schemaname FROM pg_indexes WHERE indexname = :name"), {"name": old}
    ).scalar()
    already_renamed = bind.execute(
        sa.text("SELECT 1 FROM pg_indexes WHERE indexname = :name"), {"name": new}
    ).scalar()
    if schema is not None and not already_renamed:
        op.execute(f'ALTER INDEX "{schema}".{old} RENAME TO {new}')


def _rename_constraint(table: str, old: str, new: str) -> None:
    exists = op.get_bind().execute(sa.text(
        "SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(:table) AND conname = :name"
    ), {"table": f"public.{table}", "name": old}).scalar()
    if exists:
        op.execute(f"ALTER TABLE {table} RENAME CONSTRAINT {old} TO {new}")


def upgrade() -> None:
    for table, old, new in TABLE_COLUMN_RENAMES:
        _rename_column("TABLE", table, old, new)
    for old, new in INDEX_RENAMES:
        _rename_index(old, new)

    legacy_table, table = SERVER_LOCATIONS_RENAME
    _rename_relation("TABLE", legacy_table, table)
    _rename_column("TABLE", table, "hostname", "server")
    _rename_relation("SEQUENCE", *SERVER_LOCATIONS_SEQUENCE_RENAME)
    for old, new in SERVER_LOCATIONS_CONSTRAINT_RENAMES:
        _rename_constraint(table, old, new)


def downgrade() -> None:
    for view, legacy_column, column in CAGG_COLUMN_RENAMES:
        _rename_column("MATERIALIZED VIEW", view, column, legacy_column)
    for legacy_view, view in CAGG_VIEW_RENAMES:
        _rename_relation("MATERIALIZED VIEW", view, legacy_view)
    for legacy_index, index in CAGG_INDEX_RENAMES:
        _rename_index(index, legacy_index)

    legacy_table, table = SERVER_LOCATIONS_RENAME
    for legacy_constraint, constraint in SERVER_LOCATIONS_CONSTRAINT_RENAMES:
        _rename_constraint(table, constraint, legacy_constraint)
    legacy_sequence, sequence = SERVER_LOCATIONS_SEQUENCE_RENAME
    _rename_relation("SEQUENCE", sequence, legacy_sequence)
    _rename_column("TABLE", table, "server", "hostname")
    _rename_relation("TABLE", table, legacy_table)

    for legacy_index, index in INDEX_RENAMES:
        _rename_index(index, legacy_index)
    for table_name, legacy_column, column in TABLE_COLUMN_RENAMES:
        _rename_column("TABLE", table_name, column, legacy_column)
