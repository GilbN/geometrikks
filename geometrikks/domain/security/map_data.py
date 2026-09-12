"""Builds the banned-IP map response from one location per IP, grouped by exact coordinates."""
from __future__ import annotations

from math import isfinite

from geometrikks.domain.geo.dtos import GeoJSONPointGeometry
from geometrikks.domain.security.schemas import (
    BannedMapCollection,
    BannedMapFeature,
    BannedMapIp,
    BannedMapProperties,
    BannedMapStats,
    IpLocation,
)
from geometrikks.lib.validation import canonical_ip
from geometrikks.services.crowdsec import Decision


def active_decision_ips(decisions: list[Decision]) -> list[str]:
    """Distinct addresses under any IP-scoped decision, in canonical text form.

    Every remediation type counts, the same membership ``/banned-ips`` serves
    for the badges; the popup shows the type per decision. Skips Range,
    Country and AS scopes, which need matching work of their own.
    """
    ips: dict[str, None] = {}
    for decision in decisions:
        if decision.scope != "Ip":
            continue
        ip = canonical_ip(decision.value)
        if ip is not None:
            ips[ip] = None
    return list(ips)


_DECISION_RANK = {"ban": 0, "captcha": 1}


def decision_winner(current: str | None, candidate: str) -> str:
    """The type to show when an IP holds several decisions: ban, then captcha,
    then any bouncer-defined name in sorted order."""
    if current is None:
        return candidate
    return min(current, candidate, key=lambda kind: (_DECISION_RANK.get(kind, 2), kind))


def banned_map_collection(locations: list[IpLocation]) -> BannedMapCollection:
    """Group one row per IP by exact coordinates; MapLibre clusters nearby groups."""
    groups: dict[tuple[float, float], list[BannedMapIp]] = {}
    for location in locations:
        lon, lat = location.longitude, location.latitude
        if not (isfinite(lon) and isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90):
            continue
        # -0.0 hashes with 0.0 but would format differently in the group ID.
        coordinates = (lon or 0.0, lat or 0.0)
        groups.setdefault(coordinates, []).append(BannedMapIp(
            ip=location.ip, location_id=location.location_id,
            city=location.city, country_code=location.country_code,
            event_count=location.event_count,
        ))
    features = []
    for coordinates, ips in sorted(groups.items()):
        group_id = f"{coordinates[0]},{coordinates[1]}"
        ips.sort(key=lambda item: (-item.event_count, item.ip))
        features.append(BannedMapFeature(
            type="Feature", id=group_id,
            geometry=GeoJSONPointGeometry(type="Point", coordinates=coordinates),
            properties=BannedMapProperties(group_id=group_id, ip_count=len(ips), banned_ips=ips),
        ))
    mapped = [ip for group in groups.values() for ip in group]
    return BannedMapCollection(
        type="FeatureCollection", features=features,
        stats=BannedMapStats(
            ips=len(mapped),
            locations=len(features),
            events=sum(ip.event_count for ip in mapped),
            countries=len({ip.country_code for ip in mapped if ip.country_code}),
            cities=len({ip.city for ip in mapped if ip.city}),
        ),
    )
