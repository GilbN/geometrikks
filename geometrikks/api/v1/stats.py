from __future__ import annotations

from geometrikks.logparser import LogParser
from typing import Any
from litestar import get
from geometrikks.config.settings import get_settings

settings = get_settings()

@get("/stats")
async def stats(log_parser: LogParser) -> dict[str, Any]:
    
    return {"total_parsed_lines": log_parser.parsed_lines, "total_skipped_lines": log_parser.skipped_lines, "total_pending_lines": log_parser.pending_lines}
