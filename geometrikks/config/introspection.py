"""Read-only introspection of the Settings tree for the system settings API.

Redaction is type-enforced: any field typed SecretStr is reported with a
placeholder (or None when unset) and its value can never serialize. New
secrets must be typed SecretStr, which also protects reprs and logs.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, get_args

from pydantic import SecretStr
from pydantic.fields import FieldInfo
from pydantic_core import PydanticUndefined, to_jsonable_python
from pydantic_settings import BaseSettings

from geometrikks.config.settings import Settings

SECRET_PLACEHOLDER = "******"

# Display titles that plain str.title() gets wrong.
_SECTION_TITLES = {
    "app": "Application",
    "api": "API",
    "geoip": "GeoIP",
    "logparser": "Log Parser",
}


@dataclass
class SettingFieldView:
    key: str
    value: Any
    default: Any
    description: str | None
    env_var: str
    is_secret: bool


@dataclass
class SettingsSectionView:
    name: str
    title: str
    description: str | None
    fields: list[SettingFieldView]


@dataclass
class SystemSettingsResponse:
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


def _section(name: str, model: BaseSettings) -> SettingsSectionView:
    dumped = model.model_dump(mode="json")
    fields: list[SettingFieldView] = []
    for field_name, info in type(model).model_fields.items():
        if isinstance(getattr(model, field_name), BaseSettings):
            continue  # sub-configurations become their own sections
        secret = _is_secret(info.annotation)
        value = dumped.get(field_name)
        if secret:
            value = None if getattr(model, field_name) is None else SECRET_PLACEHOLDER
        fields.append(
            SettingFieldView(
                key=field_name,
                value=value,
                default=_default_value(info, secret),
                description=info.description,
                env_var=_env_var(model, field_name, info),
                is_secret=secret,
            )
        )
    doc = (type(model).__doc__ or "").strip().splitlines()
    return SettingsSectionView(
        name=name,
        title=_SECTION_TITLES.get(name, name.replace("_", " ").title()),
        description=doc[0] if doc else None,
        fields=fields,
    )


def build_settings_overview(settings: Settings) -> SystemSettingsResponse:
    """Flatten the Settings tree into redacted, described sections."""
    sections = [_section("app", settings)]
    for field_name in Settings.model_fields:
        value = getattr(settings, field_name)
        if isinstance(value, BaseSettings):
            sections.append(_section(field_name, value))
    return SystemSettingsResponse(sections=sections)
