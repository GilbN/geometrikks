from __future__ import annotations

from typing import Any
from litestar import get
from geometrikks.config.settings import get_settings

settings = get_settings()

@get("/settings")
async def read_settings() -> dict[str, Any]:
    """Endpoint to read current application settings."""
    return settings.model_dump()
