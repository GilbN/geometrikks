"""add muted_ips

Revision ID: c3f9a2d17e58
Revises: b7e3d1f04a26
Create Date: 2026-11-20 00:00:00.000000

The saved list of IPs and networks the log views can hide.
"""

import sqlalchemy as sa
from advanced_alchemy.types import DateTimeUTC
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "c3f9a2d17e58"
down_revision = "b7e3d1f04a26"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "muted_ips",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("network", postgresql.CIDR(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", DateTimeUTC(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("sa_orm_sentinel", sa.Integer(), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_muted_ips"),
        sa.UniqueConstraint("network", name="uq_muted_ips_network"),
    )


def downgrade() -> None:
    op.drop_table("muted_ips")
