"""Read any JSON log line as key paths: headers, stored keys and the rest.

The header rules work without knowing which proxy wrote the line. Traefik
puts headers in top-level ``request_``, ``downstream_`` and ``origin_`` keys,
and the name after the prefix starts with a capital letter or a digit. That
rule keeps ``request_time`` from the GeoMetrikks format a plain field. Caddy
nests headers under ``request.headers`` and ``resp_headers``.
"""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any, Literal

import msgspec

from .formats import FORMATS
from .formats.base import JsonLogLineFormat

KeyPath = tuple[str, ...]
HeaderKind = Literal["request", "response", "origin"]

_HEADER_PREFIXES: tuple[tuple[str, HeaderKind], ...] = (
    ("request_", "request"),
    ("downstream_", "response"),
    ("origin_", "origin"),
)
_HEADER_OBJECTS: tuple[tuple[KeyPath, HeaderKind], ...] = (
    (("request", "headers"), "request"),
    (("resp_headers",), "response"),
)


def decode_json_object(line: str) -> dict[str, Any] | None:
    """The line as a dict, or None when it is not a JSON object."""
    stripped = line.strip()
    if not stripped.startswith("{"):
        return None
    try:
        # json.loads accepts lone surrogate escapes such as \ud800, and a
        # msgspec encoder then fails on the decoded string. msgspec rejects them.
        record = msgspec.json.decode(stripped)
    except msgspec.DecodeError:
        return None
    return record if isinstance(record, dict) else None


def flatten(record: dict[str, Any]) -> Iterator[tuple[KeyPath, Any]]:
    """Leaves in line order. Walks a stack because lines from imports and
    Loki can nest deeper than Python's recursion limit. One path list serves
    every level, because a path per level costs memory quadratic in depth."""
    stack: list[Iterator[tuple[str, Any]]] = [iter(record.items())]
    path: list[str] = []
    while stack:
        entry = next(stack[-1], None)
        if entry is None:
            stack.pop()
            if path:
                path.pop()
            continue
        key, child = entry
        if isinstance(child, dict) and child:
            path.append(key)
            stack.append(iter(child.items()))
        else:
            yield (*path, key), child


def header_name(key_path: KeyPath) -> tuple[HeaderKind, str] | None:
    """Which header a key path holds and its name, or None for other keys."""
    for object_path, kind in _HEADER_OBJECTS:
        if len(key_path) > len(object_path) and key_path[: len(object_path)] == object_path:
            return kind, ".".join(key_path[len(object_path) :])
    if len(key_path) == 1:
        for prefix, kind in _HEADER_PREFIXES:
            name = key_path[0].removeprefix(prefix)
            if name != key_path[0] and (name[:1].isupper() or name[:1].isdigit()):
                return kind, name
    return None


def accepting_json_format(line: str) -> JsonLogLineFormat | None:
    """The first JSON format whose parser reads the line in full."""
    for line_format in FORMATS.values():
        if not isinstance(line_format, JsonLogLineFormat):
            continue
        try:
            accepted = line_format.parse(line) is not None
        except Exception:
            # Each parser trusts its own format's value types. Traefik's raises
            # on a Caddy line that carries a numeric ClientHost.
            accepted = False
        if accepted:
            return line_format
    return None


def stored_columns(line_format: JsonLogLineFormat, record: dict[str, Any]) -> dict[KeyPath, str]:
    """The access-log column each key path fills, for the keys the parser read."""
    columns: dict[KeyPath, str] = {}
    for column in line_format.stored_columns:
        for key_path in column.paths:
            if column.accepts(_lookup(record, key_path)):
                columns[key_path] = column.label
                break
    return columns


def _lookup(record: dict[str, Any], key_path: KeyPath) -> Any:
    value: Any = record
    for key in key_path:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value
