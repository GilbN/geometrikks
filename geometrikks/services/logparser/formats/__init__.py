"""Log line format adapters and the auto-detection registry."""
from __future__ import annotations

from collections.abc import Mapping
from typing import NamedTuple

from .base import LogLineFormat, NormalizedLine
from .caddy import CaddyJsonFormat
from .geometrikks_json import GeometrikksJsonFormat
from .nginx import NginxFormat
from .npm import NpmFormat
from .traefik import TraefikJsonFormat

# Sniffing order: the recommended format first, then the other cheap '{'
# prefix checks, then the regex. The JSON adapters decline each other's
# lines on required keys (client_ip vs ClientHost vs the nested request
# object), so order is cost only.
FORMATS: dict[str, LogLineFormat] = {
    GeometrikksJsonFormat.name: GeometrikksJsonFormat(),
    TraefikJsonFormat.name: TraefikJsonFormat(),
    CaddyJsonFormat.name: CaddyJsonFormat(),
    NginxFormat.name: NginxFormat(),
}


class ImportOnlyFormat(NamedTuple):
    """A format only `litestar import-logs` reads, and what to tail instead."""

    adapter: LogLineFormat
    live_tailing_message: str


# Live tailing rejects these. Nginx Proxy Manager's own format lacks the
# timings, protocol and raw request line, and NPM can write a
# geometrikks-json log instead.
IMPORT_ONLY_FORMATS: dict[str, ImportOnlyFormat] = {
    NpmFormat.name: ImportOnlyFormat(
        adapter=NpmFormat(),
        live_tailing_message=(
            "'npm' is Nginx Proxy Manager's own log format, and only "
            "`litestar import-logs` reads it. For live logs, have NPM write a "
            "geometrikks-json log as the README's Nginx Proxy Manager section "
            "describes."
        ),
    ),
}

IMPORT_FORMATS: dict[str, LogLineFormat] = {
    **FORMATS,
    **{name: import_only.adapter for name, import_only in IMPORT_ONLY_FORMATS.items()},
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


def sniff_format(
    lines: list[str], formats: Mapping[str, LogLineFormat] = FORMATS
) -> SniffResult | None:
    """Return the first registered format that parses any of the lines.

    Full parsing wins over a geo-only match across all formats and all lines,
    so a near-miss line never shadows a format that fully understands the file.

    Args:
        lines: Candidate raw log lines.
        formats: Registry to try, in order. IMPORT_FORMATS for imports.

    Returns:
        SniffResult for the matching format, or None when nothing matched.
    """
    geo_only_hit: LogLineFormat | None = None
    for line in lines:
        if not line.strip():
            continue
        for fmt in formats.values():
            if fmt.parse(line):
                return SniffResult(fmt, geo_only=False)
            if geo_only_hit is None and fmt.parse(line, geo_only=True):
                geo_only_hit = fmt
    if geo_only_hit is not None:
        return SniffResult(geo_only_hit, geo_only=True)
    return None


__all__ = [
    "FORMATS",
    "IMPORT_FORMATS",
    "IMPORT_ONLY_FORMATS",
    "ImportOnlyFormat",
    "LogLineFormat",
    "NormalizedLine",
    "SniffResult",
    "sniff_format",
]
