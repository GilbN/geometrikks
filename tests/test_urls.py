"""URL trust checks shared by settings validation and the OIDC client."""
from __future__ import annotations

import pytest

from geometrikks.lib.urls import is_loopback_host, validate_https_url


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "127.8.8.8", "::1"])
def test_loopback_hosts(host):
    assert is_loopback_host(host) is True


@pytest.mark.parametrize("host", [None, "", "idp.example.com", "10.0.0.5", "192.168.1.20"])
def test_non_loopback_hosts(host):
    assert is_loopback_host(host) is False


def test_https_url_passes_and_returns_parts():
    parts = validate_https_url("https://auth.example.com/realms/home", name="OIDC_ISSUER")
    assert parts.hostname == "auth.example.com"
    assert parts.path == "/realms/home"


def test_http_is_allowed_only_on_loopback():
    validate_https_url("http://localhost:8000/x", name="X")
    validate_https_url("http://[::1]:8000/x", name="X")
    with pytest.raises(ValueError, match="X must use https"):
        validate_https_url("http://auth.example.com", name="X")


@pytest.mark.parametrize(
    "value",
    ["auth.example.com", "ftp://auth.example.com", "https://", "https://user:pw@auth.example.com",
     "https://auth.example.com/?x=1", "https://auth.example.com/#frag"],
)
def test_rejects_non_absolute_credentialed_or_decorated_urls(value):
    with pytest.raises(ValueError, match="X "):
        validate_https_url(value, name="X")
