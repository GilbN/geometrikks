"""RDAP lookups for the abuse contact of an IP address or an AS number.

The IANA bootstrap files map every allocated prefix and AS number range to
the registry (ARIN, RIPE NCC, APNIC, LACNIC, AFRINIC) that serves it; the
registry answers with the network and its contacts. Registries redirect
queries for space transferred elsewhere, so redirects are followed, but
only to https URLs and only a few hops.

Only the queried address or AS number leaves the server. The client caches
answers because registries rate-limit, and a report is often opened more
than once.
"""
from __future__ import annotations

import ipaddress
import re
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx2
import msgspec

from geometrikks.domain.exceptions import DomainNotFoundError, DomainValidationError
from geometrikks.server.logging import get_logger

logger = get_logger(__name__)

BOOTSTRAP_URLS = {
    "ipv4": "https://data.iana.org/rdap/ipv4.json",
    "ipv6": "https://data.iana.org/rdap/ipv6.json",
    "asn": "https://data.iana.org/rdap/asn.json",
}
BOOTSTRAP_TTL_SECONDS = 24 * 3600
RESULT_TTL_SECONDS = 24 * 3600
RESULT_CACHE_SIZE = 512
REQUEST_TIMEOUT_SECONDS = 10.0
MAX_REDIRECTS = 3
# The IANA ipv6 bootstrap is ~40 KiB and a registry answer a few KiB.
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
USER_AGENT = "GeoMetrikks (+https://geometrikks.dev)"

LookupKind = Literal["ip", "asn"]


class RdapUnavailableError(Exception):
    """The bootstrap file or the registry could not be fetched or parsed."""


@dataclass(frozen=True)
class AbuseContact:
    """The network or AS that holds the query, and who handles its abuse."""

    query: str
    kind: LookupKind
    registry: str
    rdap_url: str
    name: str | None = None
    handle: str | None = None
    start_address: str | None = None
    end_address: str | None = None
    cidrs: list[str] = field(default_factory=list)
    country: str | None = None
    abuse_emails: list[str] = field(default_factory=list)
    abuse_name: str | None = None


def _vcard_values(entity: dict[str, Any], prop: str) -> list[str]:
    """Values of one vCard property; RDAP carries contacts as jCard arrays."""
    vcard = entity.get("vcardArray")
    if not isinstance(vcard, list) or len(vcard) < 2 or not isinstance(vcard[1], list):
        return []
    values = []
    for entry in vcard[1]:
        if isinstance(entry, list) and len(entry) >= 4 and entry[0] == prop:
            value = entry[3]
            if isinstance(value, str) and value:
                values.append(value)
    return values


def _entities(node: dict[str, Any]):
    """Every entity under ``node``, depth first. ARIN nests the abuse
    contact inside the registrant organisation's entity."""
    for entity in node.get("entities") or []:
        if isinstance(entity, dict):
            yield entity
            yield from _entities(entity)


_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")


def _remark_abuse_emails(data: dict[str, Any]) -> list[str]:
    """Abuse addresses written into remarks. AFRINIC records often carry
    the abuse mailbox only as free text there."""
    found: list[str] = []
    nodes = [data, *_entities(data)]
    for node in nodes:
        for remark in node.get("remarks") or []:
            for line in remark.get("description") or []:
                for email in _EMAIL_RE.findall(str(line)):
                    if "abuse" in email.lower() and email.lower() not in (e.lower() for e in found):
                        found.append(email)
    return found


def _cidrs(data: dict[str, Any]) -> list[str]:
    """The cidr0 extension lists the prefixes that make up the network."""
    out = []
    for item in data.get("cidr0_cidrs") or []:
        prefix = item.get("v4prefix") or item.get("v6prefix")
        if prefix and item.get("length") is not None:
            out.append(f"{prefix}/{item['length']}")
    return out


def parse_rdap(query: str, kind: LookupKind, url: str, data: dict[str, Any]) -> AbuseContact:
    """The fields a report needs from one RDAP ip or autnum object."""
    emails: list[str] = []
    abuse_name: str | None = None
    for entity in _entities(data):
        if "abuse" not in (entity.get("roles") or []):
            continue
        for email in _vcard_values(entity, "email"):
            # registro.br truncates addresses by policy ("name@").
            if not _EMAIL_RE.fullmatch(email):
                continue
            if email.lower() not in (e.lower() for e in emails):
                emails.append(email)
        if abuse_name is None:
            abuse_name = next(iter(_vcard_values(entity, "fn")), None)
    if not emails:
        emails = _remark_abuse_emails(data)
    return AbuseContact(
        query=query,
        kind=kind,
        registry=urlsplit(url).hostname or url,
        rdap_url=url,
        name=data.get("name"),
        handle=data.get("handle"),
        start_address=data.get("startAddress"),
        end_address=data.get("endAddress"),
        cidrs=_cidrs(data),
        country=data.get("country"),
        abuse_emails=emails,
        abuse_name=abuse_name,
    )


def _pick_https(urls: list[str]) -> str | None:
    return next((u for u in urls if u.startswith("https://")), None)


def bootstrap_base_for_ip(bootstrap: dict[str, Any], ip: str) -> str | None:
    """The registry base URL whose longest prefix covers ``ip``."""
    address = ipaddress.ip_address(ip)
    best: tuple[int, str] | None = None
    for prefixes, urls in bootstrap.get("services") or []:
        base = _pick_https(urls)
        if base is None:
            continue
        for prefix in prefixes:
            try:
                network = ipaddress.ip_network(prefix, strict=False)
            except ValueError:
                continue
            if address.version == network.version and address in network:
                if best is None or network.prefixlen > best[0]:
                    best = (network.prefixlen, base)
    return best[1] if best else None


def bootstrap_base_for_asn(bootstrap: dict[str, Any], asn: int) -> str | None:
    """The registry base URL whose AS number range covers ``asn``."""
    for ranges, urls in bootstrap.get("services") or []:
        base = _pick_https(urls)
        if base is None:
            continue
        for entry in ranges:
            low, _, high = str(entry).partition("-")
            try:
                if int(low) <= asn <= int(high or low):
                    return base
            except ValueError:
                continue
    return None


def _join(base: str, path: str) -> str:
    return base.rstrip("/") + "/" + path


_LAN_SUFFIXES = (".local", ".lan", ".internal", ".home.arpa", ".localhost")


def _public_dns_name(host: str | None) -> bool:
    """A dotted DNS name outside the LAN suffixes; addresses never qualify."""
    if not host or "." not in host or host.endswith(_LAN_SUFFIXES):
        return False
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return True
    return False


def _parse_or_unavailable(query: str, kind: LookupKind, url: str, data: dict[str, Any]) -> AbuseContact:
    """A registry answer that is JSON but not RDAP is the registry's fault."""
    try:
        return parse_rdap(query, kind, url, data)
    except (AttributeError, KeyError, TypeError, ValueError) as exc:
        raise RdapUnavailableError(f"{urlsplit(url).hostname} sent a malformed record") from exc


class RdapClient:
    """RDAP lookups with bootstrap and result caches.

    A client is opened per lookup, so there is nothing to close at shutdown.
    """

    def __init__(self, *, transport: httpx2.AsyncBaseTransport | None = None) -> None:
        self._transport = transport
        self._bootstrap: dict[str, tuple[float, dict[str, Any]]] = {}
        self._results: OrderedDict[str, tuple[float, AbuseContact]] = OrderedDict()

    def _client(self) -> httpx2.AsyncClient:
        return httpx2.AsyncClient(
            timeout=REQUEST_TIMEOUT_SECONDS,
            follow_redirects=False,
            headers={"Accept": "application/rdap+json, application/json", "User-Agent": USER_AGENT},
            transport=self._transport,
        )

    async def _get_json(self, client: httpx2.AsyncClient, url: str) -> tuple[str, Any]:
        """GET ``url`` and decode its JSON; ``(final url, None)`` on a 404.

        This follows redirects itself instead of letting httpx2 do it. Every
        hop must be https to a public DNS name, so a registry answer cannot
        send the server to a plain-http or LAN URL. Hosts are not pinned to
        the bootstrap file, because LACNIC and APNIC redirect to national
        registries such as rdap.registro.br that the file does not list.
        """
        for _ in range(MAX_REDIRECTS + 1):
            host = urlsplit(url).hostname
            if not url.startswith("https://"):
                raise RdapUnavailableError(f"refused a non-https RDAP URL on {host}")
            if not _public_dns_name(host):
                raise RdapUnavailableError(f"refused an RDAP URL on {host}")
            try:
                async with client.stream("GET", url) as resp:
                    if resp.is_redirect and "location" in resp.headers:
                        url = str(resp.url.join(resp.headers["location"]))
                        continue
                    body = bytearray()
                    async for chunk in resp.aiter_bytes():
                        body += chunk
                        if len(body) > MAX_RESPONSE_BYTES:
                            raise RdapUnavailableError(f"{host} sent more than {MAX_RESPONSE_BYTES} bytes")
            except httpx2.HTTPError as exc:
                raise RdapUnavailableError(f"{host}: {type(exc).__name__}") from exc
            if resp.status_code == 404:
                return url, None
            if resp.status_code >= 400:
                raise RdapUnavailableError(f"{host} answered {resp.status_code}")
            try:
                return url, msgspec.json.decode(bytes(body))
            except msgspec.DecodeError as exc:
                raise RdapUnavailableError(f"{host} sent invalid JSON") from exc
        raise RdapUnavailableError(f"more than {MAX_REDIRECTS} redirects from {urlsplit(url).hostname}")

    async def _bootstrap_file(self, client: httpx2.AsyncClient, name: str) -> dict[str, Any]:
        cached = self._bootstrap.get(name)
        if cached and time.monotonic() - cached[0] < BOOTSTRAP_TTL_SECONDS:
            return cached[1]
        _, data = await self._get_json(client, BOOTSTRAP_URLS[name])
        if not isinstance(data, dict):
            raise RdapUnavailableError(f"IANA {name} bootstrap file is missing")
        self._bootstrap[name] = (time.monotonic(), data)
        return data

    def _cached(self, key: str) -> AbuseContact | None:
        hit = self._results.get(key)
        if hit is None:
            return None
        if time.monotonic() - hit[0] >= RESULT_TTL_SECONDS:
            del self._results[key]
            return None
        self._results.move_to_end(key)
        return hit[1]

    def _store(self, key: str, contact: AbuseContact) -> None:
        self._results[key] = (time.monotonic(), contact)
        self._results.move_to_end(key)
        while len(self._results) > RESULT_CACHE_SIZE:
            self._results.popitem(last=False)

    async def lookup_ip(self, ip: str) -> AbuseContact:
        """Abuse contact of the network holding ``ip``.

        Raises:
            DomainValidationError: The address is private, reserved or invalid.
            DomainNotFoundError: No registry covers the address, or it has no record.
            RdapUnavailableError: A lookup failed.
        """
        try:
            address = ipaddress.ip_address(ip)
        except ValueError as exc:
            raise DomainValidationError(f"Invalid IP address: {ip!r}") from exc
        if not address.is_global:
            raise DomainValidationError(f"{address} is not a public address; no registry holds it")
        key = f"ip:{address}"
        if (hit := self._cached(key)) is not None:
            return hit
        async with self._client() as client:
            bootstrap = await self._bootstrap_file(client, f"ipv{address.version}")
            base = bootstrap_base_for_ip(bootstrap, str(address))
            if base is None:
                raise DomainNotFoundError(f"No RDAP registry covers {address}")
            url, data = await self._get_json(client, _join(base, f"ip/{address}"))
        if not isinstance(data, dict):
            raise DomainNotFoundError(f"The registry has no record for {address}")
        contact = _parse_or_unavailable(str(address), "ip", url, data)
        self._store(key, contact)
        logger.info("rdap_lookup", kind="ip", query=str(address), registry=contact.registry,
                    abuse_emails=len(contact.abuse_emails))
        return contact

    async def lookup_asn(self, asn: int) -> AbuseContact:
        """Abuse contact of an autonomous system.

        Raises:
            DomainNotFoundError: No registry covers the AS number, or it has no record.
            RdapUnavailableError: A lookup failed.
        """
        key = f"asn:{asn}"
        if (hit := self._cached(key)) is not None:
            return hit
        async with self._client() as client:
            bootstrap = await self._bootstrap_file(client, "asn")
            base = bootstrap_base_for_asn(bootstrap, asn)
            if base is None:
                raise DomainNotFoundError(f"No RDAP registry covers AS{asn}")
            url, data = await self._get_json(client, _join(base, f"autnum/{asn}"))
        if not isinstance(data, dict):
            raise DomainNotFoundError(f"The registry has no record for AS{asn}")
        contact = _parse_or_unavailable(f"AS{asn}", "asn", url, data)
        self._store(key, contact)
        logger.info("rdap_lookup", kind="asn", query=f"AS{asn}", registry=contact.registry,
                    abuse_emails=len(contact.abuse_emails))
        return contact


_client: RdapClient | None = None


def get_rdap_client() -> RdapClient:
    """The process-wide client, built on first use so its caches are shared."""
    global _client
    if _client is None:
        _client = RdapClient()
    return _client
