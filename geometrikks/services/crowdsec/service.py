"""CrowdSec Local API client service (read path, bouncer API key)."""
from __future__ import annotations

import logging

import httpx
import msgspec

from geometrikks.config.settings import CrowdSecSettings
from geometrikks.services.crowdsec.exceptions import (
    CrowdSecAuthError,
    CrowdSecError,
    CrowdSecUnavailableError,
)
from geometrikks.services.crowdsec.schemas import Decision

logger = logging.getLogger(__name__)


class CrowdSecService:
    """Async client for the CrowdSec Local API.

    Owns one ``httpx.AsyncClient`` for the process lifetime; constructed at
    startup only when the integration is enabled and closed on shutdown.
    """

    def __init__(
        self,
        settings: CrowdSecSettings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if settings.lapi_url is None or settings.bouncer_api_key is None:
            raise CrowdSecAuthError(
                "CrowdSec service requires CROWDSEC_LAPI_URL and CROWDSEC_BOUNCER_API_KEY"
            )
        self._settings = settings
        self._bouncer_headers = {"X-Api-Key": settings.bouncer_api_key.get_secret_value()}
        self._client = httpx.AsyncClient(
            base_url=settings.lapi_url,
            timeout=settings.request_timeout,
            verify=settings.verify_tls,
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

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
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code in (401, 403):
                raise CrowdSecAuthError("LAPI rejected the bouncer API key") from exc
            raise CrowdSecUnavailableError(
                f"LAPI error: HTTP {exc.response.status_code}"
            ) from exc
        except httpx.HTTPError as exc:
            raise CrowdSecUnavailableError(f"LAPI unreachable: {exc}") from exc
        # The LAPI returns JSON null when no decisions match.
        return msgspec.convert(resp.json() or [], list[Decision], strict=False)

    async def get_decisions_for_ip(self, ip: str) -> list[Decision]:
        """Active decisions for a single IP (log-row / map popovers)."""
        return await self.get_decisions(ip=ip)

    async def ping(self) -> bool:
        """Reachability probe for the status endpoint; never raises."""
        try:
            await self.get_decisions(ip="127.0.0.1")
            return True
        except CrowdSecError:
            return False
