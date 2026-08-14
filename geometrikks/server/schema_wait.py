"""Agent-mode schema gate: bundled alembic head and DB readiness polling.

Agent mode never migrates (the primary instance owns the schema); this
module lets it wait for that schema to arrive instead of writing against a
half-migrated or unknown one. Import-time safe: nothing here builds an
alembic config or touches the database until a function is called.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Literal

from sqlalchemy import text

from geometrikks.server.logging import get_logger

if TYPE_CHECKING:
    from alembic.script import ScriptDirectory
    from sqlalchemy.ext.asyncio import AsyncEngine

logger = get_logger(__name__)


def _script_directory() -> "ScriptDirectory":
    """Build the bundled migrations' ScriptDirectory.

    Mirrors migrations.py's AlembicAsyncConfig construction (same relative
    "alembic.ini" / "migrations" paths, resolved from the process cwd) but
    via the plain alembic API, since nothing here executes migrations.
    """
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    config = Config("alembic.ini")
    config.set_main_option("script_location", "migrations")
    return ScriptDirectory.from_config(config)


def bundled_head_revision() -> str:
    """The alembic head revision bundled with this build."""
    head = _script_directory().get_current_head()
    if head is None:
        raise RuntimeError("No alembic head revision found under migrations/")
    return head


def known_revisions() -> set[str]:
    """Every revision hash bundled with this build."""
    return {revision.revision for revision in _script_directory().walk_revisions()}


async def wait_for_schema(
    engine: "AsyncEngine",
    *,
    timeout: float = 120.0,
    poll_interval: float = 3.0,
) -> Literal["ready", "newer", "timeout"]:
    """Poll ``alembic_version`` until the schema matches the bundled head.

    - "ready": the DB is at exactly the bundled head.
    - "newer": the DB is at a revision this build doesn't know about (a full
      instance mid rolling-restart, running ahead) -- warn and proceed
      rather than brick the agent.
    - "timeout": the window elapsed with no ready/newer read. A missing
      alembic_version table or a connection error is treated as "not ready
      yet" and keeps polling instead of failing immediately.
    """
    head = bundled_head_revision()
    known = known_revisions()
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout

    while True:
        try:
            async with engine.connect() as conn:
                result = await conn.execute(text("SELECT version_num FROM alembic_version"))
                version = result.scalar_one()
            if version == head:
                logger.info("schema wait: head reached")
                return "ready"
            if version not in known:
                logger.warning(
                    "Database schema (%s) is not among this build's known "
                    "revisions (bundled head %s); proceeding without waiting "
                    "further.",
                    version,
                    head,
                )
                return "newer"
            logger.info("schema wait: db at %s (bundled head %s), retrying", version, head)
        except Exception as e:
            logger.info(
                "schema wait: no alembic_version yet / DB unreachable (bundled head %s), retrying",
                head,
            )
            logger.debug("Schema not ready yet: %s", e)

        if loop.time() >= deadline:
            logger.error(
                "Timed out after %.0fs waiting for database schema to reach head %s",
                timeout,
                head,
            )
            return "timeout"
        await asyncio.sleep(poll_interval)
