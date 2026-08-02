"""Read-only introspection of the Settings tree for the system settings API.

Redaction is type-enforced: any field typed SecretStr is reported with a
placeholder (or None when unset) and its value can never serialize. New
secrets must be typed SecretStr, which also protects reprs and logs.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

import msgspec
from typing import Any, get_args

from pydantic import SecretStr
from pydantic.fields import FieldInfo
from pydantic_core import PydanticUndefined, to_jsonable_python
from pydantic_settings import BaseSettings

from geometrikks.config.settings import Settings

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
    "api": "API",
    "geoip": "GeoIP",
    "logparser": "Log Parser",
}


class SettingFieldView(msgspec.Struct, rename="camel"):
    key: str
    value: Any
    default: Any
    description: str | None
    env_var: str | None
    is_secret: bool
    computed_value: Any = None
    computed_source: str | None = None


class SettingsSectionView(msgspec.Struct, rename="camel"):
    name: str
    title: str
    description: str | None
    fields: list[SettingFieldView]


class SystemSettingsResponse(msgspec.Struct, rename="camel"):
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


def _section(
    name: str,
    model: BaseSettings,
    computed: Mapping[str, ComputedField] | None = None,
) -> SettingsSectionView:
    overlay = computed or {}
    dumped = model.model_dump(mode="json")
    fields: list[SettingFieldView] = []
    real_keys: set[str] = set()
    for field_name, info in type(model).model_fields.items():
        if isinstance(getattr(model, field_name), BaseSettings):
            continue  # sub-configurations become their own sections
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
    doc = (type(model).__doc__ or "").strip().splitlines()
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

    sections = [_section("app", settings, _for("app"))]
    for field_name in Settings.model_fields:
        value = getattr(settings, field_name)
        if isinstance(value, BaseSettings):
            sections.append(_section(field_name, value, _for(field_name)))
    return SystemSettingsResponse(sections=sections)
