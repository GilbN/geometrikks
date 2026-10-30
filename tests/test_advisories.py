"""Advisory registry: upsert by id, clear, critical-first ordering."""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any, cast

from geometrikks.config.settings import LegacyEnvName
from geometrikks.lib.advisories import (
    Advisory,
    AdvisoryRegistry,
    error_headline,
    last_write_error_sentence,
    legacy_env_advisory,
)
from geometrikks.server import runtime


def _adv(id_: str, severity: str = "warning") -> Advisory:
    return Advisory(id=id_, severity=cast("Any", severity), summary=f"{id_} summary")


def test_set_then_snapshot_returns_the_advisory() -> None:
    reg = AdvisoryRegistry()
    reg.set(_adv("a"))
    assert [a.id for a in reg.snapshot()] == ["a"]


def test_set_same_id_replaces_without_duplicating() -> None:
    reg = AdvisoryRegistry()
    reg.set(_adv("a"))
    reg.set(Advisory(id="a", severity="warning", summary="updated"))
    snap = reg.snapshot()
    assert len(snap) == 1 and snap[0].summary == "updated"


def test_clear_returns_whether_it_was_set() -> None:
    reg = AdvisoryRegistry()
    reg.set(_adv("a"))
    assert reg.clear("a") is True
    assert reg.clear("a") is False
    assert reg.snapshot() == []


def test_snapshot_orders_critical_first_then_insertion() -> None:
    reg = AdvisoryRegistry()
    reg.set(_adv("w1"))
    reg.set(_adv("c1", "critical"))
    reg.set(_adv("w2"))
    assert [a.id for a in reg.snapshot()] == ["c1", "w1", "w2"]


def test_runtime_accessor_creates_one_registry_per_app() -> None:
    app = SimpleNamespace(state=SimpleNamespace())
    first = runtime.get_advisories(cast("Any", app))
    first.set(_adv("a"))
    assert runtime.get_advisories(cast("Any", app)) is first
    assert [a.id for a in runtime.get_advisories(cast("Any", app)).snapshot()] == ["a"]


def test_legacy_env_advisory_puts_one_rename_per_line() -> None:
    advisory = legacy_env_advisory([
        LegacyEnvName(old="LOGPARSER_HOST_NAME", new="LOGPARSER_SERVER_NAME"),
        LegacyEnvName(old="MAP_HOME_LATITUDE", new="MAP_SERVER_LATITUDE"),
    ])

    assert advisory.remedy is not None
    assert advisory.remedy.splitlines() == [
        "LOGPARSER_HOST_NAME → LOGPARSER_SERVER_NAME",
        "MAP_HOME_LATITUDE → MAP_SERVER_LATITUDE",
    ]


def test_last_write_error_sentence_leads_with_the_database_message() -> None:
    message = (
        "(sqlalchemy.dialects.postgresql.asyncpg.IntegrityError) "
        "<class 'asyncpg.exceptions.NotNullViolationError'>: null value in column "
        '"country_code" violates not-null constraint\n[SQL: INSERT INTO geo_events ...]'
    )
    assert last_write_error_sentence(message) == (
        'The last error was: null value in column "country_code" violates not-null constraint.'
    )


def test_last_write_error_sentence_keeps_a_final_period() -> None:
    assert last_write_error_sentence("disk full.") == "The last error was: disk full."


def test_last_write_error_sentence_is_none_without_a_message() -> None:
    assert (last_write_error_sentence(None), last_write_error_sentence("  ")) == (None, None)


def test_error_headline_cuts_a_bound_argument_value() -> None:
    message = (
        "(sqlalchemy.dialects.postgresql.asyncpg.Error) <class 'asyncpg.exceptions.DataError'>: "
        "invalid input for query argument $4: '/login?token=s3cr3t' (expected str, got int)\n"
        "[SQL: INSERT INTO access_logs ...]"
    )
    assert error_headline(message) == "invalid input for query argument $4"


def test_error_headline_hides_quoted_literals_and_keeps_names() -> None:
    message = "value 's3cr3t' too long for column \"url\" of relation \"access_logs\""
    assert error_headline(message) == "value '…' too long for column \"url\" of relation \"access_logs\""


def test_error_headline_hides_an_unclosed_quoted_literal() -> None:
    assert error_headline("bad value 'user:s3cr3t") == "bad value '…'"


def test_error_headline_hides_rejected_input_after_a_colon() -> None:
    message = 'invalid input syntax for type inet: "10.0.0.5 s3cr3t"'
    assert error_headline(message) == 'invalid input syntax for type inet: "…"'


def test_error_headline_strips_repeated_exception_prefixes() -> None:
    message = (
        "(sqlalchemy.exc.DBAPIError) (sqlalchemy.dialects.postgresql.asyncpg.Error) "
        "<class 'asyncpg.exceptions.DiskFullError'>: could not extend file"
    )
    assert error_headline(message) == "could not extend file"


def test_error_headline_keeps_a_message_that_starts_with_a_parenthesis() -> None:
    assert error_headline("(see the server log) connection reset") == "(see the server log) connection reset"
