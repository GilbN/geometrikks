"""Access-log evidence for an abuse report, for one IP or every IP of an ASN.

Raw-only like ``analytics/ip_profile.py``, because the CAGGs carry no IP
dimension. Most statements filter on ``ip_address = ANY(...)``, so a report
costs the same whether it covers one IP or a hundred. Two scan the whole
window instead: the ASN selection, since ``access_logs`` has no index on
the ASN column, and the operator-host classification.

The report goes to a third party, so nothing here returns the columns that
describe the operator's side of the request: ``host`` (the vhost),
``hostname`` (the GeoMetrikks instance), ``referrer`` and ``remote_user``.
The repository still reads hosts, but only to scrub the operator's names
and address from the paths and user agents that go out.

``host`` is whatever Host header the client sent, so a scanner can put any
name there. A host counts as the operator's when it got a 2xx response or
when many distinct clients used it. A redirect does not count, since an
HTTP to HTTPS redirect answers any Host. A proxy probe's spoofed
``Host: www.google.com`` meets neither test and stays in the evidence.
"""
from __future__ import annotations

import ipaddress
import re
from urllib.parse import unquote_plus
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from geometrikks.domain.analytics.ip_profile import BucketWidth, profile_bucket_width

PATH_LIMIT = 10
USER_AGENT_LIMIT = 3
REDACTED = "[redacted]"

# Shorter terms would scrub unrelated text.
_MIN_TERM_LENGTH = 4
# Distinct clients that make a never-served host the operator's. Spoofed
# Host headers come from one scanner or a few; the operator's names and
# server address are hit by everyone who enumerates them.
OPERATOR_HOST_MIN_CLIENTS = 5
# How far back the operator's hosts are classified, ending at the report
# end, whatever the report's own length.
OPERATOR_HOST_LOOKBACK = timedelta(days=30)
# Second-level labels under a country code (example.co.uk, example.com.au).
# Without them the parent of blog.example.co.uk would be co.uk, which
# scrubs every British domain and leaves example.co.uk readable.
_SECOND_LEVEL_LABELS = frozenset({
    "ac", "co", "com", "edu", "gob", "go", "gov", "ltd", "me", "mil",
    "ne", "net", "nic", "or", "org", "plc", "sch",
})

_BUCKET_INTERVAL: dict[BucketWidth, str] = {"hourly": "1 hour", "daily": "1 day"}


@dataclass(frozen=True)
class ReportPath:
    url: str
    hits: int
    error_hits: int


@dataclass(frozen=True)
class ReportUserAgent:
    user_agent: str
    hits: int


@dataclass(frozen=True)
class ReportLine:
    timestamp: datetime
    method: str | None
    url: str | None
    http_version: str | None
    status_code: int | None
    bytes_sent: int | None
    user_agent: str | None


@dataclass(frozen=True)
class ReportPeak:
    timestamp: datetime
    hits: int


@dataclass
class ReportIp:
    """What access_logs holds about one source IP inside the window."""

    ip: str
    total_requests: int = 0
    status_2xx: int = 0
    status_3xx: int = 0
    status_4xx: int = 0
    status_5xx: int = 0
    total_bytes: int = 0
    first_seen: datetime | None = None
    last_seen: datetime | None = None
    distinct_paths: int = 0
    malformed_requests: int = 0
    asn: int | None = None
    asn_organization: str | None = None
    country_code: str | None = None
    country_name: str | None = None
    peak: ReportPeak | None = None
    paths: list[ReportPath] = field(default_factory=list)
    user_agents: list[ReportUserAgent] = field(default_factory=list)
    lines: list[ReportLine] = field(default_factory=list)


@dataclass
class AsnSelection:
    """The busiest IPs of one ASN, with totals over all of its IPs."""

    ips: list[str]
    ip_count: int
    total_requests: int
    total_4xx: int
    organization: str | None


@dataclass
class ReportEvidence:
    granularity: BucketWidth
    ips: list[ReportIp]
    # Counts replacements, not terms, because the dialog reports what it scrubbed.
    redactions: int


def _strip_port(host: str) -> str:
    """``example.com:8443`` -> ``example.com``; ``[2001:db8::1]:443`` -> ``2001:db8::1``."""
    if host.startswith("["):
        return host[1:].split("]", 1)[0]
    if host.count(":") == 1:
        return host.split(":", 1)[0]
    return host


def _normalize_host(raw: str) -> str:
    return _strip_port(raw.strip().rstrip(".").lower())


def _as_ip(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """The address a host names, including zero-padded forms like
    ``195.000.194.210`` that clients send and ``ipaddress`` rejects."""
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        pass
    labels = host.split(".")
    if len(labels) == 4 and all(label.isdigit() for label in labels):
        try:
            return ipaddress.ip_address(".".join(str(int(label)) for label in labels))
        except ValueError:
            return None
    return None


def registrable_domain(host: str) -> str | None:
    """``blog.example.com`` -> ``example.com``, ``blog.example.co.uk`` ->
    ``example.co.uk``; None for addresses and dotless names."""
    if _as_ip(host) is not None:
        return None
    labels = host.split(".")
    if len(labels) < 2:
        return None
    keep = 3 if len(labels) >= 3 and len(labels[-1]) == 2 and labels[-2] in _SECOND_LEVEL_LABELS else 2
    return ".".join(labels[-keep:]) if len(labels) >= keep else None


def redaction_terms(
    operator_hosts: list[str], row_hosts: list[str], instance_names: list[str]
) -> list[str]:
    """Terms that identify the operator, longest first so a regex alternation
    prefers ``www.example.com`` over ``example.com``.

    ``operator_hosts`` are hosts classified as the operator's; each goes in
    with its registrable domain. A host from the report's own rows goes in
    when its registrable domain is one of those. Public addresses go in as
    written; private and reserved ones name no one, and payloads aimed at
    ``127.0.0.1`` are evidence. Dotless names stay: no outsider sees an
    instance name like ``ubuntu``, and scrubbing it would mangle user
    agents.
    """
    terms: set[str] = set()
    domains: set[str] = set()
    for raw in operator_hosts:
        host = _normalize_host(raw)
        address = _as_ip(host)
        if address is not None:
            if address.is_global:
                terms.add(host)
            continue
        domain = registrable_domain(host)
        if domain is None:
            continue
        terms.update((host, domain))
        domains.add(domain)
    for raw in row_hosts:
        host = _normalize_host(raw)
        if registrable_domain(host) in domains:
            terms.add(host)
    for raw in instance_names:
        name = _normalize_host(raw)
        if "." in name and _as_ip(name) is None:
            terms.add(name)
    return sorted(
        (term for term in terms if len(term) >= _MIN_TERM_LENGTH),
        key=lambda term: (-len(term), term),
    )


# Query parameter names whose values are credentials, matched on the name's
# last word: api_key, apiKey, X-Plex-Token, reconnectionToken, PHPSESSID.
# Whole words only, so zipcode and monkey stay, and "code" is not on the
# list because ?code=phpinfo(); is the evidence.
_SECRET_WORDS = frozenset({
    "apikey", "auth", "jwt", "key", "passwd", "password", "phpsessid", "pwd",
    "secret", "session", "sessid", "sessionid", "sid", "sig", "signature", "token",
})
_NAME_WORDS = re.compile(r"[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])")


def secret_param(name: str) -> bool:
    """Whether a query parameter name marks its value as a credential."""
    words = _NAME_WORDS.findall(unquote_plus(name).strip())
    return bool(words) and (words[-1].lower() in _SECRET_WORDS or "".join(words).lower() in _SECRET_WORDS)


def _term_pattern(term: str) -> str:
    """A term as regex. Addresses also match their other spellings: an IPv4
    octet with leading zeros, an IPv6 address written out in full."""
    address = _as_ip(term)
    if isinstance(address, ipaddress.IPv4Address):
        return r"\.".join(f"0*{octet}" for octet in str(address).split("."))
    if isinstance(address, ipaddress.IPv6Address):
        return "|".join(re.escape(form) for form in {str(address), address.exploded})
    return re.escape(term)


# user:pass@ in front of a scrubbed host names the operator's account.
_USERINFO = re.compile(r"[^/@\s?#&=]+(?::[^/@\s?#&=]*)?@(?=\[redacted\])")


class Redactor:
    """Replaces every term, case-insensitively, with ``[redacted]`` and
    counts the replacements.

    A term must end where a name ends, so ``example.com`` stays out of
    ``example.community``. Its start is left open: percent-encoding puts a
    letter before the name (``%2F%2Fexample.com``), and scrubbing a little
    too much is the safe failure.
    """

    def __init__(self, terms: list[str]) -> None:
        alternation = "|".join(_term_pattern(term) for term in terms)
        self._pattern = (
            re.compile(rf"(?:{alternation})(?![A-Za-z0-9-])", re.IGNORECASE) if terms else None
        )
        self.replacements = 0

    def __call__(self, value: str | None) -> str | None:
        if not value or self._pattern is None:
            return value
        redacted, count = self._pattern.subn(REDACTED, value)
        self.replacements += count
        return _USERINFO.sub("", redacted) if count else redacted

    def _names_operator(self, value: str) -> bool:
        return self._pattern is not None and self._pattern.search(value) is not None

    def url(self, value: str | None) -> str | None:
        """Redacts a URL. A query value goes whole when it names the operator
        or carries a credential.

        Forward-auth redirects (``?rd=https://app.example.com/api?apikey=...``)
        embed the operator's own URLs, credentials included; scrubbing only
        the host would still send the key. Attack payloads in other
        parameters stay as sent.
        """
        if not value:
            return value
        path, sep, query = value.partition("?")
        path = self(path) or ""
        # A percent-encoded name (auth%2Eexample%2Ecom) only shows decoded.
        decoded = unquote_plus(path)
        if decoded != path and self._names_operator(decoded):
            path = self(decoded) or ""
        if not sep:
            return path
        params = []
        for param in query.split("&"):
            name, has_value, raw = param.partition("=")
            if has_value and raw and self._sensitive(name, raw):
                self.replacements += 1
                params.append(f"{name}={REDACTED}")
            else:
                params.append(param)
        return f"{path}?{self('&'.join(params))}"

    def _sensitive(self, name: str, raw: str) -> bool:
        if secret_param(name):
            return True
        decoded = unquote_plus(unquote_plus(raw))
        if self._names_operator(decoded):
            return True
        # A relative redirect (?rd=/api?apikey=...) carries its own query.
        _, nested_sep, nested = decoded.partition("?")
        nested_query = nested if nested_sep else decoded
        return any(
            has_value and secret_param(nested_name)
            for nested_name, has_value, _ in (p.partition("=") for p in nested_query.split("&"))
        )


_WINDOW = (
    "WHERE ip_address = ANY(CAST(:ips AS inet[])) "
    "AND timestamp >= :start AND timestamp < :end"
)

# ip_count and total come from window functions evaluated before LIMIT, so
# they cover every IP of the ASN, not only the returned slice.
_ASN_SELECTION = text("""
    SELECT ip, hits, organization,
           COUNT(*) OVER () AS ip_count,
           SUM(hits) OVER () AS total,
           SUM(status_4xx) OVER () AS total_4xx
    FROM (
        SELECT host(ip_address) AS ip,
               COUNT(*) AS hits,
               COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500) AS status_4xx,
               MAX(autonomous_system_organization) AS organization
        FROM access_logs
        WHERE autonomous_system_number = :asn
          AND timestamp >= :start AND timestamp < :end
        GROUP BY ip_address
    ) per_ip
    ORDER BY hits DESC, ip
    LIMIT :limit
""")

_TOTALS = text(f"""
    SELECT host(ip_address) AS ip,
           COUNT(*) AS total_requests,
           COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300) AS status_2xx,
           COUNT(*) FILTER (WHERE status_code >= 300 AND status_code < 400) AS status_3xx,
           COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500) AS status_4xx,
           COUNT(*) FILTER (WHERE status_code >= 500 AND status_code < 600) AS status_5xx,
           COALESCE(SUM(bytes_sent), 0) AS total_bytes,
           MIN(timestamp) AS first_seen,
           MAX(timestamp) AS last_seen,
           COUNT(DISTINCT url) AS distinct_paths
    FROM access_logs
    {_WINDOW}
    GROUP BY ip_address
""")

# The newest row that has ASN data, else the newest row.
_IDENTITY = text(f"""
    SELECT DISTINCT ON (ip_address)
           host(ip_address) AS ip,
           autonomous_system_number AS asn,
           autonomous_system_organization AS organization,
           country_code,
           country_name
    FROM access_logs
    {_WINDOW}
    ORDER BY ip_address, (autonomous_system_number IS NULL), timestamp DESC
""")

_MALFORMED = text("""
    SELECT host(ip_address) AS ip, COUNT(*) AS malformed
    FROM access_log_debug
    WHERE ip_address = ANY(CAST(:ips AS inet[]))
      AND is_malformed
      AND created_at >= :start AND created_at < :end
    GROUP BY ip_address
""")


def _peak_stmt(width: BucketWidth):
    # The interval comes from a two-entry map, never from the request. The
    # report is in UTC, so daily buckets are UTC days.
    return text(f"""
        SELECT DISTINCT ON (ip) ip, bucket, hits
        FROM (
            SELECT host(ip_address) AS ip,
                   time_bucket('{_BUCKET_INTERVAL[width]}', timestamp) AS bucket,
                   COUNT(*) AS hits
            FROM access_logs
            {_WINDOW}
            GROUP BY ip_address, bucket
        ) buckets
        ORDER BY ip, hits DESC, bucket
    """)


_PATHS = text(f"""
    SELECT ip, url, hits, error_hits
    FROM (
        SELECT host(ip_address) AS ip,
               url,
               COUNT(*) AS hits,
               COUNT(*) FILTER (WHERE status_code >= 400) AS error_hits,
               ROW_NUMBER() OVER (
                   PARTITION BY ip_address ORDER BY COUNT(*) DESC, url
               ) AS rank
        FROM access_logs
        {_WINDOW}
          AND url IS NOT NULL
        GROUP BY ip_address, url
    ) ranked
    WHERE rank <= :limit
    ORDER BY ip, rank
""")

_USER_AGENTS = text(f"""
    SELECT ip, user_agent, hits
    FROM (
        SELECT host(ip_address) AS ip,
               user_agent,
               COUNT(*) AS hits,
               ROW_NUMBER() OVER (
                   PARTITION BY ip_address ORDER BY COUNT(*) DESC, user_agent
               ) AS rank
        FROM access_logs
        {_WINDOW}
          AND user_agent IS NOT NULL
        GROUP BY ip_address, user_agent
    ) ranked
    WHERE rank <= :limit
    ORDER BY ip, rank
""")

# The newest lines per IP, returned oldest first so the excerpt reads in order.
_LINES = text(f"""
    SELECT ip, timestamp, method, url, http_version, status_code, bytes_sent, user_agent
    FROM (
        SELECT host(ip_address) AS ip,
               timestamp, method, url, http_version, status_code, bytes_sent, user_agent,
               ROW_NUMBER() OVER (PARTITION BY ip_address ORDER BY timestamp DESC) AS rank
        FROM access_logs
        {_WINDOW}
    ) ranked
    WHERE rank <= :limit
    ORDER BY ip, timestamp
""")

# The one statement that reads other clients' rows: the operator's hosts
# are the ones many clients use, which the chosen IPs alone cannot show.
_OPERATOR_HOSTS = text("""
    SELECT host
    FROM access_logs
    WHERE timestamp >= :start AND timestamp < :end
      AND host IS NOT NULL
    GROUP BY host
    HAVING COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300) > 0
        OR COUNT(DISTINCT ip_address) >= :min_clients
""")

_ROW_NAMES = text(f"""
    SELECT DISTINCT host AS name, 'host' AS kind
    FROM access_logs
    {_WINDOW}
      AND host IS NOT NULL
    UNION
    SELECT DISTINCT hostname AS name, 'hostname' AS kind
    FROM access_logs
    {_WINDOW}
      AND hostname IS NOT NULL
""")


def _merge_paths(paths: list[ReportPath]) -> list[ReportPath]:
    """Merges paths that became identical once a value was scrubbed."""
    merged: dict[str, ReportPath] = {}
    for path in paths:
        seen = merged.get(path.url)
        merged[path.url] = path if seen is None else ReportPath(
            url=path.url, hits=seen.hits + path.hits, error_hits=seen.error_hits + path.error_hits
        )
    return sorted(merged.values(), key=lambda p: (-p.hits, p.url))


class AbuseReportRepository:
    """A fixed set of statements per report, each bounded to the chosen IPs."""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def select_asn_ips(
        self, asn: int, start: datetime, end: datetime, limit: int
    ) -> AsnSelection:
        rows = (await self.session.execute(
            _ASN_SELECTION, {"asn": asn, "start": start, "end": end, "limit": limit}
        )).fetchall()
        if not rows:
            return AsnSelection(ips=[], ip_count=0, total_requests=0, total_4xx=0, organization=None)
        return AsnSelection(
            ips=[r.ip for r in rows],
            ip_count=int(rows[0].ip_count),
            total_requests=int(rows[0].total),
            total_4xx=int(rows[0].total_4xx),
            organization=next((r.organization for r in rows if r.organization), None),
        )

    async def get_evidence(
        self, ips: list[str], start: datetime, end: datetime, *, lines_per_ip: int
    ) -> ReportEvidence:
        """Evidence for each IP, in the order given; IPs without rows come back zeroed."""
        width = profile_bucket_width(start, end)
        items = [ReportIp(ip=ip) for ip in ips]
        if not ips:
            return ReportEvidence(granularity=width, ips=[], redactions=0)
        # Keyed by address, not text: Postgres prints ::1.2.3.4 where Python
        # prints ::102:304.
        by_address = {ipaddress.ip_address(item.ip): item for item in items}

        def item_for(row_ip: str) -> ReportIp:
            return by_address[ipaddress.ip_address(row_ip)]

        params = {"ips": ips, "start": start, "end": end}

        operator_hosts = (await self.session.execute(_OPERATOR_HOSTS, {
            # The full lookback even for a one-hour report: a vhost that was
            # served yesterday is still the operator's.
            "start": end - OPERATOR_HOST_LOOKBACK,
            "end": end,
            "min_clients": OPERATOR_HOST_MIN_CLIENTS,
        })).scalars().all()
        names = (await self.session.execute(_ROW_NAMES, params)).fetchall()
        redact = Redactor(redaction_terms(
            list(operator_hosts),
            [r.name for r in names if r.kind == "host"],
            [r.name for r in names if r.kind == "hostname"],
        ))

        for r in (await self.session.execute(_TOTALS, params)).fetchall():
            item = item_for(r.ip)
            item.total_requests = int(r.total_requests)
            item.status_2xx = int(r.status_2xx)
            item.status_3xx = int(r.status_3xx)
            item.status_4xx = int(r.status_4xx)
            item.status_5xx = int(r.status_5xx)
            item.total_bytes = int(r.total_bytes)
            item.first_seen = r.first_seen
            item.last_seen = r.last_seen
            item.distinct_paths = int(r.distinct_paths)

        for r in (await self.session.execute(_MALFORMED, params)).fetchall():
            item_for(r.ip).malformed_requests = int(r.malformed)

        for r in (await self.session.execute(_IDENTITY, params)).fetchall():
            item = item_for(r.ip)
            item.asn = int(r.asn) if r.asn is not None else None
            item.asn_organization = r.organization
            item.country_code = r.country_code
            item.country_name = r.country_name

        for r in (await self.session.execute(_peak_stmt(width), params)).fetchall():
            item_for(r.ip).peak = ReportPeak(timestamp=r.bucket, hits=int(r.hits))

        paths = await self.session.execute(_PATHS, {**params, "limit": PATH_LIMIT})
        for r in paths.fetchall():
            item_for(r.ip).paths.append(ReportPath(
                url=redact.url(r.url) or "", hits=int(r.hits), error_hits=int(r.error_hits)
            ))
        for item in items:
            item.paths = _merge_paths(item.paths)

        agents = await self.session.execute(_USER_AGENTS, {**params, "limit": USER_AGENT_LIMIT})
        for r in agents.fetchall():
            item_for(r.ip).user_agents.append(
                ReportUserAgent(user_agent=redact(r.user_agent) or "", hits=int(r.hits))
            )

        if lines_per_ip > 0:
            lines = await self.session.execute(_LINES, {**params, "limit": lines_per_ip})
            for r in lines.fetchall():
                item_for(r.ip).lines.append(ReportLine(
                    timestamp=r.timestamp,
                    method=r.method,
                    url=redact.url(r.url),
                    http_version=r.http_version,
                    status_code=r.status_code,
                    bytes_sent=r.bytes_sent,
                    user_agent=redact(r.user_agent),
                ))

        return ReportEvidence(granularity=width, ips=items, redactions=redact.replacements)
