"""Read-only introspection of the Settings tree for the system settings API.

Redaction is type-enforced: any field typed SecretStr is reported with a
placeholder (or None when unset) and its value can never serialize. New
secrets must be typed SecretStr, which also protects reprs and logs.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

import msgspec
from typing import Annotated, Any, get_args

from pydantic import SecretStr
from pydantic.fields import FieldInfo
from pydantic_core import PydanticUndefined, to_jsonable_python
from pydantic_settings import BaseSettings

from geometrikks.config.settings import Settings, is_legacy_field

SECRET_PLACEHOLDER = "******"


@dataclass
class ComputedField:
    """A runtime-resolved value overlaid onto the static settings view.

    Attaches to an existing field by key, or becomes a synthetic derived row
    when the key has no backing model field.
    """

    value: Any
    source: str
    description: str | None = None


# Display titles that plain str.title() gets wrong.
_SECTION_TITLES = {
    "app": "Application",
    "geoip": "GeoIP",
    "logparser": "Log Parser",
    "oidc": "OpenID Connect",
}


class SettingFieldView(msgspec.Struct, rename="camel"):
    """One setting, or a value worked out at runtime that has no setting of its own."""

    key: Annotated[str, msgspec.Meta(description="The setting's name inside its section, such as `raw_retention_days`.")]
    value: Annotated[
        Any,
        msgspec.Meta(description=f"The current value. A secret shows as `{SECRET_PLACEHOLDER}` when set and null when not."),
    ]
    default: Annotated[
        Any, msgspec.Meta(description="The default value. Null when the setting has no fixed default.")
    ]
    description: str | None
    env_var: Annotated[
        str | None,
        msgspec.Meta(description="The environment variable that sets it. Null for a value worked out at runtime."),
    ]
    is_secret: bool
    computed_value: Annotated[
        Any, msgspec.Meta(description="The value in effect when GeoMetrikks worked it out at runtime, else null.")
    ] = None
    computed_source: Annotated[
        str | None,
        msgspec.Meta(description="Where `computedValue` came from, `runtime` or `external_ip`."),
    ] = None


class SettingsSectionView(msgspec.Struct, rename="camel"):
    """A group of settings that share an environment variable prefix."""

    name: Annotated[str, msgspec.Meta(description="The section key, such as `geoip` or `crowdsec`.")]
    title: str
    description: str | None
    fields: list[SettingFieldView]


class SystemSettingsResponse(msgspec.Struct, rename="camel"):
    """Every setting, grouped into sections, with secrets hidden."""

    sections: list[SettingsSectionView]


def _is_secret(annotation: Any) -> bool:
    return annotation is SecretStr or SecretStr in get_args(annotation)


def _env_var(model: BaseSettings, field_name: str, info: FieldInfo) -> str:
    if isinstance(info.validation_alias, str):
        return info.validation_alias
    prefix = model.model_config.get("env_prefix") or ""
    return f"{prefix}{field_name}".upper()


def _default_value(info: FieldInfo, secret: bool) -> Any:
    if info.default is PydanticUndefined:
        return None  # default_factory: dynamic, not representable
    if secret:
        return None if info.default is None else SECRET_PLACEHOLDER
    return to_jsonable_python(info.default, fallback=str)


def _model_fields(
    model: BaseSettings,
    overlay: Mapping[str, ComputedField],
    real_keys: set[str],
) -> list[SettingFieldView]:
    dumped = model.model_dump(mode="json")
    fields: list[SettingFieldView] = []
    for field_name, info in type(model).model_fields.items():
        if isinstance(getattr(model, field_name), BaseSettings):
            continue  # sub-configurations become their own sections
        if is_legacy_field(info.json_schema_extra):
            continue
        real_keys.add(field_name)
        secret = _is_secret(info.annotation)
        value = dumped.get(field_name)
        if secret:
            # Empty secrets count as unset: auth and the GeoIP credential
            # check treat SecretStr("") as absent, so the overview must too.
            raw = getattr(model, field_name)
            value = SECRET_PLACEHOLDER if raw is not None and raw.get_secret_value() else None
        override = overlay.get(field_name)
        fields.append(
            SettingFieldView(
                key=field_name,
                value=value,
                default=_default_value(info, secret),
                description=info.description,
                env_var=_env_var(model, field_name, info),
                is_secret=secret,
                computed_value=override.value if override else None,
                computed_source=override.source if override else None,
            )
        )
    return fields


def _section(
    name: str,
    models: Sequence[BaseSettings],
    computed: Mapping[str, ComputedField] | None = None,
) -> SettingsSectionView:
    overlay = computed or {}
    fields: list[SettingFieldView] = []
    real_keys: set[str] = set()
    for model in models:
        fields.extend(_model_fields(model, overlay, real_keys))
    for key, cf in overlay.items():
        if key in real_keys:
            continue  # derived value with no backing field: synthesize a row
        fields.append(
            SettingFieldView(
                key=key,
                value=None,
                default=None,
                description=cf.description,
                env_var=None,
                is_secret=False,
                computed_value=cf.value,
                computed_source=cf.source,
            )
        )
    doc = (type(models[0]).__doc__ or "").strip().splitlines()
    return SettingsSectionView(
        name=name,
        title=_SECTION_TITLES.get(name, name.replace("_", " ").title()),
        description=doc[0] if doc else None,
        fields=fields,
    )


def build_settings_overview(
    settings: Settings,
    *,
    computed: Mapping[tuple[str, str], ComputedField] | None = None,
) -> SystemSettingsResponse:
    """Flatten the Settings tree into redacted, described sections.

    ``computed`` overlays runtime-resolved values keyed by ``(section, field)``:
    matching keys attach to their field, unmatched keys become derived rows.
    """
    overlay = computed or {}

    def _for(section_name: str) -> dict[str, ComputedField]:
        return {key: cf for (sec, key), cf in overlay.items() if sec == section_name}

    # The root fields and AppSettings both read APP_* variables, so they form
    # one section.
    sections = [_section("app", [settings, settings.app], _for("app"))]
    for field_name in Settings.model_fields:
        value = getattr(settings, field_name)
        if field_name != "app" and isinstance(value, BaseSettings):
            sections.append(_section(field_name, [value], _for(field_name)))
    return SystemSettingsResponse(sections=sections)
