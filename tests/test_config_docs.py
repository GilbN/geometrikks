"""docs/configuration.md must match the settings classes (generated file)."""
import importlib.util
import re
import subprocess
import sys
from pathlib import Path

from geometrikks.config import settings as settings_module

_spec = importlib.util.spec_from_file_location("generate_config_docs", Path("scripts/generate_config_docs.py"))
assert _spec is not None and _spec.loader is not None
gen = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gen)


def _doc_groups() -> tuple[str, str, str]:
    text = Path("docs/configuration.md").read_text(encoding="utf-8")
    regular, rest = text.split("## Advanced tuning", 1)
    advanced, developer = rest.split("## Developer settings", 1)
    return regular, advanced, developer


def test_configuration_docs_are_fresh():
    result = subprocess.run(
        [sys.executable, "scripts/generate_config_docs.py", "--check"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr


def test_developer_settings_are_listed_only_in_their_own_section():
    regular, advanced, developer = _doc_groups()
    for env_var in ("APP_DEBUG", "DB_DROP_ON_STARTUP", "LOGPARSER_SKIP_VALIDATION", "VITE_DEV_MODE"):
        assert f"`{env_var}`" in developer
        assert f"`{env_var}`" not in regular + advanced


def test_advanced_settings_are_listed_only_in_their_own_section():
    regular, advanced, developer = _doc_groups()
    for env_var in ("DB_POOL_SIZE", "LOGPARSER_BATCH_SIZE", "LOG_MAIN_MAX_BYTES", "SCHEDULER_ENABLED"):
        assert f"`{env_var}`" in advanced
        assert f"`{env_var}`" not in regular + developer
    assert "`DB_PASSWORD`" in regular


def test_every_documented_variable_has_one_row():
    text = Path("docs/configuration.md").read_text(encoding="utf-8")
    documented = re.findall(r"^\| `([A-Z0-9_]+)` \|", text, flags=re.M)
    assert len(documented) == len(set(documented))


def test_no_field_is_both_advanced_and_developer():
    from pydantic_settings import BaseSettings

    for settings_class in vars(settings_module).values():
        if not (isinstance(settings_class, type) and issubclass(settings_class, BaseSettings)):
            continue
        for field_name, field in settings_class.model_fields.items():
            extra = field.json_schema_extra
            assert not (
                settings_module.is_advanced_field(extra) and settings_module.is_developer_field(extra)
            ), f"{settings_class.__name__}.{field_name}"


def test_escape_mdx_escapes_braces_and_angle_brackets_outside_code():
    assert gen.escape_mdx('e.g. {job="traefik"} and `{x}` <b>') == 'e.g. \\{job="traefik"\\} and `{x}` \\<b>'


def test_site_reference_has_frontmatter_and_no_html_comment():
    text = gen.SITE_OUTPUT.read_text(encoding="utf-8")
    assert text.startswith("---\ntitle: Configuration\n")
    assert "<!--" not in text and "# Configuration Reference" not in text
    assert '\\{job="traefik"\\}' in text


def test_site_reference_lists_the_same_variables_as_docs():
    pattern = r"^\| `([A-Z0-9_]+)` \|"
    docs = re.findall(pattern, Path("docs/configuration.md").read_text(encoding="utf-8"), flags=re.M)
    site = re.findall(pattern, gen.SITE_OUTPUT.read_text(encoding="utf-8"), flags=re.M)
    assert docs == site


def test_escape_mdx_keeps_a_code_span_after_an_empty_one():
    assert gen.escape_mdx("| `FOO` | `` | use `{x}` here |") == "| `FOO` | `` | use `{x}` here |"


def test_container_variables_are_listed():
    text = Path("docs/configuration.md").read_text(encoding="utf-8")
    for name in ("PUID", "PGID", "ACCESS_LOG_DIR", "POSTGRES_PASSWORD", "WEB_CONCURRENCY", "LITESTAR_APP"):
        assert f"| `{name}` |" in text


def test_container_variables_exist_in_their_sources():
    granian = importlib.util.find_spec("litestar_granian")
    assert granian is not None and granian.submodule_search_locations
    sources = [
        Path("docker-compose.yml"),
        Path("docker/entrypoint.sh"),
        Path("Dockerfile"),
        Path(".env.example"),
        Path(granian.submodule_search_locations[0]) / "cli.py",
    ]
    text = "\n".join(source.read_text(encoding="utf-8") for source in sources)
    missing = [name for name, _, _ in gen.CONTAINER_VARIABLES if not re.search(rf"\b{name}\b", text)]
    assert not missing, missing


def test_instance_section_heading():
    text = Path("docs/configuration.md").read_text(encoding="utf-8")
    assert "### Application mode" not in text and "### Instance and notices" in text


def test_oidc_section_names_its_startup_failures():
    section = Path("docs/configuration.md").read_text(encoding="utf-8").split("### OpenID Connect", 1)[1]
    note = section.split("| Variable |", 1)[0]
    for needle in ("/api/v1/auth/oidc/callback", "APP_SESSION_SECURE", "APP_AUTH_DISABLED", "openid"):
        assert needle in note


def test_defaults_are_readable():
    text = Path("docs/configuration.md").read_text(encoding="utf-8")
    assert "*(computed)*" not in text and "| `` |" not in text
    assert re.search(r"^\| `LOKI_QUERIES` \| \*\(empty\)\* \|", text, flags=re.M)
    assert re.search(r"^\| `LOGPARSER_LOG_PATHS` \| `/var/log/access/access.log` \|", text, flags=re.M)
    assert "| `LOGPARSER_SERVER_NAME` | *(the machine's hostname)* |" in text


def test_trusted_proxies_description_names_api_keys():
    field = settings_module.Settings.model_fields["trusted_proxies"]
    assert "API key" in (field.description or "")


def test_names_in_container_rows_and_notes_exist():
    rows = set(re.findall(r"^\| `([A-Z0-9_]+)` \|", gen.build(), flags=re.M))
    container = {name for name, _, _ in gen.CONTAINER_VARIABLES}
    texts = [desc for _, _, desc in gen.CONTAINER_VARIABLES]
    texts += [line for lines in gen.SECTION_NOTES.values() for line in lines]
    unknown = {tok for text in texts for tok in re.findall(r"[A-Z][A-Z0-9]*_[A-Z0-9_]+", text)} - rows - container
    assert not unknown, sorted(unknown)


def test_list_defaults_stay_json_where_env_needs_json():
    text = Path("docs/configuration.md").read_text(encoding="utf-8")
    assert '| `GEOIP_LOCALES` | `["en"]` |' in text


def test_site_links_keep_only_the_label_until_the_page_exists(tmp_path, monkeypatch):
    page = tmp_path / "reference" / "configuration.mdx"
    page.parent.mkdir()
    monkeypatch.setattr(gen, "SITE_OUTPUT", page)
    assert gen.site_links("See [Deployment](deployment.md).") == "See Deployment."
    (tmp_path / "operate").mkdir()
    (tmp_path / "operate" / "deployment.mdx").write_text("", encoding="utf-8")
    assert gen.site_links("See [Deployment](deployment.md).") == "See [Deployment](../operate/deployment.mdx)."
