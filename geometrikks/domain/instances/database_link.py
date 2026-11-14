"""Reads the TLS state of the database connection from the asyncpg driver object."""
import ssl
from typing import Any, cast

from sqlalchemy.ext.asyncio import AsyncConnection

from geometrikks.domain.instances.schemas import DatabaseLinkReport


def database_link_of(driver_connection: object) -> DatabaseLinkReport | None:
    """The link state of an asyncpg connection; None when it cannot be read."""
    try:
        # _transport is private to asyncpg. tests/integration/test_heartbeat_writer_pg.py
        # fails when a driver upgrade removes it.
        ssl_object = cast(Any, driver_connection)._transport.get_extra_info("ssl_object")
        if ssl_object is None:
            return DatabaseLinkReport(encrypted=False, server_verified=False)
        context = ssl_object.context
        return DatabaseLinkReport(
            encrypted=True,
            server_verified=context.verify_mode == ssl.CERT_REQUIRED and bool(context.check_hostname),
        )
    except Exception:
        return None


async def read_database_link(connection: AsyncConnection) -> DatabaseLinkReport | None:
    """The link state of the connection's session; None when it cannot be read."""
    try:
        raw_connection = await connection.get_raw_connection()
        return database_link_of(raw_connection.driver_connection)
    except Exception:
        return None
