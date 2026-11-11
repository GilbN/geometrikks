"""Publishing encoded screenshots: the manifest, which files change, and an all-or-nothing folder swap."""

from __future__ import annotations

import os
import shutil
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from tests.screenshots.plan import SCENES, Shot, parse_shot_filename, shot_filename
from tests.screenshots.teardown import interrupts_ignored

MANIFEST_NAME = "manifest.json"
STAGING_NAME = ".screenshots-staging"
BACKUP_NAME = ".screenshots-backup"


def build_manifest(
    shots: Sequence[Shot],
    sizes: Mapping[str, tuple[int, int]],
    *,
    previous: Mapping[str, object] | None,
    retaken: Collection[str] | None,
) -> dict[str, object]:
    """Scenes in ``SCENES`` order; on a retake, every scene outside ``retaken`` comes from ``previous`` unchanged."""
    taken: dict[str, dict[str, object]] = {}
    for shot in shots:
        scene = taken.setdefault(shot.scene.id, {"title": shot.scene.title, "alt": shot.scene.alt, "variants": {}})
        width, height = sizes[shot.name]
        variants = scene["variants"]
        assert isinstance(variants, dict)
        variants[f"{shot.viewport}-{shot.theme}"] = {
            "file": shot_filename(shot.scene.id, shot.viewport, shot.theme),
            "width": width,
            "height": height,
        }
    earlier = previous.get("scenes") if retaken is not None and previous is not None else None
    kept = earlier if isinstance(earlier, dict) else {}
    scenes: dict[str, object] = {}
    for scene in SCENES:
        if retaken is not None and scene.id not in retaken:
            if scene.id in kept:
                scenes[scene.id] = kept[scene.id]
        elif scene.id in taken:
            scenes[scene.id] = taken[scene.id]
    return {"version": 1, "scenes": scenes}


@dataclass(frozen=True, slots=True)
class SwapPlan:
    keep: tuple[str, ...]
    drop: tuple[str, ...]
    write: tuple[str, ...]


def plan_swap(existing: Collection[str], new_files: Collection[str], *, retaken: Collection[str] | None) -> SwapPlan:
    """Only shot WebPs this run replaces can go; PNGs, odd names and other scenes' files always stay."""
    write = tuple(sorted({*new_files, MANIFEST_NAME}))

    def ours(name: str) -> bool:
        parsed = parse_shot_filename(name)
        return parsed is not None and (retaken is None or parsed[0] in retaken)

    rest = sorted(name for name in existing if name not in write)
    return SwapPlan(
        keep=tuple(name for name in rest if not ours(name)),
        drop=tuple(name for name in rest if ours(name)),
        write=write,
    )


def stage_publish(target: Path, plan: SwapPlan, webp_dir: Path) -> Path:
    """Build the complete resulting folder next to ``target``, so the swap is two renames on one filesystem."""
    staging = target.parent / STAGING_NAME
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    for name in plan.keep:
        shutil.copy2(target / name, staging / name)
    for name in plan.write:
        shutil.copy2(webp_dir / name, staging / name)
    return staging


def publish_staged(target: Path, *, rename: Callable[[Path, Path], None] = os.rename) -> None:
    staging = target.parent / STAGING_NAME
    backup = target.parent / BACKUP_NAME
    with interrupts_ignored():
        if backup.exists():
            raise RuntimeError(f"{backup} is left from an earlier publish; run --cleanup first")
        if not target.exists():
            rename(staging, target)
            return
        rename(target, backup)
        try:
            rename(staging, target)
        except BaseException:
            rename(backup, target)
            raise
        shutil.rmtree(backup)


def recover_publish(target: Path) -> list[str]:
    """Finish or undo a swap that an earlier process stopped part way; one line per action."""
    staging = target.parent / STAGING_NAME
    backup = target.parent / BACKUP_NAME
    lines: list[str] = []
    if backup.exists():
        if target.exists():
            shutil.rmtree(backup)
            lines.append(f"removed {backup}: the last publish stopped while removing its backup")
        else:
            os.rename(backup, target)
            lines.append(f"restored {target} from {backup}: the last publish stopped between its renames")
    if staging.exists():
        shutil.rmtree(staging)
        lines.append(f"removed the unpublished staging folder {staging}")
    return lines
