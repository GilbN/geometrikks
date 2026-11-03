"""CrowdSec API: status, active decisions with geo enrichment, ban stats.

All /api routes are session-authenticated by middleware. The whole feature
is gated on /status: when the integration is disabled (no LAPI URL/bouncer
key) the data endpoints return 404 and the frontend hides the page.
"""

from __future__ import annotations

import ipaddress
import re
import time

import msgspec
from datetime import datetime, timedelta, timezone
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated, Literal

from advanced_alchemy.extensions.litestar import filters
from advanced_alchemy.service import OffsetPagination
from litestar import Controller, Request, get, post
from litestar.di import NamedDependency, Provide
from litestar.exceptions import NotFoundException, PermissionDeniedException
from litestar.params import JSONBody, PathParameter, QueryParameter, SkipValidation
from litestar.openapi.datastructures import ResponseSpec
from litestar.status_codes import (
    HTTP_200_OK, HTTP_204_NO_CONTENT, HTTP_404_NOT_FOUND, HTTP_409_CONFLICT,
)
from sqlalchemy.ext.asyncio import AsyncSession

from geometrikks.domain.drop.dependencies import provide_drop_snapshot
from geometrikks.domain.drop.snapshot import DropSnapshot
from geometrikks.domain.security.dependencies import (
    provide_crowdsec_poller,
    provide_crowdsec_service,
    provide_drop_traffic_repo,
    provide_geoip_locator,
    provide_limit_offset_pagination,
    provide_security_enrichment_repo,
)
from geometrikks.config.settings import Settings
from geometrikks.domain.exceptions import DomainValidationError
from geometrikks.lib.validation import validate_ip_address
from geometrikks.domain.security.alert_history import (
    BOT_KIND_GROUP,
    AlertFilters,
    decode_cursor,
    fetch_alert_page,
)
from geometrikks.domain.security.grouping import (
    DecisionGroup,
    go_duration_seconds,
    group_decisions,
    search_groups,
    search_network,
)
from geometrikks.domain.security.repositories import DropTrafficRepository, SecurityEnrichmentRepository
from geometrikks.domain.security.schemas import (
    BanNetworkResult,
    BanNetworksRequest,
    BanNetworksResponse,
    BannedIp,
    BannedMapCollection,
    BannedRangeView,
    DropNetworksResponse,
    DropNetworkTrafficView,
    IpEnrichment,
    MAX_BULK_BAN_NETWORKS,
)
from geometrikks.domain.security.map_data import active_decision_ips, banned_map_collection, canonical_ip, decision_winner
from geometrikks.lib.parameters import (
    CityFilter,
    CountryCodeFilter,
    ServerIn,
    range_end_examples,
    range_start_examples,
)
from geometrikks.server.api_key_auth import ApiKeyPrincipal
from geometrikks.server.auth import AdminUser
from geometrikks.server.exceptions import ErrorEnvelope
from geometrikks.server.logging import get_logger
from geometrikks.services.crowdsec import (
    Alert,
    CrowdSecError,
    CrowdSecService,
    CrowdSecUnreachableError,
    Decision,
    DecisionScope,
    DecisionType,
    manual_reason,
)
from geometrikks.services.crowdsec.stream import CrowdSecStreamPoller
from geometrikks.services.geoip.locator import GeoIpLocator

# The CAPI community blocklist can hold tens of thousands of decisions; the
# decisions table shows local origins by default and CAPI/lists opt in via
# the origins filter. /stats still covers all origins.
DEFAULT_ORIGINS = "crowdsec,cscli,geometrikks"

TOP_SCENARIO_LIMIT = 10

# Alert origins the engine stamps on ``kind`` (pkg/types/alert_kind.go).
ALERT_KINDS = frozenset({"crowdsec", "waf", "bot-detection", "capi", "papi", "cscli"})

# Each scenario is its own LAPI query, twice under an IP filter.
MAX_ALERT_SCENARIOS = 5
# The scenario picker counts this many of the newest alerts.
SCENARIO_SAMPLE_SIZE = 500

ALERT_KIND_DESCRIPTION = (
    "Keep only alerts of one kind, `crowdsec`, `waf`, `bot-detection`, `capi`, `papi` or `cscli`. `bot` "
    "keeps everything the AppSec bot challenge produces. Needs CrowdSec 1.7 or newer, and an older LAPI "
    "gets a 400."
)
SINCE_DESCRIPTION = (
    "Keep only alerts that started within this long before now, as a Go duration of hours, minutes and "
    "seconds such as `24h` or `1h30m`."
)
MACHINE_CREDENTIALS_NOTE = (
    "Answers 403 when the server has no CrowdSec machine credentials, CROWDSEC_MACHINE_ID and "
    "CROWDSEC_MACHINE_PASSWORD."
)
WRITE_NOTE = "Needs a Read/write API key or a browser session."


# Go duration string as the LAPI accepts it, e.g. "4h", "30m", "1h30m".
GO_DURATION_RE = re.compile(r"^(\d+h)?(\d+m)?(\d+s)?$")

# Ban durations may start with days. Older LAPIs parse decision durations
# with Go's time.ParseDuration, which has no "d" unit, so _ban_duration
# folds days into hours.
BAN_DURATION_RE = re.compile(r"^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$")

BULK_BAN_UNREACHABLE_LIMIT = 3
BULK_BAN_TIME_LIMIT_SECONDS = 120
# The Security card counts these apart from failures by their "not attempted:" prefix.
BULK_BAN_NOT_ATTEMPTED_ERRORS = {
    "crowdsec_unreachable": "not attempted: CrowdSec unreachable",
    "time_limit": "not attempted: time limit",
}
_bulk_ban_clock: Callable[[], float] = time.monotonic

logger = get_logger(__name__)


GoDurationLeft = Annotated[
    str,
    msgspec.Meta(
        description="The time left, as a Go duration such as `3h59m12s`. Negative once the decision has expired."
    ),
]
DecisionTarget = Annotated[
    str,
    msgspec.Meta(
        description=(
            "What the decision targets. An IP for scope `Ip`, a CIDR for `Range`, and a country code or AS number "
            "for other scopes."
        )
    ),
]
DecisionTypeName = Annotated[
    str, msgspec.Meta(description="The remediation, `ban`, `captcha` or a name a bouncer defines.")
]
DecisionOrigin = Annotated[
    str,
    msgspec.Meta(
        description=(
            "Where the decision came from, such as `crowdsec` for a local detection, `cscli` for a ban made on the "
            "command line, `CAPI` or `lists` for a blocklist, and `geometrikks` for a ban made here."
        )
    ),
]
StoredCountryName = Annotated[
    str | None,
    msgspec.Meta(description="From GeoMetrikks' own traffic, else from its GeoIP database. Null for non-IP scopes."),
]
RequestCount24h = Annotated[
    int | None,
    msgspec.Meta(
        description=(
            "Requests from the IP in the access logs over the last 24 hours. Null for scopes other than `Ip`."
        )
    ),
]


class CrowdSecStatusResponse(msgspec.Struct, rename="camel"):
    """Whether the CrowdSec integration is on and what it can do."""

    enabled: Annotated[
        bool,
        msgspec.Meta(
            description="True when CROWDSEC_LAPI_URL and CROWDSEC_BOUNCER_API_KEY are set."
        ),
    ]
    write_enabled: Annotated[
        bool,
        msgspec.Meta(
            description=(
                "True when CROWDSEC_MACHINE_ID and CROWDSEC_MACHINE_PASSWORD are set too. Banning, unbanning and "
                "the alert endpoints need them. This does not test the credentials."
            )
        ),
    ]
    lapi_reachable: Annotated[
        bool,
        msgspec.Meta(
            description=(
                "Whether the LAPI answered the last decision stream poll. Before the first poll, or with no "
                "poller, GeoMetrikks asks the LAPI during this request."
            )
        ),
    ]
    live_updates: Annotated[
        bool,
        msgspec.Meta(
            description=(
                "Whether `/ws/crowdsec` streams decision changes. False when the scheduler is off or the server "
                "runs without its database."
            )
        ),
    ] = False


class DecisionView(msgspec.Struct, rename="camel"):
    """One active CrowdSec decision."""

    id: Annotated[int | None, msgspec.Meta(description="The LAPI's decision id.")]
    ip: DecisionTarget
    type: DecisionTypeName
    scope: Annotated[str, msgspec.Meta(description="What `ip` holds, such as `Ip`, `Range`, `Country` or `AS`.")]
    origin: DecisionOrigin
    scenario: Annotated[
        str,
        msgspec.Meta(
            description=(
                "The scenario that raised the decision. A manual decision holds its reason instead, and one made "
                "in GeoMetrikks reads like `geometrikks/manual-ban: spam`."
            )
        ),
    ]
    duration: GoDurationLeft
    country_code: str | None
    country_name: StoredCountryName
    city: str | None
    request_count_24h: RequestCount24h = msgspec.field(name="requestCount24h")


class GroupedDecisionView(msgspec.Struct, rename="camel"):
    """One of the decisions on a target."""

    id: Annotated[int | None, msgspec.Meta(description="The LAPI's decision id.")]
    type: DecisionTypeName
    origin: DecisionOrigin
    scenario: str
    duration: GoDurationLeft


class DecisionGroupView(msgspec.Struct, rename="camel"):
    """Every active decision on one target, as one row.

    CrowdSec makes one decision per scenario, so an IP that set off three scenarios holds three.
    """

    ip: DecisionTarget
    scope: Annotated[str, msgspec.Meta(description="What `ip` holds, such as `Ip`, `Range`, `Country` or `AS`.")]
    type: Annotated[
        str,
        msgspec.Meta(
            description="The strongest remediation among the decisions. `ban` beats `captcha`, which beats the rest."
        ),
    ]
    duration: Annotated[
        str,
        msgspec.Meta(
            description="The longest time left among the decisions, as a Go duration such as `3h59m12s`."
        ),
    ]
    origins: Annotated[list[str], msgspec.Meta(description="Each origin once, in the order of `decisions`.")]
    decision_count: int
    decisions: Annotated[list[GroupedDecisionView], msgspec.Meta(description="Longest time left first.")]
    country_code: str | None
    country_name: StoredCountryName
    city: str | None
    request_count_24h: RequestCount24h = msgspec.field(name="requestCount24h")


class OriginCount(msgspec.Struct, rename="camel"):
    """The number of active decisions from one origin."""

    origin: str
    count: int


class ScenarioCount(msgspec.Struct, rename="camel"):
    """The number of decisions or alerts from one scenario."""

    scenario: str
    count: int


class CrowdSecStatsResponse(msgspec.Struct, rename="camel"):
    """Counts of the active CrowdSec decisions across every origin."""

    total: int
    by_origin: Annotated[list[OriginCount], msgspec.Meta(description="Every origin, the most decisions first.")]
    top_scenarios: Annotated[
        list[ScenarioCount], msgspec.Meta(description="The ten scenarios with the most decisions, the most first.")
    ]


class AlertView(msgspec.Struct, rename="camel"):
    """One CrowdSec alert, a scenario that fired against a source."""

    id: Annotated[int | None, msgspec.Meta(description="The LAPI's alert id.")]
    scenario: str
    kind: Annotated[
        str | None,
        msgspec.Meta(
            description=(
                "Where the alert came from, such as `crowdsec` for a log scenario, `waf` or `bot-detection`. Null "
                "from a LAPI that predates the field."
            )
        ),
    ]
    message: str
    events_count: Annotated[int, msgspec.Meta(description="How many events set off the scenario.")]
    created_at: Annotated[str, msgspec.Meta(description="When the LAPI stored the alert, as RFC 3339.")]
    machine_id: Annotated[
        str | None, msgspec.Meta(description="The CrowdSec machine that sent the alert.")
    ]
    scope: Annotated[str, msgspec.Meta(description="What `value` holds, such as `Ip` or `Range`.")]
    value: Annotated[str, msgspec.Meta(description="The source the alert is about, such as an IP.")]
    country_code: str | None
    country_name: Annotated[
        str | None,
        msgspec.Meta(description="From GeoMetrikks' own traffic or its GeoIP database. The LAPI sends only a code."),
    ]
    as_name: Annotated[str | None, msgspec.Meta(description="The source's network name, as the LAPI gives it.")]
    decision_count: Annotated[
        int, msgspec.Meta(description="The decisions the alert made, expired ones included.")
    ]
    active_decision_count: Annotated[int, msgspec.Meta(description="The decisions still in force.")]
    decision_types: Annotated[
        list[str],
        msgspec.Meta(description="Each decision type once, in the order the LAPI lists the decisions."),
    ]


class AlertPageView(msgspec.Struct, rename="camel"):
    """One page of CrowdSec alerts, newest first."""

    alerts: list[AlertView]
    next_cursor: Annotated[
        str | None,
        msgspec.Meta(description="Pass it as `before` to get the next, older page. Null on the last page."),
    ]


class AlertDecisionView(msgspec.Struct, rename="camel"):
    """A decision an alert made, still in force or expired."""

    id: Annotated[int | None, msgspec.Meta(description="The LAPI's decision id.")]
    type: DecisionTypeName
    scope: str
    value: str
    origin: DecisionOrigin
    scenario: str
    duration: GoDurationLeft
    expired: bool
    simulated: Annotated[
        bool, msgspec.Meta(description="True when CrowdSec ran the scenario in simulation mode and enforces nothing.")
    ]


class AlertContextView(msgspec.Struct, rename="camel"):
    """One context key the scenario recorded, with every value it saw."""

    key: str
    values: list[str]


class AlertEventView(msgspec.Struct, rename="camel"):
    """One event the LAPI kept for an alert."""

    timestamp: Annotated[str, msgspec.Meta(description="When the event happened, usually as RFC 3339.")]
    meta: Annotated[
        dict[str, str], msgspec.Meta(description="The event's metadata, such as the log type and the source IP.")
    ]


class AlertDetailView(AlertView, rename="camel"):
    """One CrowdSec alert with its context, stored events and decisions."""

    simulated: Annotated[
        bool, msgspec.Meta(description="True when CrowdSec ran the scenario in simulation mode.")
    ]
    start_at: Annotated[str | None, msgspec.Meta(description="When the first event happened.")]
    stop_at: Annotated[str | None, msgspec.Meta(description="When the last event happened.")]
    as_number: Annotated[str | None, msgspec.Meta(description="The source's AS number, as the LAPI gives it.")]
    range: Annotated[str | None, msgspec.Meta(description="The source's network as a CIDR, as the LAPI gives it.")]
    context: list[AlertContextView]
    events: Annotated[
        list[AlertEventView],
        msgspec.Meta(description="A sample of the events. The LAPI keeps fewer than `eventsCount` on busy alerts."),
    ]
    decisions: list[AlertDecisionView]


class BanRequest(msgspec.Struct, rename="camel"):
    """What to ban, for how long and why."""

    ip: Annotated[
        str,
        msgspec.Meta(
            description=(
                "An IP, or a range in CIDR form such as `203.0.113.0/24`. A /32 or /128 becomes an IP decision."
            )
        ),
    ]
    duration: Annotated[
        str | None,
        msgspec.Meta(
            description=(
                "How long the decision lasts, such as `4h`, `30m`, `7d` or `1d12h`. Defaults to "
                "CROWDSEC_DEFAULT_BAN_DURATION, 4h by default."
            )
        ),
    ] = None
    reason: Annotated[
        str | None,
        msgspec.Meta(
            description=(
                "The reason the decision carries. Defaults to `manual ban from GeoMetrikks`, or "
                "`manual captcha from GeoMetrikks` for a captcha."
            )
        ),
    ] = None
    type: Annotated[DecisionType, msgspec.Meta(description="`ban` or `captcha`. Defaults to `ban`.")] = "ban"


class UnbanRequest(msgspec.Struct, rename="camel"):
    """What to unban."""

    ip: Annotated[str, msgspec.Meta(description="An IP, or a range in CIDR form such as `203.0.113.0/24`.")]


class UnbanResponse(msgspec.Struct, rename="camel"):
    """How many decisions the unban deleted."""

    deleted: int


def _fill_from_geoip(
    enriched: dict[str, IpEnrichment], ips: list[str], geoip: GeoIpLocator | None
) -> dict[str, IpEnrichment]:
    """Add GeoLite2 places for IPs whose stored traffic has no country.

    Bans from mail or SSH scenarios target IPs that never reached the proxy,
    so access_logs holds no rows for them.
    """
    missing = [ip for ip in ips if (known := enriched.get(ip)) is None or known.country_code is None]
    if geoip is None or not missing:
        return enriched
    merged = dict(enriched)
    for ip, place in geoip.locate(missing).items():
        known = enriched.get(ip)
        merged[ip] = IpEnrichment(
            country_code=place.country_code,
            country_name=place.country_name,
            city=place.city,
            request_count_24h=known.request_count_24h if known else 0,
        )
    return merged


def _to_view(decision: Decision, enrichment: IpEnrichment | None) -> DecisionView:
    is_ip_scope = decision.scope == "Ip"
    return DecisionView(
        id=decision.id,
        ip=decision.value,
        type=decision.type,
        scope=decision.scope,
        origin=decision.origin,
        scenario=decision.scenario,
        duration=decision.duration,
        country_code=enrichment.country_code if enrichment else None,
        country_name=enrichment.country_name if enrichment else None,
        city=enrichment.city if enrichment else None,
        request_count_24h=(
            enrichment.request_count_24h if enrichment else (0 if is_ip_scope else None)
        ),
    )


def _to_group_view(group: DecisionGroup, enrichment: IpEnrichment | None) -> DecisionGroupView:
    is_ip_scope = group.scope == "Ip"
    return DecisionGroupView(
        ip=group.value,
        scope=group.scope,
        type=group.type,
        duration=group.duration,
        origins=group.origins,
        decision_count=len(group.decisions),
        decisions=[
            GroupedDecisionView(
                id=d.id, type=d.type, origin=d.origin, scenario=d.scenario, duration=d.duration
            )
            for d in group.decisions
        ],
        country_code=enrichment.country_code if enrichment else None,
        country_name=enrichment.country_name if enrichment else None,
        city=enrichment.city if enrichment else None,
        request_count_24h=(
            enrichment.request_count_24h if enrichment else (0 if is_ip_scope else None)
        ),
    )


def _enrichment_key(alert: Alert) -> str:
    """Enrichment rows are keyed by the canonical address, which the LAPI's
    spelling of an IPv6 source need not match."""
    return canonical_ip(alert.source.value) or alert.source.value


def _alert_country(alert: Alert, enrichment: IpEnrichment | None) -> tuple[str | None, str | None]:
    if alert.source.cn is not None:
        # The LAPI sends only a code. The name comes from our lookup, and only
        # when its code matches.
        same_country = enrichment is not None and enrichment.country_code == alert.source.cn
        return alert.source.cn, enrichment.country_name if same_country else None
    if enrichment is None:
        return None, None
    return enrichment.country_code, enrichment.country_name


def _alert_summary(alert: Alert, enrichment: IpEnrichment | None) -> dict:
    country_code, country_name = _alert_country(alert, enrichment)
    return {
        "id": alert.id,
        "scenario": alert.scenario,
        "kind": alert.kind,
        "message": alert.message,
        "events_count": alert.events_count,
        "created_at": alert.created_at,
        "machine_id": alert.machine_id,
        "scope": alert.source.scope,
        "value": _enrichment_key(alert) if alert.source.scope == "Ip" else alert.source.value,
        "country_code": country_code,
        "country_name": country_name,
        "as_name": alert.source.as_name,
        "decision_count": len(alert.decisions),
        "active_decision_count": sum(not d.expired for d in alert.decisions),
        "decision_types": list(dict.fromkeys(d.type for d in alert.decisions)),
    }


async def _alert_detail(
    alert: Alert, enrichment_repo: SecurityEnrichmentRepository, geoip: GeoIpLocator | None
) -> AlertDetailView:
    source = alert.source
    needs_geo = source.scope == "Ip" and source.cn is None
    key = _enrichment_key(alert)
    enriched = await enrichment_repo.enrich([key]) if needs_geo else {}
    if source.scope == "Ip":
        enriched = _fill_from_geoip(enriched, [key], geoip)
    return AlertDetailView(
        **_alert_summary(alert, enriched.get(key)),
        simulated=bool(alert.simulated),
        start_at=alert.start_at,
        stop_at=alert.stop_at,
        as_number=source.as_number,
        range=source.range,
        context=[AlertContextView(key=c.key, values=c.values) for c in alert.context],
        events=[AlertEventView(timestamp=e.timestamp, meta=e.meta) for e in alert.events],
        decisions=[
            AlertDecisionView(
                id=d.id, type=d.type, scope=d.scope, value=d.value, origin=d.origin,
                scenario=d.scenario, duration=d.duration, expired=d.expired,
                simulated=bool(d.simulated),
            )
            for d in alert.decisions
        ],
    )


def _require_service(crowdsec: CrowdSecService | None) -> CrowdSecService:
    if crowdsec is None:
        raise NotFoundException(detail="CrowdSec integration is not enabled")
    return crowdsec


def _require_write(crowdsec: CrowdSecService | None, settings: Settings) -> CrowdSecService:
    service = _require_service(crowdsec)
    if not settings.crowdsec.write_enabled:
        raise PermissionDeniedException(
            detail="Ban/unban requires CROWDSEC_MACHINE_ID and CROWDSEC_MACHINE_PASSWORD"
        )
    return service


def _validate_duration(value: str) -> str:
    if not value or not GO_DURATION_RE.fullmatch(value):
        raise DomainValidationError(
            f"Invalid duration: {value!r} (expected a Go duration like 4h, 30m, 168h)"
        )
    return value


def _validate_alert_kind(kind: str | None) -> None:
    accepted_kinds = ALERT_KINDS | {BOT_KIND_GROUP}
    if kind is not None and kind not in accepted_kinds:
        raise DomainValidationError(
            f"Unknown alert kind: {kind!r} (expected one of {', '.join(sorted(accepted_kinds))})"
        )


def _ban_duration(value: str) -> str:
    match = BAN_DURATION_RE.fullmatch(value)
    if match is None or not any(match.groups()):
        raise DomainValidationError(
            f"Invalid ban duration: {value!r} (expected a duration like 4h, 30m, 7d, 1d12h)"
        )
    days, hours, minutes, seconds = (int(part or 0) for part in match.groups())
    if not (days or hours or minutes or seconds):
        raise DomainValidationError(f"Invalid ban duration: {value!r} (must be longer than zero)")
    hours += days * 24
    return "".join(
        f"{amount}{unit}"
        for amount, unit, given in (
            (hours, "h", match[1] or match[2]),
            (minutes, "m", match[3]),
            (seconds, "s", match[4]),
        )
        if given
    )


def _decision_target(value: str) -> tuple[DecisionScope, str]:
    """Scope and canonical value for a ban or unban target.

    A CIDR becomes a Range on its network address; a single-address
    network (/32, /128) is an Ip decision.
    """
    if "/" not in value:
        return "Ip", validate_ip_address(value)
    try:
        network = ipaddress.ip_network(value, strict=False)
    except ValueError as exc:
        raise DomainValidationError(f"Invalid IP range: {value!r}") from exc
    if network.prefixlen == 0:
        raise DomainValidationError(f"Invalid IP range: {value!r} covers every address")
    if network.num_addresses == 1:
        return "Ip", str(network.network_address)
    return "Range", str(network)


def _canonical_cidr(value: str) -> str | None:
    try:
        return str(ipaddress.ip_network(value, strict=False))
    except ValueError:
        return None


def _host_cidr(value: str) -> str | None:
    ip = canonical_ip(value)
    return None if ip is None else str(ipaddress.ip_network(ip))


def _banned_ranges(
    decisions: list[Decision], now: datetime, host_networks: frozenset[str] = frozenset()
) -> dict[str, BannedRangeView]:
    """Active Range decisions by canonical CIDR, keeping the strongest type on each.

    An Ip decision counts too when its address, as a /32 or /128, is one of
    ``host_networks``: ``_decision_target`` bans those networks as Ip
    decisions. Between two decisions of the same type the later expiry wins.
    """
    banned_ranges: dict[str, BannedRangeView] = {}
    for decision in decisions:
        if decision.expired:
            continue
        if decision.scope == "Range":
            cidr = _canonical_cidr(decision.value)
        elif decision.scope == "Ip":
            cidr = _host_cidr(decision.value)
            if cidr not in host_networks:
                continue
        else:
            continue
        if cidr is None:
            continue
        seconds_left = go_duration_seconds(decision.duration)
        expires_at = now + timedelta(seconds=seconds_left) if seconds_left > 0 else None
        current = banned_ranges.get(cidr)
        if current is not None:
            winning_type = decision_winner(current.type, decision.type)
            if winning_type != decision.type:
                continue
            if winning_type == current.type and (
                expires_at is None or (current.expires_at is not None and expires_at <= current.expires_at)
            ):
                continue
        banned_ranges[cidr] = BannedRangeView(value=cidr, type=decision.type, expires_at=expires_at)
    return banned_ranges


async def _active_banned_ranges(
    service: CrowdSecService, drop_snapshot: DropSnapshot
) -> dict[str, BannedRangeView]:
    """Range decisions, plus Ip decisions on the snapshot's single-address networks."""
    host_networks = drop_snapshot.host_networks
    decisions = await service.get_decisions(scopes="Range,Ip" if host_networks else "Range")
    return _banned_ranges(decisions, datetime.now(timezone.utc), host_networks)


async def _banned_ranges_if_reachable(
    service: CrowdSecService, drop_snapshot: DropSnapshot
) -> dict[str, BannedRangeView] | None:
    """Like ``_active_banned_ranges``, but None when the LAPI cannot be asked."""
    try:
        return await _active_banned_ranges(service, drop_snapshot)
    except CrowdSecError as exc:
        logger.warning("crowdsec_range_decisions_unavailable", error=str(exc))
        return None


@dataclass(frozen=True)
class _PendingNetworkBan:
    cidr: str
    scope: DecisionScope
    value: str
    reason: str


def _actor(request: Request) -> str:
    """The actor named in the audit log, or 'unknown' with auth disabled."""
    user = request.scope.get("user")
    if isinstance(user, AdminUser):
        return user.username
    if isinstance(user, ApiKeyPrincipal):
        return f"api-key:{user.name}"
    return "unknown"


class CrowdSecController(Controller):
    """CrowdSec decision views and ban statistics."""

    path = "/crowdsec"
    tags = ["CrowdSec"]
    dependencies = {
        "crowdsec": Provide(provide_crowdsec_service, sync_to_thread=False),
        "crowdsec_poller": Provide(provide_crowdsec_poller, sync_to_thread=False),
        "enrichment_repo": Provide(provide_security_enrichment_repo),
        "geoip": Provide(provide_geoip_locator, sync_to_thread=False),
        # Controller-scoped: /decisions paginates an in-memory LAPI result,
        # not an ORM query, so it keeps the hand-written provider.
        "limit_offset": Provide(provide_limit_offset_pagination, sync_to_thread=False),
        "drop_snapshot": Provide(provide_drop_snapshot),
        "drop_traffic_repo": Provide(provide_drop_traffic_repo),
    }

    @get(
        "/status",
        summary="Get the CrowdSec integration status",
        description=(
            "Returns whether the integration is on, whether bans and alerts are available, whether the LAPI "
            "answers and whether `/ws/crowdsec` streams changes. Unlike the other CrowdSec endpoints, it answers "
            "while the integration is off, with every field false."
        ),
    )
    async def get_status(
        self,
        crowdsec: NamedDependency[CrowdSecService | None],
        crowdsec_poller: NamedDependency[SkipValidation[CrowdSecStreamPoller | None]],
        settings: NamedDependency[SkipValidation[Settings]],
    ) -> CrowdSecStatusResponse:
        """Integration state; the frontend gates the security page on this."""
        if crowdsec is None:
            return CrowdSecStatusResponse(
                enabled=False, write_enabled=False, lapi_reachable=False
            )
        # The stream poller probes the LAPI every poll interval; its cached
        # verdict avoids a live ping per status request (which can block for
        # the full request timeout against a black-holed host). Live ping
        # remains the fallback when the poller is absent (DB-degraded or
        # scheduler-disabled mode) or has not completed a poll yet.
        cached: bool | None = (
            crowdsec_poller.lapi_reachable if crowdsec_poller is not None else None
        )
        return CrowdSecStatusResponse(
            enabled=True,
            write_enabled=settings.crowdsec.write_enabled,
            lapi_reachable=cached if cached is not None else await crowdsec.ping(),
            live_updates=crowdsec_poller is not None,
        )

    @get(
        "/decisions",
        summary="List active CrowdSec decisions, one row per target",
        description=(
            "Returns the active decisions grouped by target, in the order the LAPI lists them, paged with "
            "`currentPage` and `pageSize`. `total` counts targets, not decisions. The country, city and "
            "24-hour request count come from GeoMetrikks' own access logs of the last 30 days, and the GeoIP "
            "database fills in the place for an IP the logs do not locate."
        ),
    )
    async def list_decisions(
        self,
        crowdsec: NamedDependency[CrowdSecService | None],
        enrichment_repo: NamedDependency[SecurityEnrichmentRepository],
        geoip: NamedDependency[SkipValidation[GeoIpLocator | None]],
        limit_offset: NamedDependency[filters.LimitOffset],
        origins: Annotated[
            str | None,
            QueryParameter(
                required=False,
                description=(
                    "A comma-separated list of origins to keep, such as `crowdsec,cscli,CAPI`. Defaults to "
                    f"`{DEFAULT_ORIGINS}`, which leaves out the blocklists. An IP or CIDR in `q` ignores it."
                ),
            ),
        ] = None,
        q: Annotated[
            str | None,
            QueryParameter(
                required=False,
                max_length=200,
                description=(
                    "Search, up to 200 characters. An IP or CIDR matches decisions on addresses inside it and "
                    "ranges that hold it, across every origin. Other text matches the start of the target or "
                    "any part of a scenario name, ignoring case."
                ),
            ),
        ] = None,
    ) -> OffsetPagination[DecisionGroupView]:
        """Active decisions, one item per target, geo-enriched per displayed page.

        An IP that tripped several scenarios holds one decision for each;
        they are grouped before paging, so ``total`` counts targets.

        Pagination slices locally: the LAPI has no pagination of its own.
        Only the sliced page is enriched, so an opted-in CAPI blocklist
        (tens of thousands of decisions) never hits the database join.
        GeoLite2 fills in IPs that stored traffic has no country for.
        """
        service = _require_service(crowdsec)
        query = (q or "").strip()
        if query and search_network(query) is not None:
            # "Is this IP banned" has the same answer on every tab, so an IP or
            # range search reads every origin; the LAPI sends them all when
            # none are named, console and cscli-import included.
            decisions = await service.get_decisions()
        else:
            decisions = await service.get_decisions(origins=origins or DEFAULT_ORIGINS)
        groups = group_decisions(decisions)
        if query:
            groups = search_groups(groups, query)
        page = groups[limit_offset.offset : limit_offset.offset + limit_offset.limit]

        page_ips = [group.value for group in page if group.scope == "Ip"]
        enriched = await enrichment_repo.enrich(page_ips) if page_ips else {}
        enriched = _fill_from_geoip(enriched, page_ips, geoip)
        return OffsetPagination(
            items=[_to_group_view(group, enriched.get(group.value)) for group in page],
            limit=limit_offset.limit,
            offset=limit_offset.offset,
            total=len(groups),
        )

    @get(
        "/decisions/lookup",
        summary="List the active decisions that cover one IP",
        description=(
            "Returns every active decision on the IP, from any origin, including Range decisions that hold it. "
            "This endpoint does not look up places, so the country and city fields are null and "
            "`requestCount24h` is 0 on `Ip` decisions."
        ),
    )
    async def lookup_decisions(
        self,
        crowdsec: NamedDependency[CrowdSecService | None],
        ip: Annotated[
            str, QueryParameter(description="The IP to look up. A value that is not an IP gets a 400.")
        ],
    ) -> list[DecisionView]:
        """Decisions for one IP (log-row and map popovers, banned badges).

        No enrichment: the caller already has the row's geo context.
        """
        service = _require_service(crowdsec)
        validate_ip_address(ip)
        decisions = await service.get_decisions_for_ip(ip)
        return [_to_view(d, None) for d in decisions]

    @get(
        "/banned-ips",
        summary="List every IP under an active decision",
        description=(
            "Returns each IP that holds an `Ip` decision from any origin, once, with the strongest decision "
            "type on it. `ban` beats `captcha`, which beats the rest. `/banned-ranges` lists the Range "
            "decisions."
        ),
    )
    async def list_banned_ips(
        self, crowdsec: NamedDependency[CrowdSecService | None]
    ) -> list[BannedIp]:
        """Every IP under an active decision, with the type to badge it as.

        Feeds the frontend badge map: compact enough to ship even when a
        subscribed CAPI blocklist holds tens of thousands of decisions.
        """
        service = _require_service(crowdsec)
        decisions = await service.get_decisions()
        # An IP can hold several decisions (e.g. a local captcha plus a CAPI
        # ban); the dict keeps LAPI order and the strongest type wins.
        winners: dict[str, str] = {}
        for decision in decisions:
            if decision.scope != "Ip":
                continue
            ip = canonical_ip(decision.value)
            if ip is None:
                continue
            winners[ip] = decision_winner(winners.get(ip), decision.type)
        return [BannedIp(ip=ip, type=kind) for ip, kind in winners.items()]

    @get(
        "/banned-ranges",
        summary="List every range under an active decision",
        description=(
            "Returns each CIDR that holds a Range decision from any origin, once, with the strongest decision "
            "type on it and when that decision ends. GeoMetrikks bans a single-address DROP network with an "
            "`Ip` decision, so that network shows as its /32 or /128 while the decision lasts."
        ),
    )
    async def list_banned_ranges(
        self,
        crowdsec: NamedDependency[CrowdSecService | None],
        drop_snapshot: NamedDependency[SkipValidation[DropSnapshot]],
    ) -> list[BannedRangeView]:
        """Every CIDR under an active Range decision, with the type to show it as.

        A single-address DROP network is banned as an Ip decision, so it is
        listed as its /32 or /128 while that decision lasts.
        """
        service = _require_service(crowdsec)
        return list((await _active_banned_ranges(service, drop_snapshot)).values())

    @get(
        "/drop-networks",
        summary="List the traffic from DROP networks, with their bans",
        description=(
            "Returns each Spamhaus DROP network that sent requests in the window, busiest first, with the Range "
            "decision on it. The totals cover every network with traffic, not only the page. A client inside "
            "nested networks counts under the narrowest one. When the LAPI does not answer, you still get the "
            "traffic, with every `decision` null and `decisionsAvailable` false."
        ),
    )
    async def list_drop_networks(
        self,
        crowdsec: NamedDependency[CrowdSecService | None],
        drop_snapshot: NamedDependency[SkipValidation[DropSnapshot]],
        drop_traffic_repo: NamedDependency[SkipValidation[DropTrafficRepository]],
        days: Annotated[
            Literal[7, 30, 90],
            QueryParameter(description="The window in days, ending now. `7`, `30` or `90`. Defaults to 30."),
        ] = 30,
        page: Annotated[
            int, QueryParameter(ge=1, description="The page to return, counted from 1. Defaults to 1.")
        ] = 1,
        page_size: Annotated[
            int,
            QueryParameter(
                name="pageSize", ge=1, le=100, description="Networks per page, from 1 to 100. Defaults to 25."
            ),
        ] = 25,
    ) -> DropNetworksResponse:
        """Traffic from DROP-listed networks, busiest first, with each network's Range decision.

        The totals cover every network with traffic in the window, not only the
        page. ASN, organization and last-seen come from the raw access log;
        last-seen falls back to the newest CAGG bucket start when the raw rows
        have aged out. When the LAPI cannot be asked the endpoint still returns
        the traffic, with every decision null and decisionsAvailable false.
        """
        service = _require_service(crowdsec)
        if not drop_snapshot.networks_loaded:
            return DropNetworksResponse(
                loaded=False, days=days, total_networks=0, total_ips=0, total_hits=0,
                banned_networks=0, decisions_available=True, items=[],
            )
        end = datetime.now(timezone.utc)
        start = end - timedelta(days=days)
        all_drop_network_hits = await drop_traffic_repo.network_hits(start, end)
        reachable_banned_ranges = await _banned_ranges_if_reachable(service, drop_snapshot)
        banned_ranges = reachable_banned_ranges or {}
        page_drop_network_hits = all_drop_network_hits[(page - 1) * page_size : page * page_size]
        origins = await drop_traffic_repo.network_origins(
            [drop_network_hits.cidr for drop_network_hits in page_drop_network_hits], start, end
        )
        items = []
        for drop_network_hits in page_drop_network_hits:
            origin = origins.get(drop_network_hits.cidr)
            items.append(DropNetworkTrafficView(
                cidr=drop_network_hits.cidr,
                sbl_id=drop_network_hits.sbl_id,
                asn=origin.asn if origin else None,
                as_org=origin.as_org if origin else None,
                hits=drop_network_hits.hits,
                ips=drop_network_hits.ips,
                last_seen=origin.last_seen if origin else drop_network_hits.last_seen,
                decision=banned_ranges.get(drop_network_hits.cidr),
            ))
        return DropNetworksResponse(
            loaded=True,
            days=days,
            total_networks=len(all_drop_network_hits),
            total_ips=sum(drop_network_hits.ips for drop_network_hits in all_drop_network_hits),
            total_hits=sum(drop_network_hits.hits for drop_network_hits in all_drop_network_hits),
            banned_networks=sum(
                1 for drop_network_hits in all_drop_network_hits if drop_network_hits.cidr in banned_ranges
            ),
            decisions_available=reachable_banned_ranges is not None,
            items=items,
        )

    @get(
        "/banned-locations",
        summary="Map the IPs under an active decision as GeoJSON",
        description=(
            "Returns one GeoJSON point per place, listing the IPs that hold an active `Ip` decision of any "
            "origin and type and sent geo events from there in the window. The map shows current decisions, not "
            "ban history, and leaves out Range decisions and IPs without events in the window. Each IP shows at "
            "one place. Windows up to 24 hours, and any window with `serverIn`, read the raw rows and use the "
            "place of the IP's newest event. Longer windows read the per-IP aggregates and use its place in the "
            "newest bucket, the busiest one on a tie."
        ),
    )
    async def list_banned_locations(
        self,
        crowdsec: NamedDependency[CrowdSecService | None],
        enrichment_repo: NamedDependency[SecurityEnrichmentRepository],
        from_timestamp: Annotated[
            datetime | None,
            QueryParameter(
                name="fromTimestamp",
                description=(
                    "Start of the window, inclusive, as ISO 8601 with a timezone. Defaults to 30 days before now."
                ),
                required=False,
                examples=range_start_examples(),
            ),
        ] = None,
        to_timestamp: Annotated[
            datetime | None,
            QueryParameter(
                name="toTimestamp",
                description="End of the window, exclusive, as ISO 8601 with a timezone. Defaults to now.",
                required=False,
                examples=range_end_examples(),
            ),
        ] = None,
        country_code: CountryCodeFilter = None,
        city: CityFilter = None,
        server_in: ServerIn = None,
    ) -> BannedMapCollection:
        """GeoJSON of IPs under a current decision, seen in the traffic window.

        Every origin and remediation type counts, the same membership as the
        badge set. IPs at identical coordinates share one feature that lists
        all of them. This is current decision state, not ban history.
        """
        service = _require_service(crowdsec)
        decisions = await service.get_decisions()
        locations = await enrichment_repo.locations(
            active_decision_ips(decisions), start=from_timestamp, end=to_timestamp,
            country_codes=country_code, cities=city, servers=server_in,
        )
        return banned_map_collection(locations)

    @get(
        "/alerts",
        summary="List CrowdSec alerts, newest first",
        description=(
            "Returns one page of the LAPI's alert history, newest first, without the community blocklist "
            "pulls. Pass the `nextCursor` of one page as `before` to get the next, older one. An IP source "
            "without a country from the LAPI gets its place from GeoMetrikks' own traffic, then from the GeoIP "
            f"database. {MACHINE_CREDENTIALS_NOTE}"
        ),
        responses={
            HTTP_409_CONFLICT: ResponseSpec(
                data_container=ErrorEnvelope,
                description=(
                    "More alerts share the cursor's second than one LAPI request can "
                    "page past. Narrow the filters."
                ),
            ),
        },
    )
    async def list_alerts(
        self,
        crowdsec: NamedDependency[CrowdSecService | None],
        enrichment_repo: NamedDependency[SecurityEnrichmentRepository],
        geoip: NamedDependency[SkipValidation[GeoIpLocator | None]],
        settings: NamedDependency[SkipValidation[Settings]],
        limit: Annotated[
            int,
            QueryParameter(ge=1, le=500, required=False, description="Alerts per page, from 1 to 500. Defaults to 50."),
        ] = 50,
        ip: Annotated[
            str | None,
            QueryParameter(
                required=False,
                description=(
                    "Keep only alerts that hold a decision covering this IP. The filter excludes alerts on this "
                    "IP that have no decision. A value that is not an IP gets a 400."
                ),
            ),
        ] = None,
        scenarios: Annotated[
            list[str] | None,
            QueryParameter(
                name="scenario",
                required=False,
                description=(
                    "Keep only these scenarios, such as `crowdsecurity/http-probing`. Repeat the parameter for "
                    f"more than one, at most {MAX_ALERT_SCENARIOS}. With `kind=bot` it gets a 400."
                ),
            ),
        ] = None,
        since: Annotated[str | None, QueryParameter(required=False, description=SINCE_DESCRIPTION)] = None,
        kind: Annotated[
            str | None, QueryParameter(required=False, description=ALERT_KIND_DESCRIPTION)
        ] = None,
        has_active_decision: Annotated[
            bool | None,
            QueryParameter(
                name="hasActiveDecision",
                required=False,
                description=(
                    "`true` keeps alerts with a decision still in force, and `false` keeps alerts that hold no "
                    "decision, active or expired."
                ),
            ),
        ] = None,
        before: Annotated[
            str | None,
            QueryParameter(
                required=False,
                description=(
                    "The `nextCursor` of the previous page, to get the alerts older than it. A malformed cursor "
                    "gets a 400."
                ),
            ),
        ] = None,
    ) -> AlertPageView:
        """One page of alert history from the LAPI. Needs machine credentials.

        Newest first. ``nextCursor`` is set while older alerts may remain;
        passing it back as ``before`` returns the next page. A malformed
        cursor answers 400.

        The LAPI only geo-enriches alerts from log-parsing scenarios; manual
        bans carry a bare IP. Ip-scope sources without LAPI geo take it from
        GeoMetrikks' own stored traffic, then from GeoLite2. GeoLite2 also
        supplies the country name where the LAPI sends only a code.

        ``kind`` needs CrowdSec 1.7 or newer; an older LAPI answers 400.
        ``kind=bot`` merges the bot-detection rejections with the bans the
        bot challenge scenarios raise, and takes no ``scenario``.
        """
        service = _require_write(crowdsec, settings)
        if ip is not None:
            validate_ip_address(ip)
        if since is not None:
            _validate_duration(since)
        _validate_alert_kind(kind)
        picked_scenarios = tuple(dict.fromkeys(scenarios or ()))
        if kind == BOT_KIND_GROUP and picked_scenarios:
            raise DomainValidationError("The bot group can't be combined with a scenario filter")
        if len(picked_scenarios) > MAX_ALERT_SCENARIOS:
            raise DomainValidationError(f"Pick at most {MAX_ALERT_SCENARIOS} scenarios")
        cursor = None if before is None else decode_cursor(before)
        page = await fetch_alert_page(
            service,
            AlertFilters(
                ip=ip, scenarios=picked_scenarios, since=since, kind=kind,
                has_active_decision=has_active_decision,
            ),
            limit=limit,
            before=cursor,
        )

        bare_ips = [
            _enrichment_key(a) for a in page.alerts if a.source.scope == "Ip" and a.source.cn is None
        ]
        enriched = await enrichment_repo.enrich(bare_ips) if bare_ips else {}
        ip_sources = [_enrichment_key(a) for a in page.alerts if a.source.scope == "Ip"]
        enriched = _fill_from_geoip(enriched, ip_sources, geoip)

        return AlertPageView(
            alerts=[
                AlertView(**_alert_summary(alert, enriched.get(_enrichment_key(alert))))
                for alert in page.alerts
            ],
            next_cursor=page.next_cursor,
        )

    @get(
        "/alerts/scenarios",
        summary="Count the scenarios among recent CrowdSec alerts",
        description=(
            f"Returns the scenarios among the newest {SCENARIO_SAMPLE_SIZE} alerts that match `since` and `kind`, "
            "with how many of those alerts each one has, the most first. Scenarios with the same count sort by "
            f"name. {MACHINE_CREDENTIALS_NOTE}"
        ),
    )
    async def list_alert_scenarios(
        self,
        crowdsec: NamedDependency[CrowdSecService | None],
        settings: NamedDependency[SkipValidation[Settings]],
        since: Annotated[str | None, QueryParameter(required=False, description=SINCE_DESCRIPTION)] = None,
        kind: Annotated[
            str | None, QueryParameter(required=False, description=ALERT_KIND_DESCRIPTION)
        ] = None,
    ) -> list[ScenarioCount]:
        """Scenarios among the newest 500 alerts in the window, most frequent first.
        Needs machine credentials."""
        service = _require_write(crowdsec, settings)
        if since is not None:
            _validate_duration(since)
        _validate_alert_kind(kind)
        page = await fetch_alert_page(
            service,
            AlertFilters(since=since, kind=kind),
            limit=SCENARIO_SAMPLE_SIZE,
            before=None,
        )
        scenario_counts = Counter(alert.scenario for alert in page.alerts)
        return [
            ScenarioCount(scenario=scenario, count=count)
            for scenario, count in sorted(
                scenario_counts.items(), key=lambda scenario_count: (-scenario_count[1], scenario_count[0])
            )
        ]

    @get(
        "/alerts/{alert_id:int}",
        summary="Get one CrowdSec alert",
        description=(
            "Returns the alert with its context, the events the LAPI kept and its decisions, expired ones "
            f"included. {MACHINE_CREDENTIALS_NOTE}"
        ),
        responses={
            HTTP_404_NOT_FOUND: ResponseSpec(
                data_container=ErrorEnvelope, description="The LAPI holds no alert with this id."
            ),
        },
    )
    async def get_alert(
        self,
        crowdsec: NamedDependency[CrowdSecService | None],
        enrichment_repo: NamedDependency[SecurityEnrichmentRepository],
        geoip: NamedDependency[SkipValidation[GeoIpLocator | None]],
        settings: NamedDependency[SkipValidation[Settings]],
        alert_id: Annotated[int, PathParameter(description="The alert's `id`.")],
    ) -> AlertDetailView:
        """One alert with its context, stored events and decisions."""
        service = _require_write(crowdsec, settings)
        alert = await service.get_alert(alert_id)
        if alert is None:
            raise NotFoundException(detail=f"No CrowdSec alert with id {alert_id}")

        return await _alert_detail(alert, enrichment_repo, geoip)

    @get(
        "/decisions/{decision_id:int}/alert",
        summary="Get the CrowdSec alert behind a decision",
        description=(
            "Returns the alert that made the decision, in the same shape as `/alerts/{alert_id}`. The LAPI "
            "finds alerts by IP only, so pass the decision's IP too. This endpoint does not search the "
            f"community blocklist alerts, so a blocklist decision gets a 404. {MACHINE_CREDENTIALS_NOTE}"
        ),
        responses={
            HTTP_404_NOT_FOUND: ResponseSpec(
                data_container=ErrorEnvelope,
                description="None of the IP's alerts holds the decision. A blocklist decision always gets this.",
            ),
        },
    )
    async def get_decision_alert(
        self,
        crowdsec: NamedDependency[CrowdSecService | None],
        enrichment_repo: NamedDependency[SecurityEnrichmentRepository],
        geoip: NamedDependency[SkipValidation[GeoIpLocator | None]],
        settings: NamedDependency[SkipValidation[Settings]],
        decision_id: Annotated[int, PathParameter(description="The decision's `id`, as `/decisions` lists it.")],
        ip: Annotated[
            str,
            QueryParameter(description="The IP the decision targets. A value that is not an IP gets a 400."),
        ],
    ) -> AlertDetailView:
        """The alert that produced one decision.

        The LAPI cannot look an alert up by decision id, only by the IP its
        decisions target. The IP's alerts with a live decision are searched
        first, about one per scenario. A decision can expire between the
        table loading and the row being opened, so a miss falls back to
        every alert the LAPI retains for the IP. Blocklist decisions have no
        alert of their own and answer 404.
        """
        service = _require_write(crowdsec, settings)
        validate_ip_address(ip)
        for live_only in (True, None):
            # limit=0 lifts the LAPI's default cap of 100 alerts.
            alerts = await service.get_alerts(
                limit=0, ip=ip, scenario=None, since=None, has_active_decision=live_only
            )
            for alert in alerts:
                if any(decision.id == decision_id for decision in alert.decisions):
                    return await _alert_detail(alert, enrichment_repo, geoip)
        raise NotFoundException(detail=f"No CrowdSec alert holds decision {decision_id}")

    @post(
        "/ban",
        status_code=HTTP_204_NO_CONTENT,
        summary="Ban an IP or range through CrowdSec",
        description=(
            "Creates a `ban` or `captcha` decision with origin `geometrikks` on one IP or CIDR, and answers 204 "
            "with no body. The bouncers attached to the LAPI enforce it. A CIDR that covers every address gets a "
            f"400. {MACHINE_CREDENTIALS_NOTE} {WRITE_NOTE}"
        ),
    )
    async def ban(
        self,
        crowdsec: NamedDependency[CrowdSecService | None],
        data: JSONBody[BanRequest],
        request: Request,
        settings: NamedDependency[SkipValidation[Settings]],
    ) -> None:
        """Create a manual ban or captcha decision for one IP or range.

        Enforcement still depends on a bouncer attached to the LAPI.
        """
        service = _require_write(crowdsec, settings)
        scope, value = _decision_target(data.ip)
        duration = data.duration and _ban_duration(data.duration)
        reason = data.reason or manual_reason(data.type)
        await service.ban(
            value, scope=scope, decision_type=data.type, duration=duration, reason=reason
        )
        logger.info(
            "CrowdSec ban by %s: value=%s scope=%s type=%s duration=%s reason=%s",
            _actor(request),
            value,
            scope,
            data.type,
            duration or settings.crowdsec.default_ban_duration,
            reason,
        )

    @post(
        "/ban-networks",
        status_code=HTTP_200_OK,
        summary="Ban Spamhaus DROP networks through CrowdSec",
        description=(
            "Bans the DROP networks you name, or with `allUnbannedDays` every DROP network that sent traffic in "
            f"that many days and has no active decision, busiest first and at most {MAX_BULK_BAN_NETWORKS}. A network "
            "with an active decision of any type, a captcha included, keeps it and gets no ban, and a named one "
            "comes back ok with `alreadyBanned`, so a retry is safe. After "
            f"{BULK_BAN_UNREACHABLE_LIMIT} unreachable LAPI answers in a row or {BULK_BAN_TIME_LIMIT_SECONDS} "
            "seconds, the rest come back with an error that starts with "
            f"`not attempted`. {MACHINE_CREDENTIALS_NOTE} {WRITE_NOTE}"
        ),
    )
    async def ban_networks(
        self,
        crowdsec: NamedDependency[CrowdSecService | None],
        db_session: NamedDependency[AsyncSession],
        drop_snapshot: NamedDependency[SkipValidation[DropSnapshot]],
        drop_traffic_repo: NamedDependency[SkipValidation[DropTrafficRepository]],
        data: JSONBody[BanNetworksRequest],
        request: Request,
        settings: NamedDependency[SkipValidation[Settings]],
    ) -> BanNetworksResponse:
        """Ban DROP networks, reporting every network's outcome.

        Each ban takes the scope ``/ban`` gives the same value, so a
        single-address network becomes an Ip decision.

        Name the networks, or set allUnbannedDays to ban every DROP network
        with traffic in that window and no active ban. That form bans the
        busiest MAX_BULK_BAN_NETWORKS and leftOut counts the rest. A network
        that is not on the DROP list or whose ban fails gets an error result
        and the loop goes on. A named network that is already banned (a Range
        decision, or an Ip decision on a single-address network) is not banned
        again. It comes back ok with alreadyBanned set, so a retry is safe.

        The run stops after BULK_BAN_UNREACHABLE_LIMIT bans in a row find the
        LAPI unreachable, or after BULK_BAN_TIME_LIMIT_SECONDS. Every network
        left comes back with ok false and a "not attempted" error.
        """
        service = _require_write(crowdsec, settings)
        if (data.networks is None) == (data.all_unbanned_days is None):
            raise DomainValidationError("Send either networks or allUnbannedDays, not both and not neither")
        duration = _ban_duration(data.duration)
        deadline = _bulk_ban_clock() + BULK_BAN_TIME_LIMIT_SECONDS
        mode = "networks" if data.networks is not None else "allUnbannedDays"
        ban_results: list[BanNetworkResult] = []
        left_out = 0
        completed = False
        stop_reason: str | None = None
        try:
            if data.networks is not None:
                requested_networks = data.networks
                # An unreachable LAPI is reported by the bans themselves.
                banned_ranges = await _banned_ranges_if_reachable(service, drop_snapshot) or {}
            else:
                requested_networks = []
                banned_ranges = {}
                if drop_snapshot.networks_loaded:
                    end = datetime.now(timezone.utc)
                    start = end - timedelta(days=data.all_unbanned_days or 0)
                    banned_ranges = await _active_banned_ranges(service, drop_snapshot)
                    unbanned_networks = [
                        drop_network_hits.cidr
                        for drop_network_hits in await drop_traffic_repo.network_hits(start, end)
                        if drop_network_hits.cidr not in banned_ranges
                    ]
                    requested_networks = unbanned_networks[:MAX_BULK_BAN_NETWORKS]
                    left_out = len(unbanned_networks) - len(requested_networks)

            sbl_ids_by_cidr = {network.cidr: network.sbl_id for network in drop_snapshot.networks}
            seen_networks: set[str] = set()
            planned_bans: list[BanNetworkResult | _PendingNetworkBan] = []
            for requested_network in requested_networks:
                cidr = _canonical_cidr(requested_network)
                if cidr is None:
                    planned_bans.append(BanNetworkResult(
                        network=requested_network, ok=False, error="Not a valid network", already_banned=False
                    ))
                    continue
                if cidr in seen_networks:
                    continue
                seen_networks.add(cidr)
                sbl_id = sbl_ids_by_cidr.get(cidr)
                if sbl_id is None:
                    planned_bans.append(BanNetworkResult(
                        network=cidr, ok=False, error="Not on the DROP list", already_banned=False
                    ))
                    continue
                if cidr in banned_ranges:
                    planned_bans.append(BanNetworkResult(network=cidr, ok=True, error=None, already_banned=True))
                    continue
                scope, value = _decision_target(cidr)
                planned_bans.append(_PendingNetworkBan(
                    cidr=cidr, scope=scope, value=value, reason=f"Spamhaus DROP {sbl_id}"
                ))

            # Ending the read transaction hands the pooled connection back
            # before the LAPI loop, which can run for minutes.
            await db_session.rollback()

            unreachable_in_a_row = 0
            for planned_ban in planned_bans:
                if isinstance(planned_ban, BanNetworkResult):
                    ban_results.append(planned_ban)
                    continue
                if stop_reason is None:
                    if unreachable_in_a_row >= BULK_BAN_UNREACHABLE_LIMIT:
                        stop_reason = "crowdsec_unreachable"
                    elif _bulk_ban_clock() >= deadline:
                        stop_reason = "time_limit"
                if stop_reason is not None:
                    ban_results.append(BanNetworkResult(
                        network=planned_ban.cidr, ok=False,
                        error=BULK_BAN_NOT_ATTEMPTED_ERRORS[stop_reason], already_banned=False,
                    ))
                    continue
                try:
                    await service.ban(
                        planned_ban.value, scope=planned_ban.scope, decision_type="ban", duration=duration,
                        reason=planned_ban.reason,
                    )
                except CrowdSecError as exc:
                    unreachable_in_a_row = unreachable_in_a_row + 1 if isinstance(exc, CrowdSecUnreachableError) else 0
                    ban_results.append(BanNetworkResult(
                        network=planned_ban.cidr, ok=False, error=str(exc), already_banned=False
                    ))
                else:
                    unreachable_in_a_row = 0
                    ban_results.append(BanNetworkResult(
                        network=planned_ban.cidr, ok=True, error=None, already_banned=False
                    ))
            completed = True
        finally:
            already_banned_count = sum(1 for ban_result in ban_results if ban_result.already_banned)
            not_attempted_errors = set(BULK_BAN_NOT_ATTEMPTED_ERRORS.values())
            logger.info(
                "crowdsec_bulk_ban",
                actor=_actor(request),
                mode=mode,
                duration=duration,
                completed=completed,
                stop_reason=stop_reason,
                requested=len(ban_results),
                ok=sum(1 for ban_result in ban_results if ban_result.ok) - already_banned_count,
                already_banned=already_banned_count,
                failed=sum(1 for ban_result in ban_results if not ban_result.ok),
                not_attempted=sum(1 for ban_result in ban_results if ban_result.error in not_attempted_errors),
                left_out=left_out,
            )
        return BanNetworksResponse(results=ban_results, left_out=left_out)

    @post(
        "/unban",
        status_code=HTTP_200_OK,
        summary="Unban an IP or range through CrowdSec",
        description=(
            "Deletes every active decision on exactly that IP or range, from any origin, and returns how many it "
            "deleted. An IP keeps a Range decision that covers it, so unban the range for that. "
            f"{MACHINE_CREDENTIALS_NOTE} {WRITE_NOTE}"
        ),
    )
    async def unban(
        self,
        crowdsec: NamedDependency[CrowdSecService | None],
        data: JSONBody[UnbanRequest],
        request: Request,
        settings: NamedDependency[SkipValidation[Settings]],
    ) -> UnbanResponse:
        """Delete all active decisions on one IP or range.

        An IP keeps any wider Range decision that covers it.
        """
        service = _require_write(crowdsec, settings)
        scope, value = _decision_target(data.ip)
        deleted = await service.unban(value, scope=scope)
        logger.info(
            "CrowdSec unban by %s: value=%s scope=%s deleted=%d",
            _actor(request), value, scope, deleted,
        )
        return UnbanResponse(deleted=deleted)

    @get(
        "/stats",
        summary="Count the active CrowdSec decisions by origin and scenario",
        description=(
            "Returns how many decisions are active across every origin, blocklists included, with the count per "
            "origin and the ten scenarios with the most decisions."
        ),
    )
    async def get_stats(
        self, crowdsec: NamedDependency[CrowdSecService | None]
    ) -> CrowdSecStatsResponse:
        """Decision counts by origin and top scenarios, across all origins."""
        service = _require_service(crowdsec)
        decisions = await service.get_decisions()
        origin_counts = Counter(d.origin for d in decisions)
        scenario_counts = Counter(d.scenario for d in decisions)
        return CrowdSecStatsResponse(
            total=len(decisions),
            by_origin=[
                OriginCount(origin=origin, count=count)
                for origin, count in origin_counts.most_common()
            ],
            top_scenarios=[
                ScenarioCount(scenario=scenario, count=count)
                for scenario, count in scenario_counts.most_common(TOP_SCENARIO_LIMIT)
            ],
        )
