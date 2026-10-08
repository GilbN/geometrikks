"""add cutoff to import_jobs

Revision ID: 5c2e9a71d3f4
Revises: e7a1c3b5d904
Create Date: 2026-10-08 00:00:00.000000

Records the import-logs --before a file was imported with, so a later run
with a later cutoff imports only the lines in between.
"""

import warnings

from alembic import op

revision = "5c2e9a71d3f4"
down_revision = "e7a1c3b5d904"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        with op.get_context().autocommit_block():
            op.execute("ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS cutoff TIMESTAMPTZ")


def downgrade() -> None:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        with op.get_context().autocommit_block():
            op.execute("ALTER TABLE import_jobs DROP COLUMN IF EXISTS cutoff")
