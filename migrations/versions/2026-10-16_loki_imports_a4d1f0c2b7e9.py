"""add loki_imports

Revision ID: a4d1f0c2b7e9
Revises: 5c2e9a71d3f4
Create Date: 2026-10-16 00:00:00.000000

Bookkeeping for import-loki: one row per run over a time range of one
selector, with the cursor the next run resumes from.
"""

import warnings

from alembic import op

revision = "a4d1f0c2b7e9"
down_revision = "5c2e9a71d3f4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        with op.get_context().autocommit_block():
            op.execute(
                """
                CREATE TABLE IF NOT EXISTS loki_imports (
                    id BIGSERIAL,
                    url TEXT NOT NULL,
                    tenant_id TEXT,
                    query TEXT NOT NULL,
                    hostname VARCHAR(255) NOT NULL,
                    range_start TIMESTAMPTZ NOT NULL,
                    range_end TIMESTAMPTZ NOT NULL,
                    cursor TIMESTAMPTZ NOT NULL,
                    lines_total BIGINT NOT NULL DEFAULT 0,
                    lines_skipped BIGINT NOT NULL DEFAULT 0,
                    records_written BIGINT NOT NULL DEFAULT 0,
                    time_start TIMESTAMPTZ,
                    time_end TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL,
                    CONSTRAINT pk_loki_imports PRIMARY KEY (id)
                )
                """
            )
            op.execute(
                "CREATE INDEX IF NOT EXISTS ix_loki_imports_url_query "
                "ON loki_imports (url, query)"
            )


def downgrade() -> None:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        with op.get_context().autocommit_block():
            op.execute("DROP TABLE IF EXISTS loki_imports")
