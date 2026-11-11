"""The docs screenshot shot list: scenes, viewports, file names and the plan handed to Playwright."""

import re
from pathlib import Path

import pytest

from tests.screenshots.plan import (
    SCENES,
    VIEWPORTS,
    MissingParamError,
    UnknownSceneError,
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


def test_scene_ids_are_unique_and_kebab_case() -> None:
    ids = [scene.id for scene in SCENES]
    assert len(ids) == len(set(ids)) and all(re.fullmatch(r"[a-z][a-z0-9-]*", scene_id) for scene_id in ids)


def test_every_scene_has_alt_text_and_a_known_viewport() -> None:
    assert all(scene.alt and scene.viewports and set(scene.viewports) <= set(VIEWPORTS) for scene in SCENES)


def test_build_shots_counts_and_order() -> None:
    shots = build_shots()
    assert len(shots) == 72
    assert [shot.name for shot in shots[:2]] == ["login-desktop-dark", "login-desktop-light"]
    first_live = next(index for index, shot in enumerate(shots) if shot.scene.live)
    assert all(shot.scene.live for shot in shots[first_live:])
    assert {shot.viewport for shot in shots if shot.scene.id == "map"} == {"desktop", "phone", "landscape"}
    assert {shot.viewport for shot in shots if shot.scene.id in ("filter-drawer", "nav-more")} == {"phone"}


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
    plan = capture_plan(build_shots(only={"live"}), {}, base_url="http://127.0.0.1:9", png_dir=tmp_path)
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
