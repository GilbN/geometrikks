"""The /schema reference carries the API intro, tag descriptions and model docstrings."""

from __future__ import annotations

from typing import Any

import msgspec
import pytest

from geometrikks.domain.auth.api_key_controllers import ApiKeyView
from geometrikks.server.openapi_docs import API_TAGS
from geometrikks.server.openapi_schema_plugins import own_docstring
from geometrikks.services.logfiles import LogTailRecord


@pytest.fixture
def openapi_document(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    monkeypatch.setenv("APP_ADMIN_PASSWORD", "openapi-docs-test")
    from geometrikks.server.core import create_app

    return create_app().openapi_schema.to_schema()


def test_struct_docstring_becomes_the_component_description(openapi_document: dict[str, Any]):
    description = openapi_document["components"]["schemas"]["ApiKeyView"]["description"]
    assert description == own_docstring(ApiKeyView)


def test_typed_dict_docstring_becomes_the_component_description(openapi_document: dict[str, Any]):
    description = openapi_document["components"]["schemas"]["LogTailRecord"]["description"]
    assert description == own_docstring(LogTailRecord)


def test_struct_without_a_docstring_gets_no_description():
    class Undocumented(msgspec.Struct):
        value: int

    assert own_docstring(Undocumented) is None


@pytest.mark.parametrize(
    "required_text",
    ["Authorization: Bearer gmk_", "**Read**", "**Read/write**", "| 401 |", "| 403 |", "| 503 |", "UTC"],
)
def test_intro_covers_auth_scopes_errors_and_time(openapi_document: dict[str, Any], required_text: str):
    assert required_text in openapi_document["info"]["description"]


def test_every_tag_an_operation_uses_has_a_description(openapi_document: dict[str, Any]):
    described_tags = {tag["name"]: tag.get("description") for tag in openapi_document["tags"]}
    used_tags = {
        tag_name
        for path_item in openapi_document["paths"].values()
        for operation in path_item.values()
        if isinstance(operation, dict)
        for tag_name in operation.get("tags", [])
    }
    assert all(described_tags.get(tag_name) for tag_name in used_tags), used_tags - set(described_tags)


def test_every_described_tag_is_in_use(openapi_document: dict[str, Any]):
    used_tags = {
        tag_name
        for path_item in openapi_document["paths"].values()
        for operation in path_item.values()
        if isinstance(operation, dict)
        for tag_name in operation.get("tags", [])
    }
    assert {tag.name for tag in API_TAGS} <= used_tags
