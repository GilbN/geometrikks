"""The fields the debug detail view shows for a JSON raw line."""
from __future__ import annotations

from typing import Any

import msgspec

from geometrikks.domain.logs.schemas import RawLineField, RawLineFieldGroup, RawLineFields
from geometrikks.services.logparser.json_fields import (
    HeaderKind,
    KeyPath,
    accepting_json_format,
    decode_json_object,
    flatten,
    header_name,
    stored_columns,
)

# Proxy access lines nest three levels at most, as in Caddy's request.headers.X,
# and carry well under 500 keys. No proxy writes a line past either limit, so
# such a line shows in the Raw view only.
_MAX_DEPTH = 6
_MAX_FIELDS = 500

_HEADER_GROUPS: dict[HeaderKind, RawLineFieldGroup] = {
    "request": "request_header",
    "response": "response_header",
    "origin": "origin_header",
}


def raw_line_fields(raw_line: str, *, linked: bool) -> RawLineFields | None:
    """Fields of a JSON-object raw line, or None for anything else.

    Args:
        raw_line: The stored raw line.
        linked: Whether the line produced an access-log row. Only then does a
            key count as stored.

    Returns:
        The fields in line order, or None when the line is not a JSON object.
    """
    record = decode_json_object(raw_line)
    if record is None:
        return None
    leaves = _proxy_shaped_leaves(record)
    if leaves is None:
        return None
    line_format = accepting_json_format(raw_line) if linked else None
    stored = stored_columns(line_format, record) if line_format else {}
    return RawLineFields(
        format=line_format.name if line_format else None,
        fields=[_field(key_path, value, stored.get(key_path)) for key_path, value in leaves],
    )


def _proxy_shaped_leaves(record: dict[str, Any]) -> list[tuple[KeyPath, str]] | None:
    """Leaves with rendered values, or None at the first sign the line is not a proxy's."""
    leaves: list[tuple[KeyPath, str]] = []
    for key_path, value in flatten(record):
        if len(key_path) > _MAX_DEPTH or len(leaves) == _MAX_FIELDS:
            return None
        leaves.append((key_path, _render(value)))
    return leaves


def _field(key_path: KeyPath, value: str, stored_as: str | None) -> RawLineField:
    header = header_name(key_path)
    if header is None:
        return RawLineField(key=".".join(key_path), value=value, group="field", stored_as=stored_as)
    kind, name = header
    return RawLineField(key=name, value=value, group=_HEADER_GROUPS[kind], stored_as=stored_as)


def _render(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list) and value and all(isinstance(item, str) for item in value):
        return ", ".join(value)
    return msgspec.json.encode(value).decode()
