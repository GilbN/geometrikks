"""Publishing screenshots: the manifest, the swap plan and the folder swap with its recovery."""

import os
import signal
from collections.abc import Iterable
from pathlib import Path

import pytest

from tests.screenshots.plan import SCENES, build_shots
from tests.screenshots.publish import (
    BACKUP_NAME,
    STAGING_NAME,
    SwapPlan,
    build_manifest,
    plan_swap,
    publish_staged,
    recover_publish,
    stage_publish,
)
from tests.screenshots.teardown import interrupts_raise

SIZES = {shot.name: (2160, 1350) for shot in build_shots()}


def folder(path: Path, file_names: Iterable[str]) -> Path:
    path.mkdir(parents=True)
    for name in file_names:
        (path / name).write_text(name)
    return path


def names(path: Path) -> set[str]:
    return {entry.name for entry in path.iterdir()}


def test_full_swap_drops_old_webp_and_never_touches_pngs_or_strangers() -> None:
    plan = plan_swap(
        {"map.png", "notes.txt", "manifest.json", "old-desktop-dark.webp", "map-desktop-dark.webp"},
        {"map-desktop-dark.webp", "manifest.json"},
        retaken=None,
    )
    assert plan.drop == ("old-desktop-dark.webp",) and set(plan.keep) == {"map.png", "notes.txt"}
    assert set(plan.write) == {"map-desktop-dark.webp", "manifest.json"}


def test_manifest_is_always_written() -> None:
    assert plan_swap(set(), {"map-desktop-dark.webp"}, retaken=None).write == ("manifest.json", "map-desktop-dark.webp")


def test_retake_swaps_only_that_scene() -> None:
    existing = {"map-desktop-dark.webp", "security-desktop-dark.webp", "manifest.json"}
    plan = plan_swap(existing, {"map-desktop-dark.webp", "map-phone-dark.webp", "manifest.json"}, retaken={"map"})
    assert plan.drop == () and "security-desktop-dark.webp" in plan.keep


def test_retake_drops_a_viewport_the_scene_no_longer_has() -> None:
    plan = plan_swap(
        {"map-landscape-dark.webp", "map-desktop-dark.webp"},
        {"map-desktop-dark.webp", "manifest.json"},
        retaken={"map"},
    )
    assert plan.drop == ("map-landscape-dark.webp",)


def test_unparseable_names_are_never_deleted() -> None:
    plan = plan_swap(
        {"map-tablet-dark.webp", "notes.txt"}, {"map-desktop-dark.webp", "manifest.json"}, retaken=None
    )
    assert plan.drop == () and set(plan.keep) == {"map-tablet-dark.webp", "notes.txt"}


def test_stage_copies_kept_files_and_writes_new_ones(tmp_path: Path) -> None:
    target = folder(tmp_path / "screenshots", {"old.png", "old-desktop-dark.webp"})
    webp_dir = folder(tmp_path / "webp", {"map-desktop-dark.webp", "manifest.json"})
    folder(tmp_path / STAGING_NAME, {"leftover.webp"})
    plan = SwapPlan(
        keep=("old.png",), drop=("old-desktop-dark.webp",), write=("manifest.json", "map-desktop-dark.webp")
    )
    staging = stage_publish(target, plan, webp_dir)
    assert staging == tmp_path / STAGING_NAME
    assert names(staging) == {"old.png", "map-desktop-dark.webp", "manifest.json"}
    assert names(target) == {"old.png", "old-desktop-dark.webp"}


def test_publish_swaps_in_the_staged_folder(tmp_path: Path) -> None:
    target = folder(tmp_path / "screenshots", {"old.png"})
    folder(tmp_path / STAGING_NAME, {"old.png", "map-desktop-dark.webp", "manifest.json"})
    publish_staged(target)
    assert names(target) == {"old.png", "map-desktop-dark.webp", "manifest.json"}
    assert not (tmp_path / BACKUP_NAME).exists() and not (tmp_path / STAGING_NAME).exists()


def test_first_publish_needs_no_target(tmp_path: Path) -> None:
    folder(tmp_path / STAGING_NAME, {"map-desktop-dark.webp"})
    publish_staged(tmp_path / "screenshots")
    assert names(tmp_path / "screenshots") == {"map-desktop-dark.webp"} and not (tmp_path / STAGING_NAME).exists()


def test_failed_move_restores_the_old_folder(tmp_path: Path) -> None:
    target = folder(tmp_path / "screenshots", {"old.png"})
    folder(tmp_path / STAGING_NAME, {"map-desktop-dark.webp"})

    def failing(src: Path, dst: Path) -> None:
        if src.name == STAGING_NAME:
            raise OSError("move failed")
        os.rename(src, dst)

    with pytest.raises(OSError, match="move failed"):
        publish_staged(target, rename=failing)
    assert names(target) == {"old.png"} and not (tmp_path / BACKUP_NAME).exists()


def test_interrupt_during_publish_does_not_split_the_swap(tmp_path: Path) -> None:
    target = folder(tmp_path / "screenshots", {"old.png"})
    folder(tmp_path / STAGING_NAME, {"map-desktop-dark.webp"})

    def interrupting(src: Path, dst: Path) -> None:
        os.kill(os.getpid(), signal.SIGTERM)
        os.rename(src, dst)

    with interrupts_raise():
        publish_staged(target, rename=interrupting)
    assert names(target) == {"map-desktop-dark.webp"} and not (tmp_path / BACKUP_NAME).exists()


def test_recover_after_an_interrupt_between_the_renames(tmp_path: Path) -> None:
    folder(tmp_path / BACKUP_NAME, {"old.png"})
    folder(tmp_path / STAGING_NAME, {"map-desktop-dark.webp"})
    lines = recover_publish(tmp_path / "screenshots")
    assert names(tmp_path / "screenshots") == {"old.png"}
    assert not (tmp_path / STAGING_NAME).exists() and len(lines) == 2


def test_recover_after_an_interrupt_while_removing_the_backup(tmp_path: Path) -> None:
    folder(tmp_path / "screenshots", {"map-desktop-dark.webp"})
    folder(tmp_path / BACKUP_NAME, {"old.png"})
    assert len(recover_publish(tmp_path / "screenshots")) == 1
    assert names(tmp_path / "screenshots") == {"map-desktop-dark.webp"} and not (tmp_path / BACKUP_NAME).exists()


def test_recover_does_nothing_after_a_clean_swap(tmp_path: Path) -> None:
    folder(tmp_path / "screenshots", {"old.png"})
    assert recover_publish(tmp_path / "screenshots") == []
    assert names(tmp_path / "screenshots") == {"old.png"}


def test_manifest_lists_every_scene_in_order_with_its_variants() -> None:
    manifest = build_manifest(build_shots(), SIZES, previous=None, retaken=None)
    scenes = manifest["scenes"]
    assert manifest["version"] == 1 and isinstance(scenes, dict)
    assert list(scenes) == [scene.id for scene in SCENES]
    assert scenes["map"]["title"] == "Map" and scenes["map"]["alt"].startswith("A world map")
    assert list(scenes["map"]["variants"]) == [
        "desktop-dark",
        "desktop-light",
        "phone-dark",
        "phone-light",
        "landscape-dark",
        "landscape-light",
    ]
    login = scenes["login"]["variants"]["phone-light"]
    assert login == {"file": "login-phone-light.webp", "width": 2160, "height": 1350}


def test_manifest_merges_previous_scenes_on_retake() -> None:
    previous = build_manifest(build_shots(), SIZES, previous=None, retaken=None)
    merged = build_manifest(
        build_shots(only={"map"}), {**SIZES, "map-desktop-dark": (10, 10)}, previous=previous, retaken={"map"}
    )
    scenes = merged["scenes"]
    assert isinstance(scenes, dict)
    assert scenes["security"] == previous["scenes"]["security"]  # ty: ignore[not-subscriptable]
    assert scenes["map"]["variants"]["desktop-dark"] == {"file": "map-desktop-dark.webp", "width": 10, "height": 10}
    assert list(scenes) == [s.id for s in SCENES]


def test_manifest_needs_a_size_for_every_shot() -> None:
    with pytest.raises(KeyError, match="map-desktop-dark"):
        build_manifest(build_shots(only={"map"}), {}, previous=None, retaken=None)


def test_a_retake_needs_the_previous_manifest() -> None:
    with pytest.raises(ValueError, match="previous manifest"):
        build_manifest(build_shots(only={"map"}), SIZES, previous=None, retaken={"map"})
