import os
import time
import asyncio
from pathlib import Path


import msgspec

import aiofiles.os
import aiofiles

import maxminddb
from datetime import datetime, timezone

from geometrikks.server.logging import get_logger

logger = get_logger(__name__)


class GeoIPInfoView(msgspec.Struct, rename="camel"):
    available: bool
    db_path: str
    build_date: datetime | None
    age_days: int | None

def retries_disabled() -> bool:
    """Whether retry loops should collapse to a single attempt (test hook)."""
    return os.getenv("DISABLE_WAIT", "false").lower() == "true"


async def sleep_unless_stopped(
    seconds: float, stop_event: asyncio.Event | None = None
) -> bool:
    """Sleep, waking early if a stop is requested.

    Retry loops that only sleep and re-check their stop event on the next
    iteration keep a shutdown waiting for up to a full interval. Racing the
    event instead makes the wait end as soon as the stop is signalled.

    Args:
        seconds: Maximum seconds to sleep.
        stop_event: Event that ends the sleep early when set.

    Returns:
        True if a stop was requested, False if the full interval elapsed.
    """
    if stop_event is None:
        await asyncio.sleep(seconds)
        return False
    try:
        await asyncio.wait_for(stop_event.wait(), timeout=seconds)
    except TimeoutError:
        return False
    return True


async def wait_for_path(
    path: Path | str,
    timeout_seconds: float = 60.0,
    check_interval: float = 1.0,
    stop_event: asyncio.Event | None = None,
) -> bool:
    """Wait for a file path to exist.

    Uses asyncio.sleep() which responds to task cancellation (SIGINT/SIGTERM).

    Args:
        path: File path to check for existence.
        timeout_seconds: Maximum seconds to wait.
        check_interval: Seconds between existence checks.
        stop_event: Ends the wait early when set, so a shutdown does not have
            to wait out the timeout (or be resolved by cancellation).

    Returns:
        True if path exists, False if the timeout is reached or a stop was
        requested.

    Raises:
        asyncio.CancelledError: If the task is cancelled (e.g., SIGINT).
    """
    # Allow tests to bypass retry loops
    if retries_disabled():
        return await aiofiles.os.path.exists(path)

    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if stop_event is not None and stop_event.is_set():
            return False
        if await aiofiles.os.path.exists(path):
            logger.info("Path found: %s", path)
            return True
        # asyncio.sleep properly raises CancelledError on task cancellation
        logger.debug(
            "Path %s not found, retrying in %.1f seconds...", path, check_interval
        )
        if await sleep_unless_stopped(check_interval, stop_event):
            return False

    logger.error(
        "Timeout of %.1f seconds reached waiting for path: %s", timeout_seconds, path
    )
    return False

def geoip_info(db_path: Path) -> GeoIPInfoView:
    """Build date and age from mmdb metadata; degrades when missing."""
    try:
        with maxminddb.open_database(str(db_path)) as reader:
            build: datetime = datetime.fromtimestamp(reader.metadata().build_epoch, tz=timezone.utc)
        age_days: int = (datetime.now(timezone.utc) - build).days
        return GeoIPInfoView(
            available=True, db_path=str(db_path), build_date=build, age_days=age_days
        )
    except Exception:
        return GeoIPInfoView(
            available=False, db_path=str(db_path), build_date=None, age_days=None
        )
