"""The /schema reference carries the API intro, tag descriptions and model docstrings."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Generic, TypedDict, TypeVar

import msgspec
import pytest
from advanced_alchemy.service import OffsetPagination
from litestar import Litestar, get
from litestar._openapi.schema_generation.plugins import StructSchemaPlugin
from litestar.openapi import OpenAPIConfig
from litestar.openapi.spec import Schema
from litestar.typing import FieldDefinition

from geometrikks.domain.auth.api_key_controllers import ApiKeyView
from geometrikks.domain.auth.controllers import AuthController
from geometrikks.domain.system.controllers.settings import DefaultMapView
from geometrikks.server.api_key_auth import NO_CREDENTIALS_SECURITY
from geometrikks.server.openapi_docs import API_TAGS
from geometrikks.server.openapi_schema_plugins import (
    DOCSTRING_SCHEMA_PLUGINS,
    OFFSET_PAGE_DESCRIPTION,
    StructDocstringSchemaPlugin,
    TypedDictDocstringSchemaPlugin,
    _describe,
    own_docstring,
)
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


@dataclass
class DocumentedDataclass:
    """The dataclass's docstring."""

    value: int


class ExplicitlyDescribedStruct(msgspec.Struct):
    """The docstring that must not replace the explicit description."""

    value: int


class ExplicitDescriptionStructPlugin(StructSchemaPlugin):
    def to_openapi_schema(self, field_definition: FieldDefinition, schema_creator: Any) -> Schema:
        schema = super().to_openapi_schema(field_definition, schema_creator)
        if field_definition.type_ is ExplicitlyDescribedStruct:
            schema.description = "Set explicitly."
        return schema


# The MRO puts the explicit plugin between the docstring plugin and Litestar's,
# so the description is set before the docstring plugin looks at the schema.
class DocstringOverExplicitStructPlugin(StructDocstringSchemaPlugin, ExplicitDescriptionStructPlugin):
    pass


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


@get("/dataclass")
async def dataclass_handler() -> DocumentedDataclass:
    return DocumentedDataclass(value=1)


@get("/offset-page")
async def offset_page_handler() -> OffsetPagination[NestedStruct]:
    return OffsetPagination(items=[NestedStruct(value=1)], limit=1, offset=0, total=1)


@get("/explicit")
async def explicit_handler() -> ExplicitlyDescribedStruct:
    return ExplicitlyDescribedStruct(value=1)


@pytest.fixture
def plugin_document() -> dict[str, Any]:
    app = Litestar(
        route_handlers=[child_handler, nesting_handler, page_handler, record_handler, dataclass_handler, offset_page_handler],
        plugins=DOCSTRING_SCHEMA_PLUGINS,
        openapi_config=OpenAPIConfig(title="plugin test", version="1"),
    )
    return app.openapi_schema.to_schema()


@pytest.fixture
def plugin_components(plugin_document: dict[str, Any]) -> dict[str, Any]:
    return plugin_document["components"]["schemas"]


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


def test_dataclass_gets_its_docstring(plugin_components: dict[str, Any]):
    assert plugin_components["DocumentedDataclass"]["description"] == "The dataclass's docstring."


def test_offset_page_stays_inline_with_a_user_facing_description(plugin_document: dict[str, Any]):
    schema = plugin_document["paths"]["/offset-page"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]
    assert "$ref" not in schema
    assert schema["description"] == OFFSET_PAGE_DESCRIPTION
    assert set(schema["properties"]) == {"items", "limit", "offset", "total"}


def test_paged_app_responses_get_the_page_description(openapi_document: dict[str, Any]):
    response = openapi_document["paths"]["/api/v1/geo-events/logs"]["get"]["responses"]["200"]
    assert response["content"]["application/json"]["schema"]["description"] == OFFSET_PAGE_DESCRIPTION


def test_explicit_component_description_is_not_replaced_by_the_docstring():
    app = Litestar(
        route_handlers=[explicit_handler],
        plugins=[DocstringOverExplicitStructPlugin(), TypedDictDocstringSchemaPlugin()],
        openapi_config=OpenAPIConfig(title="plugin test", version="1"),
    )
    components = app.openapi_schema.to_schema()["components"]["schemas"]
    assert components["ExplicitlyDescribedStruct"]["description"] == "Set explicitly."


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
