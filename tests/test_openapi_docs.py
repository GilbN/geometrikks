"""The /schema reference carries the API intro, tag descriptions and model docstrings."""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any, Generic, TypedDict, TypeVar

import msgspec
import pytest
from advanced_alchemy.service import OffsetPagination
from litestar import Litestar, get
from litestar._openapi.schema_generation.plugins import StructSchemaPlugin
from litestar.dto._backend import DTOBackend
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

HTTP_METHODS = frozenset({"get", "put", "post", "delete", "options", "head", "patch", "trace"})


def test_synthesized_validation_responses_document_error_codes(openapi_document: dict[str, Any]):
    found = 0
    for path, item in openapi_document["paths"].items():
        if not path.startswith("/api/"):
            continue
        for method, operation in item.items():
            if method not in HTTP_METHODS:
                continue
            response = operation.get("responses", {}).get("400", {})
            schema = response.get("content", {}).get("application/json", {}).get("schema", {})
            if schema.get("description") == "Validation Exception":
                found += 1
                assert "code" in schema["required"], (method, path)
                assert schema["properties"]["code"]["type"] == "string"
                assert schema["examples"][0]["code"] == "validation_failed"
    assert found > 0
# Litestar falls back to the handler name, one word with no spaces; a written summary always has one.
GENERATED_SUMMARY = re.compile(r"\S+")

# advanced_alchemy's create_service_dependencies builds these search parameters and takes no
# descriptions, so each endpoint's description explains them instead.
UNDESCRIBABLE_PARAMETERS = frozenset(
    {
        ("get", "/api/v1/access-log-debug", "searchString"),
        ("get", "/api/v1/access-log-debug", "searchIgnoreCase"),
        ("get", "/api/v1/access-logs", "searchString"),
        ("get", "/api/v1/access-logs", "searchIgnoreCase"),
    }
)

# SQLAlchemyDTO transfer models have no docstring to carry into the schema.
UNDESCRIBABLE_COMPONENTS = frozenset(
    {
        "ListAccessLogsAccessLogResponseBody",
        "ListGeoEventsGeoEventGeoLocationResponseBody",
        "ListGeoEventsGeoEventResponseBody",
        "ListGeoLocationsGeoLocationResponseBody",
    }
)


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


@dataclass
class UndocumentedDataclass:
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


@get("/undocumented-dataclass")
async def undocumented_dataclass_handler() -> UndocumentedDataclass:
    return UndocumentedDataclass(value=1)


@get("/offset-page")
async def offset_page_handler() -> OffsetPagination[NestedStruct]:
    return OffsetPagination(items=[NestedStruct(value=1)], limit=1, offset=0, total=1)


@get("/explicit")
async def explicit_handler() -> ExplicitlyDescribedStruct:
    return ExplicitlyDescribedStruct(value=1)


@pytest.fixture
def plugin_document() -> dict[str, Any]:
    app = Litestar(
        route_handlers=[
            child_handler,
            nesting_handler,
            page_handler,
            record_handler,
            dataclass_handler,
            undocumented_dataclass_handler,
            offset_page_handler,
        ],
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
    # Litestar remembers every DTO model name per process and qualifies repeats, so a fresh
    # registry gives each build the names the running app and /schema use.
    monkeypatch.setattr(DTOBackend, "_seen_model_names", set())
    from geometrikks.server.core import create_app

    return create_app().openapi_schema.to_schema()


def _operations(document: dict[str, Any]) -> Iterator[tuple[str, str, dict[str, Any]]]:
    for path, path_item in document["paths"].items():
        for method, operation in path_item.items():
            if method in HTTP_METHODS:
                yield method, path, operation


def _parameters(document: dict[str, Any]) -> Iterator[tuple[str, str, dict[str, Any]]]:
    for method, path, operation in _operations(document):
        path_level_parameters = document["paths"][path].get("parameters", [])
        for parameter in [*path_level_parameters, *operation.get("parameters", [])]:
            if parameter["in"] in {"query", "path"}:
                yield method, path, parameter


def test_every_operation_has_a_written_summary(openapi_document: dict[str, Any]):
    bad_summaries = [
        (method, path, operation.get("summary"))
        for method, path, operation in _operations(openapi_document)
        if not (operation.get("summary") or "").strip()
        or GENERATED_SUMMARY.fullmatch(operation["summary"].strip())
        or operation["summary"].strip().endswith(".")
    ]
    assert bad_summaries == []


def test_every_operation_has_a_description(openapi_document: dict[str, Any]):
    undescribed = [
        (method, path)
        for method, path, operation in _operations(openapi_document)
        if not operation.get("description", "").strip()
    ]
    assert undescribed == []


def test_every_query_and_path_parameter_has_a_description(openapi_document: dict[str, Any]):
    undescribed = [
        (method, path, parameter["name"])
        for method, path, parameter in _parameters(openapi_document)
        if not parameter.get("description", "").strip()
        and (method, path, parameter["name"]) not in UNDESCRIBABLE_PARAMETERS
    ]
    assert undescribed == []


def test_undescribable_parameters_are_still_in_the_schema(openapi_document: dict[str, Any]):
    present = {(method, path, parameter["name"]) for method, path, parameter in _parameters(openapi_document)}
    assert UNDESCRIBABLE_PARAMETERS - present == set()


def test_undescribable_parameters_still_lack_a_description(openapi_document: dict[str, Any]):
    described = {
        (method, path, parameter["name"])
        for method, path, parameter in _parameters(openapi_document)
        if parameter.get("description", "").strip()
    }
    assert UNDESCRIBABLE_PARAMETERS & described == set()


def test_every_component_schema_has_a_description(openapi_document: dict[str, Any]):
    undescribed = [
        name
        for name, schema in openapi_document["components"]["schemas"].items()
        if not schema.get("description", "").strip() and name not in UNDESCRIBABLE_COMPONENTS
    ]
    assert undescribed == []


def test_undescribable_components_are_still_in_the_schema(openapi_document: dict[str, Any]):
    assert UNDESCRIBABLE_COMPONENTS - set(openapi_document["components"]["schemas"]) == set()


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


def test_dataclass_without_a_docstring_gets_no_description(plugin_components: dict[str, Any]):
    assert (UndocumentedDataclass.__doc__ or "").startswith("UndocumentedDataclass(value")
    assert "description" not in plugin_components["UndocumentedDataclass"]


def test_offset_page_stays_inline_with_a_user_facing_description(plugin_document: dict[str, Any]):
    response = plugin_document["paths"]["/offset-page"]["get"]["responses"]["200"]
    schema = response["content"]["application/json"]["schema"]
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


@pytest.mark.parametrize(
    ("method", "path", "status"),
    [
        ("post", "/api/v1/auth/login", "401"),
        ("post", "/api/v1/auth/login", "503"),
        ("get", "/api/v1/auth/me", "401"),
        ("get", "/api/v1/auth/me", "403"),
        ("post", "/api/v1/auth/logout", "403"),
        ("get", "/api/v1/auth/oidc/status", "403"),
        ("get", "/api/v1/auth/api-keys", "403"),
        ("post", "/api/v1/auth/api-keys", "403"),
        ("delete", "/api/v1/auth/api-keys/{key_id}", "403"),
    ],
)
def test_auth_routes_declare_the_errors_their_descriptions_name(
    openapi_document: dict[str, Any], method: str, path: str, status: str
):
    response = openapi_document["paths"][path][method]["responses"][status]
    assert response["description"].strip()
    assert response["content"]["application/json"]["schema"]["$ref"] == "#/components/schemas/ErrorEnvelope"


@pytest.mark.parametrize("route_handler", [AuthController.oidc_start, AuthController.oidc_callback])
def test_hidden_oidc_routes_declare_no_credentials(route_handler: Any):
    assert route_handler.security == NO_CREDENTIALS_SECURITY


def test_struct_without_a_docstring_gets_no_description():
    class Undocumented(msgspec.Struct):
        value: int

    assert own_docstring(Undocumented) is None


@pytest.mark.parametrize(
    "required_text",
    ["Authorization: Bearer gmk_", "**Read**", "**Read/write**", "- **401** ", "- **403** ", "- **503** ", "UTC"],
)
def test_intro_covers_auth_scopes_errors_and_time(openapi_document: dict[str, Any], required_text: str):
    assert required_text in openapi_document["info"]["description"]


def test_every_tag_an_operation_uses_has_a_description(openapi_document: dict[str, Any]):
    described_tags = {tag["name"]: (tag.get("description") or "").strip() for tag in openapi_document["tags"]}
    used_tags = {
        tag_name
        for path_item in openapi_document["paths"].values()
        for operation in path_item.values()
        if isinstance(operation, dict)
        for tag_name in operation.get("tags", [])
    }
    undescribed_tags = sorted(tag_name for tag_name in used_tags if not described_tags.get(tag_name))
    assert undescribed_tags == []


def test_every_operation_has_a_tag(openapi_document: dict[str, Any]):
    untagged = [
        (method, path) for method, path, operation in _operations(openapi_document) if not operation.get("tags")
    ]
    assert untagged == []


def test_every_described_tag_is_in_use(openapi_document: dict[str, Any]):
    used_tags = {
        tag_name
        for path_item in openapi_document["paths"].values()
        for operation in path_item.values()
        if isinstance(operation, dict)
        for tag_name in operation.get("tags", [])
    }
    assert {tag.name for tag in API_TAGS} <= used_tags
