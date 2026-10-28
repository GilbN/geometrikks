"""On-demand GeoLite2 City lookups for IPs GeoMetrikks has no traffic for."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from geoip2.database import Reader
from geoip2.errors import GeoIP2Error
from maxminddb import InvalidDatabaseError

from geometrikks.server.logging import get_logger

logger = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class GeoIpPlace:
    country_code: str | None
    country_name: str | None
    city: str | None


class GeoIpLocator:
    """Looks IPs up in the City database, opening it fresh for each call.

    It doesn't borrow ingestion's readers. A head node may run with ingestion
    disabled, and a fresh open always sees the file the weekly refresh last
    swapped in.
    """

    def __init__(self, db_path: Path | str, locales: list[str]) -> None:
        self.db_path = db_path
        self.locales = locales

    def locate(self, ips: Iterable[str]) -> dict[str, GeoIpPlace]:
        """Place for each IP the database knows, keyed by the IP as given.

        IPs it has no record for, and values that are not IPs, are absent.
        An unreadable database returns an empty dict.
        """
        places: dict[str, GeoIpPlace] = {}
        try:
            with Reader(self.db_path, locales=self.locales) as reader:
                for ip in ips:
                    try:
                        city = reader.city(ip)
                    except (GeoIP2Error, ValueError):
                        continue
                    places[ip] = GeoIpPlace(
                        country_code=city.country.iso_code,
                        country_name=city.country.name,
                        city=city.city.name,
                    )
        except (OSError, InvalidDatabaseError) as exc:
            logger.warning("geoip_locate_failed", path=str(self.db_path), error=str(exc))
            return {}
        return places
