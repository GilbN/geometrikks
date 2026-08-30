"""CrowdSec Local API client service.

Read path authenticates with the bouncer API key; the write path (ban/unban)
logs in as a machine (watcher) and holds the JWT for the client lifetime,
re-logging in once when it expires.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import httpx2
import msgspec

from geometrikks.config.settings import CrowdSecSettings
from geometrikks.server.logging import get_logger
from geometrikks.services.crowdsec.exceptions import (
    CrowdSecAuthError,
    CrowdSecError,
    CrowdSecUnavailableError,
)
from geometrikks.services.crowdsec.schemas import Alert, Decision, DecisionStreamDelta

logger = get_logger(__name__)


class CrowdSecService:
    """Async client for the CrowdSec Local API.

    Owns one ``httpx2.AsyncClient`` for the process lifetime; constructed at
    startup only when the integration is enabled and closed on shutdown.
    """

    def __init__(
        self,
        settings: CrowdSecSettings,
        *,
        transport: httpx2.AsyncBaseTransport | None = None,
    ) -> None:
        if settings.lapi_url is None or settings.bouncer_api_key is None:
            raise CrowdSecAuthError(
                "CrowdSec service requires CROWDSEC_LAPI_URL and CROWDSEC_BOUNCER_API_KEY"
            )
        self._settings = settings
        self._bouncer_headers = {"X-Api-Key": settings.bouncer_api_key.get_secret_value()}
        self._client = httpx2.AsyncClient(
            base_url=settings.lapi_url,
            timeout=settings.request_timeout,
            verify=settings.verify_tls,
            transport=transport,
        )
        self._machine_token: str | None = None
        logger.info(
            "crowdsec_client_configured",
            url=settings.lapi_url,
            write_enabled=settings.write_enabled,
        )

    async def aclose(self) -> None:
        await self._client.aclose()
        logger.info("crowdsec_client_closed")

    async def get_decisions(
        self,
        *,
        ip: str | None = None,
        origins: str | None = None,
        scopes: str | None = None,
        type_: str | None = None,
    ) -> list[Decision]:
        """List active decisions. ``origins``/``scopes`` are comma-separated.

        Raises:
            CrowdSecAuthError: The LAPI rejected the bouncer API key.
            CrowdSecUnavailableError: The LAPI is unreachable or errored.
        """
        params = {
            key: value
            for key, value in {
                "ip": ip, "origins": origins, "scopes": scopes, "type": type_,
            }.items()
            if value is not None
        }
        try:
            resp = await self._client.get(
                "/v1/decisions", headers=self._bouncer_headers, params=params
            )
            resp.raise_for_status()
        except httpx2.HTTPStatusError as exc:
            if exc.response.status_code in (401, 403):
                raise CrowdSecAuthError("LAPI rejected the bouncer API key") from exc
            raise CrowdSecUnavailableError(
                f"LAPI error: HTTP {exc.response.status_code}"
            ) from exc
        except httpx2.HTTPError as exc:
            raise CrowdSecUnavailableError(f"LAPI unreachable: {exc}") from exc
        # The LAPI returns JSON null when no decisions match.
        return msgspec.convert(resp.json() or [], list[Decision], strict=False)

    async def get_decisions_for_ip(self, ip: str) -> list[Decision]:
        """Active decisions for a single IP (log-row / map popovers)."""
        return await self.get_decisions(ip=ip)

    async def get_decisions_stream(self, *, startup: bool) -> DecisionStreamDelta:
        """Poll the decision stream: decisions added/expired since last call.

        The LAPI tracks stream state per bouncer key; ``startup=True`` on the
        first call returns the full current state instead of a delta.

        Raises:
            CrowdSecAuthError: The LAPI rejected the bouncer API key.
            CrowdSecUnavailableError: The LAPI is unreachable or errored.
        """
        params = {"startup": "true"} if startup else {}
        try:
            resp = await self._client.get(
                "/v1/decisions/stream", headers=self._bouncer_headers, params=params
            )
            resp.raise_for_status()
        except httpx2.HTTPStatusError as exc:
            if exc.response.status_code in (401, 403):
                raise CrowdSecAuthError("LAPI rejected the bouncer API key") from exc
            raise CrowdSecUnavailableError(
                f"LAPI error: HTTP {exc.response.status_code}"
            ) from exc
        except httpx2.HTTPError as exc:
            raise CrowdSecUnavailableError(f"LAPI unreachable: {exc}") from exc
        body = resp.json() or {}
        # Both keys are JSON null when nothing changed.
        return DecisionStreamDelta(
            new=msgspec.convert(body.get("new") or [], list[Decision], strict=False),
            deleted=msgspec.convert(body.get("deleted") or [], list[Decision], strict=False),
        )

    async def ping(self) -> bool:
        """Reachability probe for the status endpoint; never raises."""
        try:
            await self.get_decisions(ip="127.0.0.1")
            return True
        except CrowdSecError:
            return False

    # -- write path (machine JWT) --------------------------------------

    async def _login(self) -> str:
        password = self._settings.machine_password
        if not self._settings.write_enabled or password is None:
            raise CrowdSecAuthError(
                "Ban/unban requires CROWDSEC_MACHINE_ID and CROWDSEC_MACHINE_PASSWORD"
            )
        try:
            resp = await self._client.post(
                "/v1/watchers/login",
                json={
                    "machine_id": self._settings.machine_id,
                    "password": password.get_secret_value(),
                },
            )
            if resp.status_code in (401, 403):
                raise CrowdSecAuthError("LAPI rejected the machine credentials")
            resp.raise_for_status()
        except httpx2.HTTPError as exc:
            raise CrowdSecUnavailableError(f"LAPI unreachable: {exc}") from exc
        self._machine_token = resp.json()["token"]
        logger.info("Logged in to CrowdSec LAPI as machine %s", self._settings.machine_id)
        return self._machine_token

    async def _machine_request(self, method: str, url: str, **kwargs: Any) -> httpx2.Response:
        token = self._machine_token or await self._login()
        try:
            resp = await self._client.request(
                method, url, headers={"Authorization": f"Bearer {token}"}, **kwargs
            )
            if resp.status_code == 401:  # token expired -> re-login once
                logger.info("CrowdSec machine token expired; re-authenticating")
                token = await self._login()
                resp = await self._client.request(
                    method, url, headers={"Authorization": f"Bearer {token}"}, **kwargs
                )
            if resp.status_code in (401, 403):
                raise CrowdSecAuthError("LAPI rejected the machine token")
            resp.raise_for_status()
            return resp
        except httpx2.HTTPStatusError as exc:
            raise CrowdSecUnavailableError(
                f"LAPI error: HTTP {exc.response.status_code}"
            ) from exc
        except httpx2.HTTPError as exc:
            raise CrowdSecUnavailableError(f"LAPI unreachable: {exc}") from exc

    async def ban_ip(
        self,
        ip: str,
        *,
        duration: str | None = None,
        reason: str = "manual ban from GeoMetrikks",
    ) -> None:
        """Create a manual ban decision via an alert on POST /v1/alerts.

        Raises:
            CrowdSecAuthError: Machine credentials missing or rejected.
            CrowdSecUnavailableError: The LAPI is unreachable or errored.
        """
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        alert = {
            "scenario": "geometrikks/manual-ban",
            "scenario_hash": "",
            "scenario_version": "",
            "message": reason,
            "events_count": 1,
            "events": [],
            "capacity": 0,
            "leakspeed": "0",
            "remediation": True,
            "simulated": False,
            "start_at": now,
            "stop_at": now,
            "source": {"scope": "Ip", "value": ip, "ip": ip},
            "decisions": [
                {
                    "type": "ban",
                    "scope": "Ip",
                    "value": ip,
                    "duration": duration or self._settings.default_ban_duration,
                    "origin": "geometrikks",
                    "scenario": f"geometrikks/manual-ban: {reason}",
                    "simulated": False,
                }
            ],
        }
        await self._machine_request("POST", "/v1/alerts", json=[alert])

    async def get_alerts(
        self,
        *,
        limit: int = 50,
        ip: str | None = None,
        scenario: str | None = None,
        since: str | None = None,
    ) -> list[Alert]:
        """Recent alerts from the LAPI; requires machine credentials.

        ``since`` is a Go duration string (e.g. ``24h``) relative to now.

        Raises:
            CrowdSecAuthError: Machine credentials missing or rejected.
            CrowdSecUnavailableError: The LAPI is unreachable or errored.
        """
        params = {
            key: value
            for key, value in {
                "limit": limit, "ip": ip, "scenario": scenario, "since": since,
            }.items()
            if value is not None
        }
        resp = await self._machine_request("GET", "/v1/alerts", params=params)
        alerts = msgspec.convert(resp.json() or [], list[dict], strict=False)
        # decisions is JSON null on alerts whose decisions all expired
        for alert in alerts:
            alert["decisions"] = alert.get("decisions") or []
        return msgspec.convert(alerts, list[Alert], strict=False)

    async def unban_ip(self, ip: str) -> int:
        """Delete all active decisions for an IP; returns the number deleted.

        Raises:
            CrowdSecAuthError: Machine credentials missing or rejected.
            CrowdSecUnavailableError: The LAPI is unreachable or errored.
        """
        resp = await self._machine_request("DELETE", "/v1/decisions", params={"ip": ip})
        # The LAPI types nbDeleted as a string ("2"); int() handles both.
        return int(resp.json().get("nbDeleted", 0))
