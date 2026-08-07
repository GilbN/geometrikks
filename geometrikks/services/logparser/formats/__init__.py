"""Log line format adapters and the auto-detection registry."""
from __future__ import annotations

from .base import LogLineFormat, NormalizedLine
from .nginx import NginxFormat

# Sniffing order matters: cheap/most-specific first. traefik-json is added
# in front of nginx by a later task (its '{' prefix check is near-free).
FORMATS: dict[str, LogLineFormat] = {
    NginxFormat.name: NginxFormat(),
}


def sniff_format(lines: list[str]) -> LogLineFormat | None:
    """Return the first registered format that parses any of the lines."""
    for line in lines:
        if not line.strip():
            continue
        for fmt in FORMATS.values():
            if fmt.parse(line) or fmt.parse(line, geo_only=True):
                return fmt
    return None


__all__ = ["FORMATS", "LogLineFormat", "NormalizedLine", "sniff_format"]
