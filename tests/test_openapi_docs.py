"""The /schema reference carries the API intro, tag descriptions and model docstrings."""

from __future__ import annotations

from typing import Any, Generic, TypedDict, TypeVar

import msgspec
import pytest
from litestar import Litestar, get
from litestar.openapi import OpenAPIConfig
from litestar.openapi.spec import Schema
from litestar.typing import FieldDefinition

from geometrikks.domain.auth.api_key_controllers import ApiKeyView
from geometrikks.domain.auth.controllers import AuthController
from geometrikks.domain.system.controllers.settings import DefaultMapView
from geometrikks.server.api_key_auth import NO_CREDENTIALS_SECURITY
from geometrikks.server.openapi_docs import API_TAGS
from geometrikks.server.openapi_schema_plugins import DOCSTRING_SCHEMA_PLUGINS, _describe, own_docstring
from geometrikks.services.logfiles import LogTailRecord

PageItemT = TypeVar("PageItemT")


class DocumentedParent(msgspec.Struct):
    """The parent's docstring."""

    value: int


class UndocumentedChild(DocumentedParent):
    extra: int


class NestedStruct(msgspec.Struct):
    """The nested struct's docstring."""

    value: int


class NestingStruct(msgspec.Struct):
    """The outer struct's docstring."""

    nested: NestedStruct


class GenericPage(msgspec.Struct, Generic[PageItemT]):
    """The generic page's docstring."""

    items: list[PageItemT]


class DocumentedRecord(TypedDict):
    """The TypedDict's docstring."""

    value: int


@get("/child")
async def child_handler() -> UndocumentedChild:
    return UndocumentedChild(value=1, extra=2)


@get("/nesting")
async def nesting_handler() -> NestingStruct:
    return NestingStruct(nested=NestedStruct(value=1))


@get("/page")
async def page_handler() -> GenericPage[int]:
    return GenericPage(items=[1])


@get("/record")
async def record_handler() -> DocumentedRecord:
    return {"value": 1}


@pytest.fixture
def plugin_components() -> dict[str, Any]:
    app = Litestar(
        route_handlers=[child_handler, nesting_handler, page_handler, record_handler],
        plugins=DOCSTRING_SCHEMA_PLUGINS,
        openapi_config=OpenAPIConfig(title="plugin test", version="1"),
    )
    return app.openapi_schema.to_schema()["components"]["schemas"]


def _component_named(components: dict[str, Any], prefix: str) -> dict[str, Any]:
    (component,) = [schema for name, schema in components.items() if name.startswith(prefix)]
    return component


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


def test_struct_without_a_docstring_does_not_inherit_its_parents(plugin_components: dict[str, Any]):
    assert "description" not in plugin_components["UndocumentedChild"]


def test_nested_struct_gets_its_docstring(plugin_components: dict[str, Any]):
    assert plugin_components["NestedStruct"]["description"] == "The nested struct's docstring."
    assert plugin_components["NestingStruct"]["description"] == "The outer struct's docstring."


def test_generic_struct_gets_its_docstring(plugin_components: dict[str, Any]):
    assert _component_named(plugin_components, "GenericPage")["description"] == "The generic page's docstring."


def test_typed_dict_gets_its_docstring(plugin_components: dict[str, Any]):
    assert plugin_components["DocumentedRecord"]["description"] == "The TypedDict's docstring."


def test_existing_description_is_kept():
    schema = Schema(description="Set elsewhere.")
    _describe(schema, FieldDefinition.from_annotation(DocumentedParent))
    assert schema.description == "Set elsewhere."


def test_field_description_does_not_replace_the_struct_docstring(openapi_document: dict[str, Any]):
    description = openapi_document["components"]["schemas"]["DefaultMapView"]["description"]
    assert description == own_docstring(DefaultMapView)


@pytest.mark.parametrize(
    ("path", "method"),
    [("/api/v1/auth/login", "post"), ("/api/v1/auth/options", "get"), ("/health", "get"), ("/health/ready", "get")],
)
def test_operations_without_auth_advertise_no_credentials(
    openapi_document: dict[str, Any], path: str, method: str
):
    assert openapi_document["paths"][path][method]["security"] == [{}]


@pytest.mark.parametrize("route_handler", [AuthController.oidc_start, AuthController.oidc_callback])
def test_hidden_oidc_routes_declare_no_credentials(route_handler: Any):
    assert route_handler.security == NO_CREDENTIALS_SECURITY


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
