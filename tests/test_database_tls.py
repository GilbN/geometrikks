"""Startup check for unusable PostgreSQL TLS file paths."""
from __future__ import annotations

import os

import pytest

from geometrikks.server.database_tls import UnusableTlsFile, unusable_tls_files


def test_no_variables_set_reports_nothing():
    assert unusable_tls_files({}) == []


def test_an_empty_value_counts_as_unset():
    assert unusable_tls_files({"PGSSLROOTCERT": ""}) == []


def test_a_readable_file_reports_nothing(tmp_path):
    ca_file = tmp_path / "ca.crt"
    ca_file.write_text("cert")
    assert unusable_tls_files({"PGSSLROOTCERT": str(ca_file)}) == []


def test_a_missing_file_is_reported_with_its_variable(tmp_path):
    missing_path = str(tmp_path / "nope.crt")
    assert unusable_tls_files({"PGSSLCERT": missing_path}) == [
        UnusableTlsFile(variable="PGSSLCERT", path=missing_path, reason="missing")
    ]


def test_a_directory_is_reported_as_missing(tmp_path):
    assert unusable_tls_files({"PGSSLROOTCERT": str(tmp_path)})[0].reason == "missing"


@pytest.mark.skipif(os.geteuid() == 0, reason="root can read any file")
def test_an_unreadable_file_is_reported_as_not_readable(tmp_path):
    key_file = tmp_path / "client.key"
    key_file.write_text("key")
    key_file.chmod(0o000)
    assert unusable_tls_files({"PGSSLKEY": str(key_file)})[0].reason == "not readable"


def test_files_are_reported_in_a_fixed_order(tmp_path):
    environ = {
        "PGSSLKEY": str(tmp_path / "client.key"),
        "PGSSLCERT": str(tmp_path / "client.crt"),
        "PGSSLROOTCERT": str(tmp_path / "ca.crt"),
    }
    assert [tls_file.variable for tls_file in unusable_tls_files(environ)] == [
        "PGSSLROOTCERT",
        "PGSSLCERT",
        "PGSSLKEY",
    ]
