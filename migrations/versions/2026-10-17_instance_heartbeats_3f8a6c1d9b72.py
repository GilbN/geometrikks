"""add instance_heartbeats

Revision ID: 3f8a6c1d9b72
Revises: 18be2778bd7c
Create Date: 2026-10-17 00:00:00.000000

One row per running instance, upserted by the instance and read by the head.
Older instances read rows written by newer ones during a rolling upgrade, so
this table only gains nullable columns and payload keys are added, never
renamed or repurposed.
"""

import warnings

from alembic import op

revision = "3f8a6c1d9b72"
down_revision = "18be2778bd7c"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        with op.get_context().autocommit_block():
            op.execute(
                """
                CREATE TABLE IF NOT EXISTS instance_heartbeats (
                    id BIGSERIAL,
                    instance_name VARCHAR(255) NOT NULL,
                    boot_id UUID NOT NULL,
                    mode VARCHAR(16) NOT NULL,
                    app_version VARCHAR(64) NOT NULL,
                    schema_revision VARCHAR(64) NOT NULL,
                    started_at TIMESTAMPTZ NOT NULL,
                    last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
                    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    CONSTRAINT pk_instance_heartbeats PRIMARY KEY (id),
                    CONSTRAINT uq_instance_heartbeats_instance_name UNIQUE (instance_name)
                )
                """
            )


def downgrade() -> None:
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning)
        with op.get_context().autocommit_block():
            op.execute("DROP TABLE IF EXISTS instance_heartbeats")
