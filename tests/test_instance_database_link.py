"""Reading the TLS state of the database link from the asyncpg driver object."""
import asyncio
import ssl
from types import SimpleNamespace
from typing import Any, cast

import pytest
from sqlalchemy.ext.asyncio import AsyncConnection

from geometrikks.domain.instances.database_link import database_link_of, read_database_link
from geometrikks.domain.instances.schemas import DatabaseLinkReport


def _ssl(verify_mode: ssl.VerifyMode, check_hostname: bool) -> SimpleNamespace:
    return SimpleNamespace(context=SimpleNamespace(verify_mode=verify_mode, check_hostname=check_hostname))


def _driver(ssl_object: object) -> SimpleNamespace:
    return SimpleNamespace(_transport=SimpleNamespace(get_extra_info=lambda name: ssl_object))


def _driver_raising(error: Exception) -> SimpleNamespace:
    def get_extra_info(name: str) -> object:
        raise error

    return SimpleNamespace(_transport=SimpleNamespace(get_extra_info=get_extra_info))


def _connection_raising(error: BaseException) -> AsyncConnection:
    async def get_raw_connection() -> Any:
        raise error

    return cast(AsyncConnection, SimpleNamespace(get_raw_connection=get_raw_connection))


def test_plain_connection_is_not_encrypted() -> None:
    assert database_link_of(_driver(None)) == DatabaseLinkReport(encrypted=False, server_verified=False)


def test_tls_without_verification_is_encrypted_only() -> None:
    assert database_link_of(_driver(_ssl(ssl.CERT_NONE, False))) == DatabaseLinkReport(
        encrypted=True, server_verified=False
    )


def test_chain_check_without_name_check_is_not_verified() -> None:
    assert database_link_of(_driver(_ssl(ssl.CERT_REQUIRED, False))) == DatabaseLinkReport(
        encrypted=True, server_verified=False
    )


def test_chain_and_name_check_is_verified() -> None:
    assert database_link_of(_driver(_ssl(ssl.CERT_REQUIRED, True))) == DatabaseLinkReport(
        encrypted=True, server_verified=True
    )


def test_driver_without_a_transport_is_unknown() -> None:
    assert database_link_of(SimpleNamespace()) is None


def test_transport_that_raises_is_unknown() -> None:
    assert database_link_of(_driver_raising(RuntimeError("closed"))) is None


@pytest.mark.anyio
async def test_read_returns_none_when_the_raw_connection_fails() -> None:
    assert await read_database_link(_connection_raising(RuntimeError("invalidated"))) is None


@pytest.mark.anyio
async def test_read_lets_a_cancel_through() -> None:
    with pytest.raises(asyncio.CancelledError):
        await read_database_link(_connection_raising(asyncio.CancelledError()))
