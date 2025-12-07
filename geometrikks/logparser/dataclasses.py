from __future__ import annotations
from dataclasses import dataclass, field
import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from geometrikks.db.models import GeoEvent, AccessLog


@dataclass
class ParsedOrmRecord:
    """Parsed log record with ORM objects and debug metadata."""
    matched: re.Match[str] | None
    ip: str | None
    geo_event: GeoEvent | None
    access_log: AccessLog | None
    # Debug fields for AccessLogDebug
    raw_line: str | None = field(default=None)
    is_malformed: bool = field(default=False)
    parse_error: str | None = field(default=None)