"""Log line format adapters and the auto-detection registry."""
from __future__ import annotations

from typing import NamedTuple

from .base import LogLineFormat, NormalizedLine
from .nginx import NginxFormat
from .traefik import TraefikJsonFormat

# Sniffing order matters: cheap/most-specific first. traefik-json sits in
# front of nginx: its '{' prefix check is near-free.
FORMATS: dict[str, LogLineFormat] = {
    TraefikJsonFormat.name: TraefikJsonFormat(),
    NginxFormat.name: NginxFormat(),
}


class SniffResult(NamedTuple):
    """A sniffed format plus how confidently it was recognized.

    ``geo_only`` is True when only the relaxed ip+timestamp pattern matched.
    The nginx geo-only pattern accepts any ``IP - user [date]`` prefix, so it
    also matches standard combined/CLF lines from other servers; locking such
    a file to full parsing would drop every line.
    """

    format: LogLineFormat
    geo_only: bool


def sniff_format(lines: list[str]) -> SniffResult | None:
    """Return the first registered format that parses any of the lines.

    Full parsing wins over a geo-only match across all formats and all lines,
    so a near-miss line never shadows a format that fully understands the file.

    Args:
        lines: Candidate raw log lines.

    Returns:
        SniffResult for the matching format, or None when nothing matched.
    """
    geo_only_hit: LogLineFormat | None = None
    for line in lines:
        if not line.strip():
            continue
        for fmt in FORMATS.values():
            if fmt.parse(line):
                return SniffResult(fmt, geo_only=False)
            if geo_only_hit is None and fmt.parse(line, geo_only=True):
                geo_only_hit = fmt
    if geo_only_hit is not None:
        return SniffResult(geo_only_hit, geo_only=True)
    return None


__all__ = ["FORMATS", "LogLineFormat", "NormalizedLine", "SniffResult", "sniff_format"]
