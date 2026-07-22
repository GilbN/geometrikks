import os
import time
import logging
import asyncio
from functools import wraps
from pathlib import Path
from typing import ParamSpec, Callable
from dataclasses import dataclass

import aiofiles.os
import aiofiles

import maxminddb
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

P = ParamSpec("P")

@dataclass
class GeoIPInfoView:
    available: bool
    db_path: str
    build_date: datetime | None
    age_days: int | None

def wait(timeout_seconds: int = 60) -> Callable[[Callable[P, bool]], Callable[P, bool]]:
    """Factory Decorator to wait for a function to return True for a given amount of time.

    Args:
        timeout_seconds (int, optional): Defaults to 60.
    """

    def decorator(func: Callable[P, bool]) -> Callable[P, bool]:
        @wraps(func)
        def wrapper(*args: P.args, **kwargs: P.kwargs) -> bool:
            # Allow tests to bypass retry loops
            if os.getenv("DISABLE_WAIT", "false").lower() == "true":
                return bool(func(*args, **kwargs))
            timeout: float = time.time() + timeout_seconds
            while time.time() < timeout:
                if func(*args, **kwargs):
                    return True
                time.sleep(1)
            logger.error(
                f"Timeout of {timeout_seconds} seconds reached on {getattr(func, '__name__', 'unknown')} function."
            )
            return False

        return wrapper

    return decorator


async def wait_for_path(
    path: Path | str,
    timeout_seconds: float = 60.0,
    check_interval: float = 1.0,
) -> bool:
    """Wait for a file path to exist.

    Uses asyncio.sleep() which responds to task cancellation (SIGINT/SIGTERM).

    Args:
        path: File path to check for existence.
        timeout_seconds: Maximum seconds to wait.
        check_interval: Seconds between existence checks.

    Returns:
        True if path exists, False if timeout reached.

    Raises:
        asyncio.CancelledError: If the task is cancelled (e.g., SIGINT).
    """
    # Allow tests to bypass retry loops
    if os.getenv("DISABLE_WAIT", "false").lower() == "true":
        return await aiofiles.os.path.exists(path)

    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if await aiofiles.os.path.exists(path):
            logger.info("Path found: %s", path)
            return True
        # asyncio.sleep properly raises CancelledError on task cancellation
        logger.debug(
            "Path %s not found, retrying in %.1f seconds...", path, check_interval
        )
        await asyncio.sleep(check_interval)

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
