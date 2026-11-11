"""The throwaway CrowdSec LAPI: container arguments, alert payloads and a small client.

The container runs offline on an internal Docker network and publishes no
port; the host reaches it at the container's own address. See README.md,
"CrowdSec fixture facts", for the LAPI behaviour these payloads rely on.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from itertools import cycle
from typing import Final

import asyncpg
import httpx2
from pydantic import SecretStr

from geometrikks.config.settings import CrowdSecSettings
from geometrikks.services.crowdsec.service import CrowdSecService
from tests.screenshots.fixture_ips import PROBE_PATHS, FixtureError, FixtureIps, IpStats
from tests.screenshots.teardown import RUN_LABEL

CROWDSEC_IMAGE: Final[str] = "crowdsecurity/crowdsec:v1.8.1"
BOUNCER_NAME: Final = "geometrikks"
MACHINE_ID: Final = "geometrikks-shots"
CONTAINER: Final = "geometrikks-shots-crowdsec"
NETWORK: Final = "geometrikks-shots-net"
LAPI_PORT: Final = 8080
DATA_VOLUME: Final = "/var/lib/crowdsec/data"
OFFLINE_ENV: Final[tuple[str, ...]] = ("DISABLE_ONLINE_API=true", "DISABLE_AGENT=true", "NO_HUB_UPGRADE=true")

ACTIVE_DURATIONS: Final[tuple[str, ...]] = ("4h", "12h", "24h", "48h", "168h")
EXPIRED_DURATION: Final = "1s"
MANUAL_REASON: Final = "Repeated probing"
CAPTCHA_DURATION: Final = "4h"
RANGE_BAN_DURATION: Final = "24h"

SCENARIO_CAPACITY: Final = 10
SCENARIO_LEAKSPEED: Final = "10s"
READY_POLL_SECONDS: Final = 0.25


def network_args(*, run_id: str) -> list[str]:
    return ["docker", "network", "create", "--internal", "--label", f"{RUN_LABEL}={run_id}", NETWORK]


def container_args(*, run_id: str, bouncer_key: str) -> list[str]:
    env = [*OFFLINE_ENV, f"BOUNCER_KEY_{BOUNCER_NAME}={bouncer_key}"]
    return [
        "docker", "run", "-d",
        "--name", CONTAINER,
        "--label", f"{RUN_LABEL}={run_id}",
        "--memory", "512m",
        "--network", NETWORK,
        # The entrypoint exits at once unless this directory is a mount.
        "-v", DATA_VOLUME,
        *[arg for pair in env for arg in ("-e", pair)],
        CROWDSEC_IMAGE,
    ]


def lapi_url(container_ip: str) -> str:
    return f"http://{container_ip}:{LAPI_PORT}"


def scenario_for(paths: Collection[str]) -> str:
    if any("wp-" in path for path in paths):
        return "crowdsecurity/http-wordpress-scan"
    if any(path.startswith(("/.env", "/.git")) for path in paths):
        return "crowdsecurity/http-sensitive-files"
    if any("admin" in path for path in paths):
        return "crowdsecurity/http-admin-interface-probing"
    return "crowdsecurity/http-probing"


@dataclass(frozen=True, slots=True)
class EventRow:
    timestamp: datetime
    url: str
    method: str
    status: int
    user_agent: str | None


def _rfc3339(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _go_time(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S +0000 UTC")


def _distinct(values: Iterable[str]) -> list[str]:
    return sorted(set(values))


def alert_payload(
    stats: IpStats,
    events: Sequence[EventRow],
    *,
    scenario: str,
    duration: str | None,
    stop_at: datetime | None = None,
) -> dict[str, object]:
    """One alert as a CrowdSec agent posts it; ``stop_at`` defaults to the newest event.

    The LAPI expires a decision at ``stop_at`` plus its duration, so a ban
    that must still be active at capture passes the build time as ``stop_at``.
    """
    if not events:
        raise ValueError(f"an alert for {stats.ip} needs at least one event")
    ordered = sorted(events, key=lambda event: event.timestamp)
    start = ordered[0].timestamp
    stop = stop_at or ordered[-1].timestamp
    span = int((ordered[-1].timestamp - start).total_seconds())

    source: dict[str, object] = {"scope": "Ip", "value": stats.ip, "ip": stats.ip}
    if stats.asn is not None:
        source["as_number"] = str(stats.asn)
    if stats.asn_org is not None:
        source["as_name"] = stats.asn_org
    if stats.country_code is not None:
        source["cn"] = stats.country_code
    if stats.latitude is not None and stats.longitude is not None:
        source["latitude"] = stats.latitude
        source["longitude"] = stats.longitude

    event_payloads = []
    for event in ordered:
        meta = [
            {"key": "target_uri", "value": event.url},
            {"key": "method", "value": event.method},
            {"key": "status", "value": str(event.status)},
        ]
        if event.user_agent is not None:
            meta.append({"key": "http_user_agent", "value": event.user_agent})
        event_payloads.append({"timestamp": _rfc3339(event.timestamp), "meta": meta})

    context = [{"key": "target_uri", "value": json.dumps(_distinct(event.url for event in ordered))}]
    user_agents = _distinct(event.user_agent for event in ordered if event.user_agent is not None)
    if user_agents:
        context.append({"key": "user_agent", "value": json.dumps(user_agents)})

    decisions: list[dict[str, object]] = []
    if duration is not None:
        decisions.append(
            {
                "type": "ban",
                "scope": "Ip",
                "value": stats.ip,
                "duration": duration,
                "origin": "crowdsec",
                "scenario": scenario,
                "simulated": False,
            }
        )
    return {
        "scenario": scenario,
        "scenario_hash": "",
        "scenario_version": "",
        "message": f"Ip {stats.ip} performed '{scenario}' ({len(ordered)} events over {span}s) at {_go_time(stop)}",
        "events_count": len(ordered),
        "events": event_payloads,
        "meta": context,
        "capacity": SCENARIO_CAPACITY,
        "leakspeed": SCENARIO_LEAKSPEED,
        "remediation": duration is not None,
        "simulated": False,
        "start_at": _rfc3339(start),
        "stop_at": _rfc3339(stop),
        "source": source,
        "decisions": decisions,
    }


def fixture_alerts(
    fixture: FixtureIps,
    stats: Mapping[str, IpStats],
    events: Mapping[str, Sequence[EventRow]],
    *,
    now: datetime | None = None,
) -> list[dict[str, object]]:
    """Active bans (seed, then DROP), expired bans, then detections. ``now`` is the active bans' ``stop_at``."""
    built_at = now or datetime.now(UTC)

    def alert(ip: str, duration: str | None, stop_at: datetime | None) -> dict[str, object]:
        rows = events.get(ip)
        if not rows:
            raise FixtureError(f"no logged requests for {ip}; load_events must cover every fixture IP")
        return alert_payload(
            stats[ip], rows, scenario=scenario_for([row.url for row in rows]), duration=duration, stop_at=stop_at
        )

    durations = cycle(ACTIVE_DURATIONS)
    alerts = [alert(ip, next(durations), built_at) for ip in (*fixture.active_bans, *fixture.drop_bans)]
    alerts += [alert(ip, EXPIRED_DURATION, None) for ip in fixture.expired_bans]
    alerts += [alert(ip, None, None) for ip in fixture.detections]
    return alerts


EVENTS_SQL: Final = """
SELECT ip, timestamp, url, method, status_code, user_agent
FROM (
    SELECT
        host(ip_address) AS ip, timestamp, url, method, status_code, user_agent,
        row_number() OVER (
            PARTITION BY ip_address ORDER BY (url = ANY($2::text[])) DESC, timestamp DESC, id DESC
        ) AS rank
    FROM access_logs
    WHERE ip_address = ANY($1::inet[]) AND url IS NOT NULL AND method IS NOT NULL
) ranked
WHERE rank <= $3
ORDER BY ip, timestamp
"""


async def load_events(conn: asyncpg.Connection, ips: Collection[str], per_ip: int = 6) -> dict[str, list[EventRow]]:
    """Each IP's newest probe requests, or its newest plain ones when it never probed."""
    rows = await conn.fetch(EVENTS_SQL, list(ips), sorted(PROBE_PATHS), per_ip)
    events: dict[str, list[EventRow]] = {}
    for row in rows:
        events.setdefault(row["ip"], []).append(
            EventRow(
                timestamp=row["timestamp"],
                url=row["url"],
                method=row["method"],
                status=row["status_code"],
                user_agent=row["user_agent"],
            )
        )
    return events


def foreign_decisions(values: Iterable[str], fixture: FixtureIps) -> list[str]:
    """Decision values the fixtures did not create; any one means the run sees a LAPI it does not own."""
    known = fixture.all_ips()
    return [value for value in values if value not in known and value != fixture.range_ban]


def crowdsec_settings(container_ip: str, *, bouncer_key: str, machine_id: str, password: str) -> CrowdSecSettings:
    """Settings for the app's own client: every field explicit and no dotenv, so no outside CROWDSEC_* value applies."""
    return CrowdSecSettings(
        _env_file=None,
        lapi_url=lapi_url(container_ip),
        bouncer_api_key=SecretStr(bouncer_key),
        machine_id=machine_id,
        machine_password=SecretStr(password),
        default_ban_duration=CAPTCHA_DURATION,
        request_timeout=10.0,
        verify_tls=True,
        stream_poll_interval=15.0,
    )


async def apply_manual_decisions(service: CrowdSecService, fixture: FixtureIps) -> None:
    """The captcha and the range ban, made the way the UI makes them."""
    await service.ban(
        fixture.captcha, decision_type="captcha", duration=CAPTCHA_DURATION, reason=MANUAL_REASON
    )
    await service.ban(fixture.range_ban, scope="Range", duration=RANGE_BAN_DURATION, reason=MANUAL_REASON)


class LapiClient:
    def __init__(self, base_url: str, *, transport: httpx2.AsyncBaseTransport | None = None) -> None:
        self._base_url = base_url
        self._client = httpx2.AsyncClient(
            base_url=base_url, timeout=10.0, follow_redirects=False, trust_env=False, transport=transport
        )
        self._token: str | None = None

    async def login(self, machine_id: str, password: str) -> None:
        response = await self._client.post(
            "/v1/watchers/login", json={"machine_id": machine_id, "password": password, "scenarios": []}
        )
        response.raise_for_status()
        self._token = response.json()["token"]

    async def post_alerts(self, alerts: Sequence[dict[str, object]]) -> None:
        if self._token is None:
            raise RuntimeError("post_alerts needs a machine login first")
        response = await self._client.post(
            "/v1/alerts", json=list(alerts), headers={"Authorization": f"Bearer {self._token}"}
        )
        response.raise_for_status()
        created = response.json()
        if not isinstance(created, list) or len(created) != len(alerts):
            raise RuntimeError(f"the LAPI stored {created!r} for {len(alerts)} alerts")

    async def decision_values(self, bouncer_key: str) -> list[str]:
        response = await self._client.get("/v1/decisions", headers={"X-Api-Key": bouncer_key})
        response.raise_for_status()
        # An empty list comes back as JSON null.
        return [str(decision["value"]) for decision in response.json() or []]

    async def wait_ready(self, bouncer_key: str, timeout: float = 60) -> None:
        """Wait until /health answers up and the bouncer key reads decisions."""
        deadline = time.monotonic() + timeout
        last_error = "no answer"
        while True:
            try:
                health = await self._client.get("/health")
                if health.status_code == 200 and health.json().get("status") == "up":
                    await self.decision_values(bouncer_key)
                    return
                last_error = f"/health answered {health.status_code}"
            except (httpx2.HTTPError, ValueError) as error:
                last_error = f"{type(error).__name__}: {error}"
            if time.monotonic() >= deadline:
                raise TimeoutError(f"the LAPI at {self._base_url} was not ready after {timeout:g}s ({last_error})")
            await asyncio.sleep(READY_POLL_SECONDS)

    async def aclose(self) -> None:
        await self._client.aclose()
