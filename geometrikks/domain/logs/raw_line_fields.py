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

# A line past any of these shows in the Raw view only. Every row on a debug
# page goes through here, so one hostile line must not cost the whole page.
_MAX_DEPTH = 16
_MAX_FIELDS = 500
_MAX_TEXT_CHARS = 64 * 1024

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
    leaves = _leaves_within_budget(record)
    if leaves is None:
        return None
    line_format = accepting_json_format(raw_line) if linked else None
    stored = stored_columns(line_format, record) if line_format else {}
    return RawLineFields(
        format=line_format.name if line_format else None,
        fields=[_field(key_path, value, stored.get(key_path)) for key_path, value in leaves],
    )


def _leaves_within_budget(record: dict[str, Any]) -> list[tuple[KeyPath, str]] | None:
    """Leaves with rendered values, or None at the first one past the budget."""
    leaves: list[tuple[KeyPath, str]] = []
    text_chars = 0
    for key_path, value in flatten(record):
        if len(key_path) > _MAX_DEPTH or len(leaves) == _MAX_FIELDS:
            return None
        rendered = _render(value)
        text_chars += sum(len(key) for key in key_path) + len(rendered)
        if text_chars > _MAX_TEXT_CHARS:
            return None
        leaves.append((key_path, rendered))
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
