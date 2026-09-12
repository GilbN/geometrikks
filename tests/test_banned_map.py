"""Complete map membership and stable coordinate groups."""
from geometrikks.domain.security.map_data import banned_map_collection
from geometrikks.domain.security.schemas import IpLocation


def location(ip, longitude=0.0, latitude=0.0, location_id=1, city="Oslo", country_code="NO", event_count=1):
    return IpLocation(ip=ip, location_id=location_id, longitude=longitude, latitude=latitude,
                      city=city, country_code=country_code, event_count=event_count)


def test_coincident_ips_are_complete_and_stable():
    rows = [location(f"192.0.2.{i}", location_id=i, event_count=i % 3) for i in range(1, 26)]
    collection = banned_map_collection(rows)
    assert collection.stats.ips == 25
    assert collection.stats.locations == 1
    feature = collection.features[0]
    assert feature.id == feature.properties.group_id == "0.0,0.0"
    assert feature.properties.ip_count == 25
    assert {ip.location_id for ip in feature.properties.banned_ips} == set(range(1, 26))
    assert collection == banned_map_collection(list(reversed(rows)))
    assert feature.geometry.coordinates == (0.0, 0.0)
    # Busiest first, then by address: the popup lists them in this order.
    assert [(ip.event_count, ip.ip) for ip in feature.properties.banned_ips[:3]] == [
        (2, "192.0.2.11"), (2, "192.0.2.14"), (2, "192.0.2.17"),
    ]
    assert feature.properties.banned_ips[-1].ip == "192.0.2.9"


def test_valid_coordinates_and_distinct_groups():
    collection = banned_map_collection([
        location("192.0.2.1", -79.9746, 32.8608, city="Charleston", country_code="US", event_count=40),
        location("192.0.2.2", 181), location("192.0.2.3", latitude=float("nan")),
        location("192.0.2.4", 10, 59, city=None, event_count=2),
    ])
    assert collection.stats.ips == 2
    assert collection.stats.locations == 2
    assert collection.stats.events == 42
    assert collection.stats.countries == 2
    assert collection.stats.cities == 1
    assert collection.features[0].geometry.coordinates == (-79.9746, 32.8608)
