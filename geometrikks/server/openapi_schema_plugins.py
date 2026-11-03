"""OpenAPI schema plugins that publish model docstrings as component descriptions.

Litestar copies docstrings into the schema for enums only. These subclasses of
its built-in struct, dataclass, TypedDict and pagination plugins add the model's
own docstring as the description. The parents live in a private Litestar
module, so tests/test_openapi_docs.py fails if an upgrade moves or changes them.
"""

from __future__ import annotations

import inspect
from typing import TYPE_CHECKING

from litestar._openapi.schema_generation.plugins import (
    DataclassSchemaPlugin,
    PaginationSchemaPlugin,
    StructSchemaPlugin,
    TypedDictSchemaPlugin,
)
from litestar.pagination import OffsetPagination

if TYPE_CHECKING:
    from litestar._openapi.schema_generation import SchemaCreator
    from litestar.openapi.spec import Schema
    from litestar.typing import FieldDefinition


def own_docstring(model: type) -> str | None:
    """The docstring written on ``model`` itself, never the one msgspec.Struct carries."""
    docstring = model.__dict__.get("__doc__")
    if not isinstance(docstring, str):
        return None
    return inspect.cleandoc(docstring) or None


def _describe(schema: Schema, field_definition: FieldDefinition) -> Schema:
    if schema.description is None and isinstance(field_definition.type_, type):
        schema.description = own_docstring(field_definition.type_)
    return schema


# OffsetPagination's own docstring is written for Python callers.
OFFSET_PAGE_DESCRIPTION = (
    "One page of results. `total` counts the matches on every page, `limit` is the page size and `offset` is "
    "how many matches come before this page."
)
_PAGINATION_DESCRIPTIONS: dict[type, str] = {OffsetPagination: OFFSET_PAGE_DESCRIPTION}


class StructDocstringSchemaPlugin(StructSchemaPlugin):
    def to_openapi_schema(self, field_definition: FieldDefinition, schema_creator: SchemaCreator) -> Schema:
        return _describe(super().to_openapi_schema(field_definition, schema_creator), field_definition)


class TypedDictDocstringSchemaPlugin(TypedDictSchemaPlugin):
    def to_openapi_schema(self, field_definition: FieldDefinition, schema_creator: SchemaCreator) -> Schema:
        return _describe(super().to_openapi_schema(field_definition, schema_creator), field_definition)


class PaginationDocstringSchemaPlugin(PaginationSchemaPlugin):
    def to_openapi_schema(self, field_definition: FieldDefinition, schema_creator: SchemaCreator) -> Schema:
        schema = super().to_openapi_schema(field_definition, schema_creator)
        if schema.description is None:
            schema.description = _PAGINATION_DESCRIPTIONS.get(field_definition.origin)
        return schema


class DataclassDocstringSchemaPlugin(DataclassSchemaPlugin):
    def to_openapi_schema(self, field_definition: FieldDefinition, schema_creator: SchemaCreator) -> Schema:
        return _describe(super().to_openapi_schema(field_definition, schema_creator), field_definition)


# The first plugin that supports a type wins, and app plugins run before
# Litestar's. The pagination containers are dataclasses too, so pagination has
# to come before the dataclass plugin or the pages would turn into components.
DOCSTRING_SCHEMA_PLUGINS = [
    PaginationDocstringSchemaPlugin(),
    StructDocstringSchemaPlugin(),
    DataclassDocstringSchemaPlugin(),
    TypedDictDocstringSchemaPlugin(),
]
