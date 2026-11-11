"""Screenshot fixtures: seed picks, documentation-range DROP visitors, LAPI payloads and DROP feeds."""
from __future__ import annotations

import asyncio
import dataclasses
import json
import random
import re
import sys
from datetime import UTC, datetime, timedelta
from ipaddress import IPv4Address, IPv6Address, ip_address, ip_network
from pathlib import Path
from typing import Any

import httpx2
import pytest

from geometrikks.config.settings import CrowdSecSettings
from geometrikks.domain.analytics.asn_classification import (
    classify_asn,
    hosting_asn_entries,
)
from geometrikks.domain.drop.feeds import FEED_URLS, parse_asn_feed, parse_network_feed
from geometrikks.domain.drop.snapshot import DropAsnEntry, DropSnapshot
from geometrikks.services.crowdsec.service import CrowdSecService
from tests.screenshots.doc_traffic import (
    DOC_AS_NAME,
    DOC_ASN,
    DOC_BANS,
    DOC_DROP_NETWORKS,
    DOC_INSPECT_IP,
    DOC_USER_AGENTS,
    DOC_VISITORS,
    HOME_AS_NAME,
    HOME_ASN,
    HOME_LEAD,
    HOME_MIN_REQUESTS,
    HOME_NETWORKS,
    HOME_USER_AGENTS,
    HOME_VISITORS,
    HOME_WINDOW_START,
    doc_traffic,
    doc_visitors,
    home_requests_for,
    home_traffic,
    home_visitors,
    is_documentation,
    overlaps_home_network,
)
from tests.screenshots.drop import (
    FILLER_V4_NETWORK,
    FILLER_V6_NETWORK,
    FIXTURE_COPYRIGHT,
    feed_bodies,
    fixture_transport,
)
from tests.screenshots.fixture_ips import (
    PROBE_PATHS,
    FixtureError,
    IpStats,
    pick_fixture_ips,
)
from tests.screenshots.lapi import (
    ACTIVE_DURATIONS,
    CROWDSEC_IMAGE,
    EXPIRED_DURATION,
    MANUAL_REASON,
    NETWORK,
    EventRow,
    LapiClient,
    alert_payload,
    apply_manual_decisions,
    container_args,
    crowdsec_settings,
    fixture_alerts,
    foreign_decisions,
    lapi_url,
    network_args,
    scenario_for,
)
from tests.seed.catalog import BROWSER_USER_AGENTS, CRAWLER_PATHS, SITES
from tests.seed.config import SeedConfig

NOW = datetime(2026, 11, 11, 12, 0, tzinfo=UTC)
CRIME_WORDS = ("spam", "crime", "malware", "botnet", "hijack")


def scanners(n: int) -> list[IpStats]:
    return [IpStats(f"10.1.0.{i}", 1000 - i, 1000 - i, 5, "NL", "Amsterdam", 14061, "Example", 100 + i, 52.0, 4.0) for i in range(n)]


def people(n: int) -> list[IpStats]:
    return [IpStats(f"10.2.0.{i}", 5000 - i, 5000 - i, 0, "NO", "Oslo", 2119, "Example", 200 + i, 59.9, 10.7) for i in range(n)]


def docs() -> list[IpStats]:
    scanners = [IpStats(ip, 80 - i, 80 - i, 3, None, None, DOC_ASN, DOC_AS_NAME, None, None, None) for i, ip in enumerate(DOC_VISITORS)]
    homes = [IpStats(ip, 900 - i, 900 - i, 0, None, None, HOME_ASN, HOME_AS_NAME, None, None, None) for i, ip in enumerate(HOME_VISITORS)]
    return scanners + homes


def capture_browser_ip() -> IPv4Address | IPv6Address:
    capture = (Path(__file__).parent / "screenshots" / "capture.shots.ts").read_text()
    header = re.search(r'"X-Forwarded-For": "([^"]+)"', capture)
    assert header, "capture.shots.ts no longer sends X-Forwarded-For"
    return ip_address(header[1])


CAPTURE_BROWSER_IP = capture_browser_ip()
DROP_FIXTURE_RANGES = ("198.51.100.0/24", "203.0.113.0/24", "2001:db8:d0c::/48")


ALL_STATS = scanners(30) + people(5) + docs()
fixture = pick_fixture_ips(ALL_STATS)
stats_by_ip = {stats.ip: stats for stats in ALL_STATS}
stat = stats_by_ip[fixture.active_bans[0]]
events = [
    EventRow(NOW - timedelta(minutes=40), "/.env", "GET", 404, "curl/8.7.1"),
    EventRow(NOW - timedelta(minutes=45), "/wp-login.php", "GET", 404, None),
    EventRow(NOW - timedelta(minutes=50), "/phpmyadmin/index.php", "GET", 403, "curl/8.7.1"),
]
events_by_ip = {ip: events for ip in fixture.all_ips()}


def as_json(payload: object) -> Any:
    return json.loads(json.dumps(payload))


def test_pick_is_deterministic_and_disjoint() -> None:
    stats = scanners(30) + people(5) + docs()
    picked = pick_fixture_ips(list(reversed(stats)))
    assert picked == pick_fixture_ips(stats)
    assert picked.active_bans[0] == "10.1.0.0" and len(picked.active_bans) == 10
    assert not set(picked.active_bans) & (set(picked.expired_bans) | set(picked.detections))
    assert picked.range_ban == "10.1.0.0/24" and picked.focus_location == 200


def test_drop_and_inspect_come_only_from_documentation_visitors() -> None:
    picked = pick_fixture_ips(scanners(30) + people(5) + docs())
    assert picked.drop_networks == DOC_DROP_NETWORKS and picked.drop_bans == DOC_BANS
    assert picked.inspect_ip == DOC_INSPECT_IP and DOC_INSPECT_IP in picked.drop_bans
    assert all(is_documentation(cidr) for cidr in picked.drop_networks)
    seed_picks = {*picked.active_bans, *picked.expired_bans, *picked.detections, picked.captcha}
    assert not seed_picks & set(DOC_VISITORS)


def test_no_documentation_visitor_sits_in_a_filler_network() -> None:
    fillers = [ip_network(FILLER_V4_NETWORK), ip_network(FILLER_V6_NETWORK)]
    assert not [ip for ip in DOC_VISITORS for net in fillers if ip_address(ip).version == net.version and ip_address(ip) in net]


def test_pick_skips_a_busy_scanner_quiet_in_the_last_7_days() -> None:
    stale = IpStats("10.1.0.250", 99_999, 0, 50, "NL", "Amsterdam", 14061, "Example", 999, 52.0, 4.0)
    picked = pick_fixture_ips(scanners(30) + people(5) + docs() + [stale])
    assert "10.1.0.250" not in picked.all_ips() and picked.active_bans[0] == "10.1.0.0"


def test_focus_skips_a_busier_country_level_visitor_for_a_city_location() -> None:
    country_level = dataclasses.replace(people(1)[0], ip="10.2.1.1", recent_requests=90_000, city=None, location_id=300)
    blank_city = dataclasses.replace(people(1)[0], ip="10.2.1.2", recent_requests=80_000, city=" ", location_id=301)
    picked = pick_fixture_ips(scanners(30) + people(5) + docs() + [country_level, blank_city])
    assert picked.focus_location == 200


def test_focus_skips_a_location_a_scanner_shares() -> None:
    shared = dataclasses.replace(people(1)[0], ip="10.2.1.1", recent_requests=90_000, location_id=105)
    picked = pick_fixture_ips(scanners(30) + people(5) + docs() + [shared])
    assert picked.focus_location == 200


def test_focus_ranks_locations_by_their_summed_recent_traffic() -> None:
    crowd = [
        dataclasses.replace(people(1)[0], ip=f"10.2.2.{i}", recent_requests=3_000, location_id=400) for i in range(2)
    ]
    picked = pick_fixture_ips(scanners(30) + people(5) + docs() + crowd)
    assert picked.focus_location == 400


def test_focus_breaks_a_tie_by_location_id() -> None:
    tied = [dataclasses.replace(person, recent_requests=100) for person in people(3)]
    assert pick_fixture_ips(scanners(30) + list(reversed(tied)) + docs()).focus_location == 200


def test_focus_needs_a_city_level_location() -> None:
    countries = [dataclasses.replace(person, city=None) for person in people(5)]
    with pytest.raises(FixtureError, match="city.*--rows"):
        pick_fixture_ips(scanners(30) + countries + docs())


def test_pick_needs_22_scanners() -> None:
    with pytest.raises(FixtureError, match="21 scanners"):
        pick_fixture_ips(scanners(21) + people(3) + docs())


def test_pick_needs_an_ipv4_scanner_for_the_range_ban() -> None:
    v6 = [dataclasses.replace(s, ip=f"fd00:1::{i}") for i, s in enumerate(scanners(30)[21:])]
    with pytest.raises(FixtureError, match="--rows"):
        pick_fixture_ips(scanners(21) + v6 + people(3) + docs())


def test_pick_needs_traffic_from_every_documentation_visitor() -> None:
    with pytest.raises(FixtureError, match="2001:db8:d0c::9e"):
        pick_fixture_ips(scanners(30) + people(5) + [s for s in docs() if s.ip != "2001:db8:d0c::9e"])


def test_pick_refuses_a_placed_or_renamed_documentation_visitor() -> None:
    placed = [dataclasses.replace(s, country_code="US", location_id=7) if s.ip == DOC_INSPECT_IP else s for s in docs()]
    with pytest.raises(FixtureError, match="198.51.100.14"):
        pick_fixture_ips(scanners(30) + people(5) + placed)
    renamed = [dataclasses.replace(s, asn=14061) if s.ip == "203.0.113.23" else s for s in docs()]
    with pytest.raises(FixtureError, match="203.0.113.23"):
        pick_fixture_ips(scanners(30) + people(5) + renamed)


def test_probe_paths_hold_nothing_a_browser_or_crawler_requests() -> None:
    # Browsers fetch /favicon.ico and crawlers /robots.txt; counting those as
    # probes would rank busy browsers and real crawler ranges as scanners.
    ordinary = {path for pages in SITES.values() for path, _ in pages} | {path for path, _ in CRAWLER_PATHS}
    assert PROBE_PATHS and not PROBE_PATHS & ordinary
    assert {"/.env", "/wp-login.php", "/phpmyadmin/index.php"} <= PROBE_PATHS


def test_is_documentation() -> None:
    assert is_documentation("198.51.100.14") and is_documentation("2001:db8:d0c::5/128")
    assert is_documentation("203.0.113.0/24") and is_documentation("192.0.2.0/24")
    assert not is_documentation("198.51.100.0/23")
    assert not is_documentation("8.8.8.8") and not is_documentation("2001:db9::/32")
    assert not is_documentation("not an address")


def test_doc_user_agents_name_no_organization() -> None:
    assert (None, 20) in DOC_USER_AGENTS
    assert all(ua is None or "://" not in ua for ua, _ in DOC_USER_AGENTS)
    visitors = doc_visitors(random.Random(3))
    assert [v.ip for v in visitors] == list(DOC_VISITORS)
    assert all(v.kind == "scanner" and v.resolved.asn == DOC_ASN for v in visitors)


def test_doc_traffic_stays_in_documentation_space_and_the_window() -> None:
    config = SeedConfig(rows=4000, seed=7, servers=("edge", "homelab"))
    batch = doc_traffic(config, now=NOW, rng=random.Random(1))
    rows = batch.access_logs + [log for log, _ in batch.linked]
    assert {row.ip_address for row in rows} == set(DOC_VISITORS) and batch.geo_events == []
    assert all(row.autonomous_system_number == DOC_ASN and row.autonomous_system_organization == DOC_AS_NAME for row in rows)
    assert all(row.country_code is None and row.country_name is None and row.city is None for row in rows)
    assert all(NOW - timedelta(days=6) <= row.timestamp <= NOW - timedelta(hours=2) for row in rows)
    assert all("://" not in (row.user_agent or "") for row in rows)
    assert {row.url for row in rows} & PROBE_PATHS and any(debug.parse_error for _, debug in batch.linked)
    assert all(debug.country_code is None and debug.city is None for _, debug in batch.linked)
    assert all(row.timestamp.microsecond == 0 for row in rows)


def test_doc_traffic_is_reproducible() -> None:
    config = SeedConfig(rows=4000, seed=7, servers=("edge", "homelab"))
    first = doc_traffic(config, now=NOW, rng=random.Random(1))
    second = doc_traffic(config, now=NOW, rng=random.Random(1))
    assert first == second


def test_home_visitors_sit_in_their_own_documentation_ranges() -> None:
    home = [ip_network(net) for net in HOME_NETWORKS]
    assert all(is_documentation(net) for net in HOME_NETWORKS)
    assert all(any(ip_address(ip) in net for net in home if net.version == ip_address(ip).version) for ip in HOME_VISITORS)
    assert len(set(HOME_VISITORS)) == len(HOME_VISITORS) and not set(HOME_VISITORS) & set(DOC_VISITORS)
    assert not [net for net in HOME_NETWORKS for drop in DROP_FIXTURE_RANGES if ip_network(net).overlaps(ip_network(drop))]
    assert not [ip for ip in DOC_VISITORS if overlaps_home_network(ip)]
    assert not overlaps_home_network(str(CAPTURE_BROWSER_IP))


def test_home_asn_is_a_documentation_asn_that_reads_as_neither_hosting_nor_drop() -> None:
    assert 64496 <= HOME_ASN <= 64511 and HOME_ASN != DOC_ASN
    assert HOME_ASN not in {asn for asn, _ in hosting_asn_entries()}
    fixture_snapshot = DropSnapshot(asns=(DropAsnEntry(asn=DOC_ASN, name=DOC_AS_NAME, country_code=None),))
    assert classify_asn(HOME_ASN, fixture_snapshot) == "other"
    assert classify_asn(DOC_ASN, fixture_snapshot) == "drop"


def test_home_user_agents_are_browsers_that_name_no_organization() -> None:
    assert HOME_USER_AGENTS and set(HOME_USER_AGENTS) <= set(BROWSER_USER_AGENTS)
    assert all(ua.startswith("Mozilla/5.0 (") and "://" not in ua for ua, _ in HOME_USER_AGENTS)
    visitors = home_visitors(random.Random(3))
    assert [v.ip for v in visitors] == list(HOME_VISITORS)
    assert all(v.kind == "browser" and v.resolved.asn == HOME_ASN and v.resolved.asn_org == HOME_AS_NAME for v in visitors)
    assert all(v.resolved.place.country_code == "" and v.resolved.place.city is None for v in visitors)


def test_home_traffic_looks_like_home_browsers_inside_the_shots_range() -> None:
    config = SeedConfig(rows=4000, seed=7, servers=("edge", "homelab"))
    batch = home_traffic(config, now=NOW, rng=random.Random(1), requests=3000)
    rows = batch.access_logs + [log for log, _ in batch.linked]
    assert len(rows) == 3000 and batch.geo_events == [] and batch.orphan_debug == []
    assert {row.ip_address for row in rows} == set(HOME_VISITORS)
    assert all(row.autonomous_system_number == HOME_ASN and row.autonomous_system_organization == HOME_AS_NAME for row in rows)
    assert all(row.country_code is None and row.country_name is None and row.city is None for row in rows)
    assert all(NOW - HOME_WINDOW_START <= row.timestamp <= NOW - timedelta(hours=2) for row in rows)
    assert HOME_WINDOW_START < timedelta(days=7)
    assert {row.user_agent for row in rows} <= {ua for ua, _ in HOME_USER_AGENTS}
    assert not {row.url for row in rows} & PROBE_PATHS
    assert all(debug.parse_error is None and not debug.is_malformed for _, debug in batch.linked)
    assert sum(200 <= row.status_code < 300 for row in rows) / len(rows) > 0.75
    assert all(row.timestamp.microsecond == 0 for row in rows)
    busiest = max(sum(row.ip_address == ip for row in rows) for ip in HOME_VISITORS)
    assert busiest < len(rows) / 4
    per_day = [sum(NOW - timedelta(days=d + 1) <= row.timestamp < NOW - timedelta(days=d) for row in rows) for d in range(7)]
    assert min(per_day) > 0 and max(per_day[:6]) < 2 * min(per_day[:6])


def test_home_traffic_is_reproducible() -> None:
    config = SeedConfig(rows=4000, seed=7, servers=("edge", "homelab"))
    first = home_traffic(config, now=NOW, rng=random.Random(1), requests=500)
    assert first == home_traffic(config, now=NOW, rng=random.Random(1), requests=500)


def test_home_requests_lead_the_busiest_other_network() -> None:
    assert home_requests_for(0) == HOME_MIN_REQUESTS == 6000
    assert home_requests_for(4090) == 6135 and HOME_LEAD == 1.5
    assert home_requests_for(9001) >= 9001 * HOME_LEAD


def test_pick_never_takes_a_home_visitor() -> None:
    busy = [dataclasses.replace(s, recent_requests=90_000) if s.ip in HOME_VISITORS else s for s in docs()]
    picked = pick_fixture_ips(scanners(30) + people(5) + busy)
    assert not picked.all_ips() & set(HOME_VISITORS)
    assert picked == pick_fixture_ips(scanners(30) + people(5) + docs())


@pytest.mark.parametrize(
    "change",
    [
        {"country_code": "NO", "location_id": 7, "city": "Oslo"},
        {"asn": 749},
        {"asn_org": "Example"},
        {"probe_hits": 2},
        {"recent_requests": 0},
    ],
)
def test_pick_refuses_a_home_visitor_that_is_placed_renamed_probing_or_quiet(change: dict[str, Any]) -> None:
    home = HOME_VISITORS[4]
    changed = [dataclasses.replace(s, **change) if s.ip == home else s for s in docs()]
    with pytest.raises(FixtureError, match=re.escape(home)):
        pick_fixture_ips(scanners(30) + people(5) + changed)


def test_scenario_for() -> None:
    assert scenario_for(["/wp-login.php"]) == "crowdsecurity/http-wordpress-scan"
    assert scenario_for(["/.env"]) == "crowdsecurity/http-sensitive-files"
    assert scenario_for(["/phpmyadmin/"]) == "crowdsecurity/http-admin-interface-probing"
    assert scenario_for(["/cgi-bin/x"]) == "crowdsecurity/http-probing"


def test_alert_payload_with_and_without_decision() -> None:
    ban = as_json(alert_payload(stat, events, scenario="crowdsecurity/http-probing", duration="4h"))
    assert ban["decisions"][0].items() >= {"type": "ban", "scope": "Ip", "value": stat.ip, "duration": "4h", "origin": "crowdsec"}.items()
    assert ban["source"]["value"] == stat.ip and ban["remediation"] is True
    detection = alert_payload(stat, events, scenario="crowdsecurity/http-probing", duration=None)
    assert detection["decisions"] == [] and detection["remediation"] is False


def test_alert_payload_shape() -> None:
    alert = as_json(alert_payload(stat, events, scenario="crowdsecurity/http-probing", duration="4h"))
    assert alert["start_at"] == "2026-11-11T11:10:00Z" and alert["stop_at"] == "2026-11-11T11:20:00Z"
    assert alert["message"] == (
        f"Ip {stat.ip} performed 'crowdsecurity/http-probing' (3 events over 600s) at 2026-11-11 11:20:00 +0000 UTC"
    )
    assert alert["events_count"] == 3 and "created_at" not in alert
    meta = {pair["key"]: json.loads(pair["value"]) for pair in alert["meta"]}
    assert meta == {
        "target_uri": ["/.env", "/phpmyadmin/index.php", "/wp-login.php"],
        "user_agent": ["curl/8.7.1"],
    }
    first_event = alert["events"][0]
    assert first_event["timestamp"] == "2026-11-11T11:10:00Z"
    assert {pair["key"]: pair["value"] for pair in first_event["meta"]} == {
        "target_uri": "/phpmyadmin/index.php",
        "method": "GET",
        "status": "403",
        "http_user_agent": "curl/8.7.1",
    }
    source = alert["source"]
    assert source == {"scope": "Ip", "value": stat.ip, "ip": stat.ip, "as_number": "14061", "as_name": "Example",
                      "cn": "NL", "latitude": 52.0, "longitude": 4.0}


def test_alert_payload_stop_at_override_keeps_the_ban_active() -> None:
    alert = as_json(alert_payload(stat, events, scenario="crowdsecurity/http-probing", duration="4h", stop_at=NOW))
    assert alert["start_at"] == "2026-11-11T11:10:00Z" and alert["stop_at"] == "2026-11-11T12:00:00Z"


def test_alert_payload_needs_events() -> None:
    with pytest.raises(ValueError, match=stat.ip):
        alert_payload(stat, [], scenario="crowdsecurity/http-probing", duration=None)


def test_alerts_carry_no_place_for_documentation_visitors_and_no_crime_wording() -> None:
    alert = as_json(alert_payload(docs()[3], events, scenario=scenario_for([e.url for e in events]), duration="4h"))
    source = alert["source"]
    assert not {"cn", "latitude", "longitude"} & set(source)
    assert source["as_number"] == "64496" and source["as_name"] == DOC_AS_NAME
    for fixture_alert in fixture_alerts(fixture, stats_by_ip, events_by_ip):
        text = json.dumps(fixture_alert).lower()
        assert not any(word in text for word in CRIME_WORDS)
        assert str(fixture_alert["scenario"]).startswith("crowdsecurity/http-")


def test_fixture_alerts_keep_active_bans_active_and_expire_the_rest() -> None:
    alerts = as_json(fixture_alerts(fixture, stats_by_ip, events_by_ip, now=NOW))
    by_ip = {alert["source"]["value"]: alert for alert in alerts}
    assert len(alerts) == len(by_ip) == 10 + len(DOC_BANS) + 6 + 4
    active = [*fixture.active_bans, *fixture.drop_bans]
    assert [alert["source"]["value"] for alert in alerts[: len(active)]] == active
    for index, ip in enumerate(active):
        assert by_ip[ip]["stop_at"] == "2026-11-11T12:00:00Z"
        assert by_ip[ip]["decisions"][0]["duration"] == ACTIVE_DURATIONS[index % len(ACTIVE_DURATIONS)]
    for ip in fixture.expired_bans:
        assert by_ip[ip]["stop_at"] == "2026-11-11T11:20:00Z"
        assert by_ip[ip]["decisions"][0]["duration"] == EXPIRED_DURATION
    for ip in fixture.detections:
        assert by_ip[ip]["decisions"] == [] and by_ip[ip]["remediation"] is False
    assert fixture.captcha not in by_ip


def test_fixture_alerts_need_events_for_every_ip() -> None:
    missing = {ip: rows for ip, rows in events_by_ip.items() if ip != fixture.drop_bans[1]}
    with pytest.raises(FixtureError, match=fixture.drop_bans[1]):
        fixture_alerts(fixture, stats_by_ip, missing, now=NOW)


def test_container_runs_offline_on_the_internal_network() -> None:
    args = container_args(run_id="r1", bouncer_key="k")
    for flag in ("DISABLE_ONLINE_API=true", "DISABLE_AGENT=true", "NO_HUB_UPGRADE=true", "BOUNCER_KEY_geometrikks=k"):
        assert flag in args
    assert args[args.index("--network") + 1] == NETWORK and "-p" not in args
    assert "--memory" in args and CROWDSEC_IMAGE in args
    assert network_args(run_id="r1")[:4] == ["docker", "network", "create", "--internal"]


def test_container_args_carry_the_data_volume_and_run_label() -> None:
    args = container_args(run_id="r1", bouncer_key="k")
    assert args[args.index("-v") + 1] == "/var/lib/crowdsec/data"
    assert args[args.index("--memory") + 1] == "512m"
    assert args[args.index("--label") + 1] == "geometrikks.screenshots.run=r1"
    assert args[-1] == CROWDSEC_IMAGE == "crowdsecurity/crowdsec:v1.8.1"
    assert not [arg for arg in args if arg.startswith(("--publish", "-P"))]
    assert network_args(run_id="r1")[-3:] == ["--label", "geometrikks.screenshots.run=r1", NETWORK]


def test_lapi_url() -> None:
    assert lapi_url("172.24.0.2") == "http://172.24.0.2:8080"


def test_foreign_decisions_flags_unknown_values() -> None:
    assert foreign_decisions([fixture.active_bans[0], fixture.range_ban, "8.8.8.8"], fixture) == ["8.8.8.8"]


def test_feed_bodies_parse_with_the_app_parsers() -> None:
    bodies = feed_bodies(DOC_DROP_NETWORKS, now=NOW)
    v4, meta = parse_network_feed(bodies["v4"], "v4")
    assert {r.cidr for r in v4} == {"198.51.100.14/32", "203.0.113.0/24", "192.0.2.64/26"} and meta.copyright == FIXTURE_COPYRIGHT
    v6, _ = parse_network_feed(bodies["v6"], "v6")
    assert {r.cidr for r in v6} == {"2001:db8:d0c::5/128", "2001:db8:ffff::/48"}
    asns, _ = parse_asn_feed(bodies["asn"])
    assert [(a.asn, a.name) for a in asns] == [(64496, "Fictional Example Hosting")]
    assert meta.timestamp == NOW
    assert all(r.sbl_id.startswith("SBLDEMO") for r in [*v4, *v6])


def test_feed_bodies_refuse_a_network_outside_documentation_space() -> None:
    with pytest.raises(ValueError, match="100.64.0.0/24"):
        feed_bodies(["198.51.100.14/32", "100.64.0.0/24"], now=NOW)


@pytest.mark.parametrize("network", ["192.0.2.0/24", "192.0.2.131/32", "2001:db8:b0b::/48", "2001:db8::/32"])
def test_feed_bodies_refuse_a_network_over_the_home_ranges(network: str) -> None:
    with pytest.raises(ValueError, match="AS64497"):
        feed_bodies(["198.51.100.14/32", network], now=NOW)


def test_drop_feeds_never_reach_the_home_visitors_or_the_capture_browser() -> None:
    bodies = feed_bodies(DOC_DROP_NETWORKS, now=NOW)
    v4, _ = parse_network_feed(bodies["v4"], "v4")
    v6, _ = parse_network_feed(bodies["v6"], "v6")
    asns, _ = parse_asn_feed(bodies["asn"])
    listed = [ip_network(record.cidr) for record in [*v4, *v6]]
    assert not [str(net) for net in listed if overlaps_home_network(str(net))]
    assert not [str(net) for net in listed if CAPTURE_BROWSER_IP in net]
    assert [a.asn for a in asns] == [DOC_ASN] and HOME_ASN != DOC_ASN


@pytest.mark.anyio
async def test_fixture_transport_answers_only_the_feed_urls() -> None:
    bodies = feed_bodies(DOC_DROP_NETWORKS, now=NOW)
    async with httpx2.AsyncClient(transport=fixture_transport(bodies)) as client:
        for feed, url in FEED_URLS.items():
            response = await client.get(url)
            assert response.status_code == 200 and response.content == bodies[feed]
        assert (await client.get("https://www.spamhaus.org/drop/other.json")).status_code == 404
        assert (await client.get("https://example.com/drop_v4.json")).status_code == 404


class FakeLapi:
    """Stands in for the LAPI: records requests, answers like CrowdSec v1.8.1."""

    def __init__(self, *, refuse_first: int = 0, decisions: list[dict[str, object]] | None = None) -> None:
        self.requests: list[httpx2.Request] = []
        self.refuse_first = refuse_first
        self.decisions = decisions

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        if self.refuse_first:
            self.refuse_first -= 1
            raise httpx2.ConnectError("connection refused", request=request)
        path = request.url.path
        if path == "/health":
            return httpx2.Response(200, json={"status": "up"})
        if path == "/v1/watchers/login":
            return httpx2.Response(200, json={"code": 200, "expire": "2026-11-11T13:00:00Z", "token": "jwt"})
        if path == "/v1/alerts" and request.method == "POST":
            if request.headers.get("Authorization") != "Bearer jwt":
                return httpx2.Response(401, json={"message": "no token"})
            count = len(json.loads(request.content))
            return httpx2.Response(201, json=[str(index + 1) for index in range(count)])
        if path == "/v1/decisions":
            if request.headers.get("X-Api-Key") != "bouncer":
                return httpx2.Response(403, json={"message": "bad key"})
            return httpx2.Response(
                200, content=json.dumps(self.decisions).encode(), headers={"Content-Type": "application/json"}
            )
        return httpx2.Response(404)


@pytest.mark.anyio
async def test_lapi_client_logs_in_and_posts_alerts() -> None:
    fake = FakeLapi()
    client = LapiClient("http://172.24.0.2:8080", transport=httpx2.MockTransport(fake))
    try:
        await client.login("geometrikks-shots", "pw")
        await client.post_alerts([{"scenario": "crowdsecurity/http-probing"}, {"scenario": "crowdsecurity/http-probing"}])
    finally:
        await client.aclose()
    login, alerts = fake.requests
    assert json.loads(login.content) == {"machine_id": "geometrikks-shots", "password": "pw", "scenarios": []}
    assert alerts.headers["Authorization"] == "Bearer jwt"
    assert {str(request.url.host) for request in fake.requests} == {"172.24.0.2"}


@pytest.mark.anyio
async def test_lapi_client_refuses_alerts_before_login() -> None:
    client = LapiClient("http://172.24.0.2:8080", transport=httpx2.MockTransport(FakeLapi()))
    try:
        with pytest.raises(RuntimeError, match="login"):
            await client.post_alerts([{"scenario": "crowdsecurity/http-probing"}])
    finally:
        await client.aclose()


@pytest.mark.anyio
async def test_lapi_client_reads_decision_values_and_null() -> None:
    decided = FakeLapi(decisions=[{"value": "10.1.0.0"}, {"value": "10.1.0.0/24"}])
    empty = FakeLapi(decisions=None)
    for fake, expected in ((decided, ["10.1.0.0", "10.1.0.0/24"]), (empty, [])):
        client = LapiClient("http://172.24.0.2:8080", transport=httpx2.MockTransport(fake))
        try:
            assert await client.decision_values("bouncer") == expected
        finally:
            await client.aclose()


@pytest.mark.anyio
async def test_lapi_client_waits_until_ready() -> None:
    fake = FakeLapi(refuse_first=2)
    client = LapiClient("http://172.24.0.2:8080", transport=httpx2.MockTransport(fake))
    try:
        await client.wait_ready("bouncer", timeout=5)
    finally:
        await client.aclose()
    assert fake.requests[-1].url.path == "/v1/decisions"


@pytest.mark.anyio
async def test_lapi_client_gives_up_after_the_timeout() -> None:
    client = LapiClient("http://172.24.0.2:8080", transport=httpx2.MockTransport(FakeLapi(refuse_first=10_000)))
    try:
        with pytest.raises(TimeoutError, match="172.24.0.2"):
            await client.wait_ready("bouncer", timeout=0.3)
    finally:
        await client.aclose()


@pytest.mark.anyio
async def test_manual_decisions_go_through_the_app_service(monkeypatch: pytest.MonkeyPatch) -> None:
    # The owner's shell may hold real CROWDSEC_* values; explicit fields must win.
    monkeypatch.setenv("CROWDSEC_LAPI_URL", "http://192.0.2.99:8081")
    monkeypatch.setenv("CROWDSEC_DEFAULT_BAN_DURATION", "999h")
    settings = crowdsec_settings("172.24.0.2", bouncer_key="bouncer", machine_id="geometrikks-shots", password="pw")
    assert settings.lapi_url == "http://172.24.0.2:8080" and settings.write_enabled
    fake = FakeLapi()
    service = CrowdSecService(settings, transport=httpx2.MockTransport(fake))
    try:
        await apply_manual_decisions(service, fixture)
    finally:
        await service.aclose()
    posted = [json.loads(request.content)[0] for request in fake.requests if request.url.path == "/v1/alerts"]
    decisions = [alert["decisions"][0] for alert in posted]
    assert [(d["type"], d["scope"], d["value"]) for d in decisions] == [
        ("captcha", "Ip", fixture.captcha),
        ("ban", "Range", fixture.range_ban),
    ]
    assert all(alert["message"] == MANUAL_REASON == "Repeated probing" for alert in posted)
    assert all("999h" not in json.dumps(alert) for alert in posted)
    assert {str(request.url.host) for request in fake.requests} == {"172.24.0.2"}


_opened_paths: list[Path] = []


def _record_opens(event: str, args: tuple[Any, ...]) -> None:
    if event == "open" and isinstance(args[0], str | Path):
        _opened_paths.append(Path(args[0]).absolute())


# Audit hooks cannot be removed, so one hook records every open for the whole session.
sys.addaudithook(_record_opens)


def test_crowdsec_settings_never_read_a_dotenv_in_the_cwd(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    env_path = tmp_path / ".env"
    env_path.write_text("CROWDSEC_LAPI_URL=http://192.0.2.99:8081\nCROWDSEC_MACHINE_PASSWORD=real\n")
    monkeypatch.chdir(tmp_path)
    # The suite blanks GEOMETRIKKS_ENV_FILE; an unscrubbed run would see the app default.
    unscrubbed = CrowdSecSettings.model_config.copy()
    unscrubbed["env_file"] = ".env"
    monkeypatch.setattr(CrowdSecSettings, "model_config", unscrubbed)
    _opened_paths.clear()
    settings = crowdsec_settings("172.24.0.2", bouncer_key="bouncer", machine_id="geometrikks-shots", password="pw")
    assert env_path not in _opened_paths
    assert settings.lapi_url == "http://172.24.0.2:8080"


@pytest.mark.anyio
async def test_lapi_client_ignores_proxy_variables(monkeypatch: pytest.MonkeyPatch) -> None:
    connections: list[str] = []

    async def proxy(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        connections.append(str(writer.get_extra_info("peername")))
        writer.close()

    server = await asyncio.start_server(proxy, "127.0.0.1", 0)
    proxy_port = server.sockets[0].getsockname()[1]
    closed = await asyncio.start_server(proxy, "127.0.0.1", 0)
    lapi_port = closed.sockets[0].getsockname()[1]
    closed.close()
    await closed.wait_closed()
    for name in ("NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.delenv(name, raising=False)
    for name in ("HTTP_PROXY", "http_proxy"):
        monkeypatch.setenv(name, f"http://127.0.0.1:{proxy_port}")
    client = LapiClient(f"http://127.0.0.1:{lapi_port}")
    try:
        with pytest.raises(httpx2.TransportError):
            await client.decision_values("bouncer")
    finally:
        await client.aclose()
        server.close()
        await server.wait_closed()
    assert connections == []
