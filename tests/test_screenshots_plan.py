"""The docs screenshot shot list: scenes, viewports, file names and the plan handed to Playwright."""

import re
from pathlib import Path

import pytest

from tests.screenshots.plan import (
    SCENES,
    VIEWPORTS,
    MissingParamError,
    UnknownSceneError,
    ViewportSpec,
    build_shots,
    capture_plan,
    parse_shot_filename,
    resolve_path,
    shot_filename,
)


def test_filename_round_trip() -> None:
    assert shot_filename("access-logs", "phone", "dark") == "access-logs-phone-dark.webp"
    assert parse_shot_filename("access-logs-phone-dark.webp") == ("access-logs", "phone", "dark")
    assert parse_shot_filename("live-tail-landscape-light.webp") == ("live-tail", "landscape", "light")
    assert parse_shot_filename("dashboard.png") is None
    assert parse_shot_filename("manifest.json") is None
    assert parse_shot_filename("map-tablet-dark.webp") is None


EXPECTED_SCENES = [
    ("login", "Login", "/login", ("desktop", "phone"), False),
    ("dashboard", "Overview", "/", ("desktop", "phone"), False),
    ("map", "Map", "/map?focus={focus_location}", ("desktop", "phone", "landscape"), False),
    ("access-logs", "Access logs", "/access-logs", ("desktop", "phone"), False),
    ("filter-drawer", "Filters on a phone", "/access-logs", ("phone",), False),
    ("geo-logs", "Geo logs", "/geo-logs", ("desktop", "phone"), False),
    ("debug-logs", "Debug logs", "/debug-logs", ("desktop", "phone"), False),
    ("analytics", "Analytics", "/analytics", ("desktop", "phone"), False),
    ("ip-inspector", "IP inspector", "/map?inspect={inspect_ip}", ("desktop", "phone"), False),
    ("abuse-report", "Abuse report", "/map?inspect={inspect_ip}", ("desktop", "phone"), False),
    ("security", "Security", "/security", ("desktop", "phone"), False),
    ("drop-networks", "DROP networks", "/security?tab=drop", ("desktop", "phone"), False),
    ("abuseipdb-report", "Report to AbuseIPDB", "/security?tab=reports", ("desktop", "phone"), False),
    ("abuseipdb-reports", "AbuseIPDB reports", "/security?tab=reports", ("desktop", "phone"), False),
    ("banned-map", "Banned IPs map", "/map", ("desktop", "phone"), False),
    ("status", "Status", "/settings/status", ("desktop", "phone"), True),
    ("settings", "Appearance", "/settings/appearance", ("desktop", "phone"), False),
    ("live", "Live map", "/map", ("desktop", "phone", "landscape"), True),
    ("live-tail", "Live tail", "/access-logs", ("desktop", "phone"), True),
]


def test_scene_table() -> None:
    actual = [(scene.id, scene.title, scene.path, scene.viewports, scene.live) for scene in SCENES]
    assert actual == EXPECTED_SCENES


def test_viewports_match_the_constraints() -> None:
    assert VIEWPORTS == {
        "desktop": ViewportSpec(width=1440, height=900, device_scale_factor=1.5, mobile=False, safe_area=None),
        "phone": ViewportSpec(width=393, height=852, device_scale_factor=2, mobile=True, safe_area=(0, 0, 34, 0)),
        "landscape": ViewportSpec(width=852, height=393, device_scale_factor=2, mobile=True, safe_area=(0, 59, 21, 59)),
    }


def test_debug_logs_alt_avoids_the_phrase_the_site_smoke_forbids() -> None:
    assert all("raw source lines behind every request" not in scene.alt for scene in SCENES)


def test_scene_ids_are_unique_and_kebab_case() -> None:
    ids = [scene.id for scene in SCENES]
    assert len(ids) == len(set(ids)) and all(re.fullmatch(r"[a-z][a-z0-9-]*", scene_id) for scene_id in ids)


def test_every_scene_has_alt_text_and_a_known_viewport() -> None:
    assert all(scene.alt and scene.viewports and set(scene.viewports) <= set(VIEWPORTS) for scene in SCENES)


def test_build_shots_counts_and_order() -> None:
    shots = build_shots()
    assert len(shots) == 78
    assert sum(shot.scene.live for shot in shots) == 14
    assert [shot.name for shot in shots[:2]] == ["login-desktop-dark", "login-desktop-light"]
    first_live = next(index for index, shot in enumerate(shots) if shot.scene.live)
    assert all(shot.scene.live for shot in shots[first_live:])
    assert {shot.viewport for shot in shots if shot.scene.id == "map"} == {"desktop", "phone", "landscape"}
    assert {shot.viewport for shot in shots if shot.scene.id == "filter-drawer"} == {"phone"}


def test_build_shots_only_and_unknown() -> None:
    assert {shot.scene.id for shot in build_shots(only={"map"})} == {"map"}
    with pytest.raises(UnknownSceneError, match="maps"):
        build_shots(only={"maps"})


def test_resolve_path_requires_params() -> None:
    scene = next(scene for scene in SCENES if scene.id == "ip-inspector")
    assert resolve_path(scene, {"inspect_ip": "198.51.100.7"}) == "/map?inspect=198.51.100.7"
    with pytest.raises(MissingParamError, match="inspect_ip"):
        resolve_path(scene, {})


def test_capture_plan_shape(tmp_path: Path) -> None:
    answers = {"status": {"enabled": True}, "blacklist": {"ips": []}, "checks": {}}
    plan = capture_plan(
        build_shots(only={"live"}), {}, base_url="http://127.0.0.1:9", png_dir=tmp_path, abuseipdb=answers
    )
    shots = plan["shots"]
    assert isinstance(shots, list)
    landscape = next(shot for shot in shots if shot["viewport"]["name"] == "landscape")
    assert landscape["viewport"] == {
        "name": "landscape",
        "width": 852,
        "height": 393,
        "deviceScaleFactor": 2,
        "isMobile": True,
        "safeArea": {"top": 0, "right": 59, "bottom": 21, "left": 59},
    }
    assert landscape["live"] is True
    assert plan["baseUrl"] == "http://127.0.0.1:9"
    assert plan["pngDir"] == str(tmp_path)
    assert plan["abuseipdb"] == answers
    desktop = next(shot for shot in shots if shot["viewport"]["name"] == "desktop")
    assert {key: desktop[key] for key in ("name", "scene", "title", "path", "theme")} == {
        "name": "live-desktop-dark",
        "scene": "live",
        "title": "Live map",
        "path": "/map",
        "theme": "dark",
    }
    assert desktop["viewport"]["safeArea"] is None
