"""OpenAPI schema plugins that publish model docstrings as component descriptions.

Litestar copies docstrings into the schema for enums only. These subclasses of
its built-in struct and TypedDict plugins add the model's own
docstring as the component description. The parents live in a private Litestar
module, so tests/test_openapi_docs.py fails if an upgrade moves or changes them.
"""

from __future__ import annotations

import inspect
from typing import TYPE_CHECKING

from litestar._openapi.schema_generation.plugins import StructSchemaPlugin, TypedDictSchemaPlugin

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


class StructDocstringSchemaPlugin(StructSchemaPlugin):
    def to_openapi_schema(self, field_definition: FieldDefinition, schema_creator: SchemaCreator) -> Schema:
        return _describe(super().to_openapi_schema(field_definition, schema_creator), field_definition)


class TypedDictDocstringSchemaPlugin(TypedDictSchemaPlugin):
    def to_openapi_schema(self, field_definition: FieldDefinition, schema_creator: SchemaCreator) -> Schema:
        return _describe(super().to_openapi_schema(field_definition, schema_creator), field_definition)


DOCSTRING_SCHEMA_PLUGINS = [
    StructDocstringSchemaPlugin(),
    TypedDictDocstringSchemaPlugin(),
]
