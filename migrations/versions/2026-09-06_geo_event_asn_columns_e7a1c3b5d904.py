"""add asn columns to geo_events

Revision ID: e7a1c3b5d904
Revises: 8b7884d1daaf
Create Date: 2026-09-06 00:00:00.000000

Mirrors the access_logs ASN columns so geo events carry the autonomous
system at event time and the per-IP continuous aggregates can roll it up.
"""

import warnings

import sqlalchemy as sa
from alembic import op

revision = "e7a1c3b5d904"
down_revision = "8b7884d1daaf"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        with op.get_context().autocommit_block():
            schema_upgrades()


def downgrade() -> None:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        with op.get_context().autocommit_block():
            schema_downgrades()


def schema_upgrades() -> None:
    """Add the ASN columns, tolerating a partially applied rerun.

    Each statement commits on its own (autocommit block), so a crash before
    alembic stamps the revision leaves the columns in place and reruns this
    on the next startup; plain ADD COLUMN would then fail with DuplicateColumn.
    """
    op.execute("ALTER TABLE geo_events ADD COLUMN IF NOT EXISTS autonomous_system_number BIGINT")
    op.execute("ALTER TABLE geo_events ADD COLUMN IF NOT EXISTS autonomous_system_organization VARCHAR(255)")
    # A plain CREATE INDEX on a hypertable with months of chunks holds a
    # write lock on all of them for the whole build, stalling agents
    # mid-insert. One chunk per transaction keeps each lock short. The
    # option is rejected on a plain table, which geo_events still is on a
    # fresh install (hypertable conversion happens after migrations).
    bind = op.get_bind()
    has_timescale = bind.execute(sa.text(
        "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')"
    )).scalar()
    is_hypertable = has_timescale and bind.execute(sa.text(
        "SELECT EXISTS (SELECT 1 FROM timescaledb_information.hypertables "
        "WHERE hypertable_name = 'geo_events')"
    )).scalar()
    with_clause = " WITH (timescaledb.transaction_per_chunk)" if is_hypertable else ""
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_geo_events_asn "
        f"ON geo_events (autonomous_system_number){with_clause}"
    )


def schema_downgrades() -> None:
    """Drop the ASN columns, and first the per-IP CAGGs that read them.

    ip_location_{hourly,daily}_stats (managed by server/timescale.py, not
    alembic) select these columns once upgraded, so DROP COLUMN fails while
    they exist. Dropping them is safe: startup recreates them.
    """
    op.execute("DROP MATERIALIZED VIEW IF EXISTS ip_location_hourly_stats CASCADE")
    op.execute("DROP MATERIALIZED VIEW IF EXISTS ip_location_daily_stats CASCADE")
    op.execute("DROP INDEX IF EXISTS ix_geo_events_asn")
    op.execute("ALTER TABLE geo_events DROP COLUMN IF EXISTS autonomous_system_organization")
    op.execute("ALTER TABLE geo_events DROP COLUMN IF EXISTS autonomous_system_number")
