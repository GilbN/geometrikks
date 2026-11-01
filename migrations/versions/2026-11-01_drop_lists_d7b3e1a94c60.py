"""add the DROP list tables

Revision ID: d7b3e1a94c60
Revises: c5e2a9f7d813
Create Date: 2026-11-01 00:00:00.000000

Networks and ASNs from the Spamhaus DROP feeds plus one state row per feed.
The tables are filled by the scheduled refresh, never by this migration.
"""

import warnings

from alembic import op

revision = "d7b3e1a94c60"
down_revision = "c5e2a9f7d813"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        with op.get_context().autocommit_block():
            op.execute(
                """
                CREATE TABLE IF NOT EXISTS drop_networks (
                    cidr CIDR NOT NULL,
                    sbl_id TEXT NOT NULL,
                    rir TEXT,
                    CONSTRAINT pk_drop_networks PRIMARY KEY (cidr)
                )
                """
            )
            op.execute(
                "CREATE INDEX IF NOT EXISTS ix_drop_networks_cidr_gist ON drop_networks USING gist (cidr inet_ops)"
            )
            op.execute(
                """
                CREATE TABLE IF NOT EXISTS drop_asns (
                    asn BIGINT NOT NULL,
                    name TEXT,
                    country_code TEXT,
                    rir TEXT,
                    domain TEXT,
                    CONSTRAINT pk_drop_asns PRIMARY KEY (asn)
                )
                """
            )
            op.execute(
                """
                CREATE TABLE IF NOT EXISTS drop_list_state (
                    feed TEXT NOT NULL,
                    upstream_timestamp TIMESTAMPTZ,
                    record_count INTEGER,
                    copyright TEXT,
                    fetched_at TIMESTAMPTZ,
                    checked_at TIMESTAMPTZ,
                    last_error TEXT,
                    CONSTRAINT pk_drop_list_state PRIMARY KEY (feed),
                    CONSTRAINT ck_drop_list_state_feed CHECK (feed IN ('v4', 'v6', 'asn'))
                )
                """
            )


def downgrade() -> None:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        with op.get_context().autocommit_block():
            op.execute("DROP TABLE IF EXISTS drop_list_state")
            op.execute("DROP TABLE IF EXISTS drop_asns")
            op.execute("DROP TABLE IF EXISTS drop_networks")
