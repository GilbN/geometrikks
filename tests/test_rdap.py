"""RDAP abuse-contact lookups: bootstrap routing, parsing, caching, errors."""
from __future__ import annotations

from typing import Any

import httpx2
import pytest
from litestar import Litestar
from litestar.di import Provide
from litestar.testing import AsyncTestClient

from geometrikks.domain.exceptions import DomainNotFoundError, DomainValidationError
from geometrikks.domain.reports.controllers import ReportsController
from geometrikks.server.exceptions import EXCEPTION_HANDLERS
from geometrikks.server.routes import create_api_v1_router
from geometrikks.services.rdap import (
    RdapClient,
    RdapUnavailableError,
    bootstrap_base_for_asn,
    bootstrap_base_for_ip,
    parse_rdap,
)
from tests.support import ambient_settings_dependency

pytestmark = pytest.mark.anyio

IPV4_BOOTSTRAP = {
    "services": [
        [["3.0.0.0/8", "136.0.0.0/8"], ["https://rdap.arin.net/registry/", "http://rdap.arin.net/registry/"]],
        [["93.0.0.0/8"], ["https://rdap.db.ripe.net/"]],
        [["93.184.0.0/16"], ["https://rdap.more-specific.test/"]],
    ]
}
ASN_BOOTSTRAP = {"services": [[["1-1876", "393216-399260"], ["https://rdap.arin.net/registry/"]]]}


def vcard(*entries: list[Any]) -> list[Any]:
    return ["vcard", [["version", {}, "text", "4.0"], *entries]]


# ARIN nests the abuse contact inside the registrant organisation.
ARIN_IP = {
    "objectClassName": "ip network",
    "handle": "NET-136-112-0-0-1",
    "name": "GOOGL-46",
    "startAddress": "136.112.0.0",
    "endAddress": "136.127.255.255",
    "cidr0_cidrs": [{"v4prefix": "136.112.0.0", "length": 12}],
    "entities": [{
        "handle": "GOOGL",
        "roles": ["registrant"],
        "entities": [{
            "handle": "GCABU-ARIN",
            "roles": ["abuse"],
            "vcardArray": vcard(["fn", {}, "text", "GC Abuse"], ["email", {}, "text", "abuse@example.com"]),
        }],
    }],
}


def test_ip_bootstrap_prefers_the_longest_prefix():
    assert bootstrap_base_for_ip(IPV4_BOOTSTRAP, "93.184.216.34") == "https://rdap.more-specific.test/"


def test_ip_bootstrap_prefers_https():
    assert bootstrap_base_for_ip(IPV4_BOOTSTRAP, "3.5.140.2") == "https://rdap.arin.net/registry/"


def test_ip_bootstrap_ignores_http_only_registries():
    bootstrap = {"services": [[["3.0.0.0/8"], ["http://rdap.plain.test/"]]]}
    assert bootstrap_base_for_ip(bootstrap, "3.5.140.2") is None


def test_ip_bootstrap_misses_uncovered_space():
    assert bootstrap_base_for_ip(IPV4_BOOTSTRAP, "8.8.8.8") is None


def test_asn_bootstrap_matches_ranges():
    assert bootstrap_base_for_asn(ASN_BOOTSTRAP, 396982) == "https://rdap.arin.net/registry/"
    assert bootstrap_base_for_asn(ASN_BOOTSTRAP, 1877) is None


def test_parse_finds_a_nested_abuse_entity():
    contact = parse_rdap("136.117.69.10", "ip", "https://rdap.arin.net/registry/ip/136.117.69.10", ARIN_IP)
    assert contact.abuse_emails == ["abuse@example.com"]
    assert contact.abuse_name == "GC Abuse"
    assert (contact.name, contact.cidrs, contact.registry) == ("GOOGL-46", ["136.112.0.0/12"], "rdap.arin.net")


def test_parse_falls_back_to_abuse_addresses_in_remarks():
    data = {
        "remarks": [{"description": ["Hosting (ASN 36994)", "abuse@hosting.example.net"]}],
        "entities": [{
            "roles": ["technical"],
            "vcardArray": vcard(["email", {}, "text", "noc@hosting.example.net"]),
        }],
    }
    contact = parse_rdap("41.0.0.1", "ip", "https://rdap.afrinic.net/rdap/ip/41.0.0.1", data)
    assert contact.abuse_emails == ["abuse@hosting.example.net"]


def test_parse_ignores_truncated_addresses():
    data = {"entities": [{"roles": ["abuse"], "vcardArray": vcard(["email", {}, "text", "someone@"])}]}
    assert parse_rdap("200.160.2.3", "ip", "https://rdap.registro.br/ip/200.160.2.3", data).abuse_emails == []


def registry_transport(calls: list[str], *, ip_status: int = 200) -> httpx2.MockTransport:
    def handler(request: httpx2.Request) -> httpx2.Response:
        url = str(request.url)
        calls.append(url)
        if url.endswith("/rdap/ipv4.json"):
            return httpx2.Response(200, json=IPV4_BOOTSTRAP)
        if url.endswith("/rdap/asn.json"):
            return httpx2.Response(200, json=ASN_BOOTSTRAP)
        if url == "https://rdap.arin.net/registry/ip/3.5.140.2":
            # Transferred space answers with a redirect to the new registry.
            return httpx2.Response(302, headers={"Location": "https://rdap.db.ripe.net/ip/3.5.140.2"})
        if url == "https://rdap.db.ripe.net/ip/3.5.140.2":
            return httpx2.Response(ip_status, json=ARIN_IP)
        if url == "https://rdap.arin.net/registry/ip/136.1.1.1":
            return httpx2.Response(302, headers={"Location": "http://10.0.0.5/internal"})
        if url == "https://rdap.arin.net/registry/ip/136.3.3.3":
            return httpx2.Response(302, headers={"Location": "https://10.0.0.5/internal"})
        if url == "https://rdap.arin.net/registry/ip/136.4.4.4":
            return httpx2.Response(200, json={"remarks": ["not an object"]})
        if url == "https://rdap.arin.net/registry/ip/136.2.2.2":
            return httpx2.Response(302, headers={"Location": "https://rdap.arin.net/registry/ip/136.2.2.2"})
        if url == "https://rdap.arin.net/registry/autnum/396982":
            return httpx2.Response(200, json={"name": "EXAMPLE-AS", "entities": ARIN_IP["entities"]})
        return httpx2.Response(404)

    return httpx2.MockTransport(handler)


async def test_lookup_follows_redirects_and_caches():
    calls: list[str] = []
    client = RdapClient(transport=registry_transport(calls))
    first = await client.lookup_ip("3.5.140.2")
    second = await client.lookup_ip("3.5.140.2")
    assert first is second
    assert first.registry == "rdap.db.ripe.net"
    assert calls.count("https://rdap.db.ripe.net/ip/3.5.140.2") == 1


async def test_redirect_to_plain_http_is_refused():
    calls: list[str] = []
    with pytest.raises(RdapUnavailableError, match="non-https"):
        await RdapClient(transport=registry_transport(calls)).lookup_ip("136.1.1.1")
    assert not any(url.startswith("http://") for url in calls)


async def test_redirect_to_an_address_is_refused():
    calls: list[str] = []
    with pytest.raises(RdapUnavailableError, match="refused an RDAP URL on 10.0.0.5"):
        await RdapClient(transport=registry_transport(calls)).lookup_ip("136.3.3.3")
    assert "https://10.0.0.5/internal" not in calls


async def test_malformed_record_is_unavailable_not_a_crash():
    with pytest.raises(RdapUnavailableError, match="malformed"):
        await RdapClient(transport=registry_transport([])).lookup_ip("136.4.4.4")


async def test_redirect_loop_stops():
    calls: list[str] = []
    with pytest.raises(RdapUnavailableError, match="redirects"):
        await RdapClient(transport=registry_transport(calls)).lookup_ip("136.2.2.2")
    assert calls.count("https://rdap.arin.net/registry/ip/136.2.2.2") == 4


async def test_asn_lookup():
    client = RdapClient(transport=registry_transport([]))
    contact = await client.lookup_asn(396982)
    assert (contact.query, contact.name, contact.abuse_emails) == ("AS396982", "EXAMPLE-AS", ["abuse@example.com"])


async def test_private_addresses_are_rejected_without_a_request():
    calls: list[str] = []
    with pytest.raises(DomainValidationError):
        await RdapClient(transport=registry_transport(calls)).lookup_ip("10.0.0.1")
    assert calls == []


async def test_uncovered_address_is_not_found():
    with pytest.raises(DomainNotFoundError):
        await RdapClient(transport=registry_transport([])).lookup_ip("8.8.8.8")


async def test_registry_error_is_unavailable():
    with pytest.raises(RdapUnavailableError):
        await RdapClient(transport=registry_transport([], ip_status=503)).lookup_ip("3.5.140.2")


def make_app(client: RdapClient) -> Litestar:
    class _TestController(ReportsController):
        dependencies = {
            **ReportsController.dependencies,
            "rdap": Provide(lambda: client, sync_to_thread=False),
            # The report route shares the controller; nothing here touches the database.
            "abuse_report_repo": Provide(lambda: None, sync_to_thread=False),
        }

    return Litestar(
        route_handlers=[create_api_v1_router([_TestController])],
        dependencies=ambient_settings_dependency(),
        exception_handlers=EXCEPTION_HANDLERS,
    )


async def test_contact_endpoint_shape():
    async with AsyncTestClient(make_app(RdapClient(transport=registry_transport([])))) as http:
        resp = await http.get("/api/v1/reports/abuse-contact", params={"asn": "396982"})
    assert resp.status_code == 200
    assert resp.json()["abuseEmails"] == ["abuse@example.com"]
    assert resp.json()["rdapUrl"] == "https://rdap.arin.net/registry/autnum/396982"


async def test_contact_endpoint_maps_registry_failure_to_502():
    async with AsyncTestClient(make_app(RdapClient(transport=registry_transport([], ip_status=503)))) as http:
        resp = await http.get("/api/v1/reports/abuse-contact", params={"ipAddress": "3.5.140.2"})
    assert resp.status_code == 502
    assert resp.json()["detail"] == "RDAP lookup failed (rdap.db.ripe.net answered 503)"


async def test_contact_endpoint_needs_exactly_one_target():
    async with AsyncTestClient(make_app(RdapClient(transport=registry_transport([])))) as http:
        resp = await http.get("/api/v1/reports/abuse-contact")
    assert resp.status_code == 400
