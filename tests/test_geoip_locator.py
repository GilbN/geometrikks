"""GeoLite2 City lookups for IPs without stored traffic."""
from __future__ import annotations

from structlog.testing import capture_logs

from geometrikks.services.geoip.locator import GeoIpLocator, GeoIpPlace

TEST_CITY_DB = "tests/GeoLite2-City-Test.mmdb"


def test_locate_returns_country_and_city_per_ip():
    places = GeoIpLocator(TEST_CITY_DB, ["en"]).locate(["81.2.69.142", "2001:218::1"])
    assert places == {
        "81.2.69.142": GeoIpPlace(country_code="GB", country_name="United Kingdom", city="London"),
        "2001:218::1": GeoIpPlace(country_code="JP", country_name="Japan", city=None),
    }


def test_locate_uses_the_configured_locale():
    places = GeoIpLocator(TEST_CITY_DB, ["de"]).locate(["81.2.69.142"])
    assert places["81.2.69.142"].country_name == "Vereinigtes Königreich"


def test_locate_skips_unknown_addresses_and_non_ips():
    assert GeoIpLocator(TEST_CITY_DB, ["en"]).locate(["10.0.0.1", "not-an-ip"]) == {}


def test_locate_with_a_missing_database_logs_and_returns_nothing(tmp_path):
    missing = tmp_path / "GeoLite2-City.mmdb"
    with capture_logs() as logs:
        assert GeoIpLocator(missing, ["en"]).locate(["81.2.69.142"]) == {}
    assert [log["event"] for log in logs] == ["geoip_locate_failed"]
