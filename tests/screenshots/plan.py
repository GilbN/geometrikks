"""What to capture: scenes, viewports, themes, file names and the plan the Playwright spec reads."""

from __future__ import annotations

import re
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

Viewport = Literal["desktop", "phone", "landscape"]
Theme = Literal["dark", "light"]

VIEWPORT_ORDER: tuple[Viewport, ...] = ("desktop", "phone", "landscape")
THEMES: tuple[Theme, ...] = ("dark", "light")

_SCENE_ID = re.compile(r"[a-z][a-z0-9-]*")


@dataclass(frozen=True, slots=True)
class ViewportSpec:
    width: int
    height: int
    device_scale_factor: float
    mobile: bool
    safe_area: tuple[int, int, int, int] | None
    """Insets as (top, right, bottom, left), or None for no override."""


VIEWPORTS: dict[Viewport, ViewportSpec] = {
    "desktop": ViewportSpec(width=1440, height=900, device_scale_factor=1.5, mobile=False, safe_area=None),
    "phone": ViewportSpec(width=393, height=852, device_scale_factor=2, mobile=True, safe_area=(0, 0, 34, 0)),
    "landscape": ViewportSpec(width=852, height=393, device_scale_factor=2, mobile=True, safe_area=(0, 59, 21, 59)),
}


@dataclass(frozen=True, slots=True)
class Scene:
    id: str
    title: str
    alt: str
    path: str
    viewports: tuple[Viewport, ...]
    live: bool = False


SCENES: tuple[Scene, ...] = (
    Scene(
        id="login",
        title="Login",
        alt="The GeoMetrikks sign-in form with username and password fields.",
        path="/login",
        viewports=("desktop", "phone"),
    ),
    Scene(
        id="dashboard",
        title="Overview",
        alt="The Overview page with request, unique IP and country totals above traffic and status code charts.",
        path="/",
        viewports=("desktop", "phone"),
    ),
    Scene(
        id="map",
        title="Map",
        alt="A world map of visitor markers with one location open in the detail view.",
        path="/map?focus={focus_location}",
        viewports=("desktop", "phone", "landscape"),
    ),
    Scene(
        id="access-logs",
        title="Access logs",
        alt="The Access Logs request history table with time, status, method, URL and client IP columns.",
        path="/access-logs",
        viewports=("desktop", "phone"),
    ),
    Scene(
        id="filter-drawer",
        title="Filters on a phone",
        alt="The Access Logs filter drawer open on a phone with compact filter rows.",
        path="/access-logs",
        viewports=("phone",),
    ),
    Scene(
        id="geo-logs",
        title="Geo logs",
        alt="The Geo Logs page with chart cards above a table of geolocated events.",
        path="/geo-logs",
        viewports=("desktop", "phone"),
    ),
    Scene(
        id="debug-logs",
        title="Debug logs",
        alt="The Debug Logs table of log lines that failed to parse, each with its parse error.",
        path="/debug-logs",
        viewports=("desktop", "phone"),
    ),
    Scene(
        id="analytics",
        title="Analytics",
        alt="The Analytics page with request, status and latency charts above top lists of URLs, IPs and ASNs.",
        path="/analytics",
        viewports=("desktop", "phone"),
    ),
    Scene(
        id="ip-inspector",
        title="IP inspector",
        alt="The IP inspector for a banned documentation address on a DROP list under AS64496, with no known location.",
        path="/map?inspect={inspect_ip}",
        viewports=("desktop", "phone"),
    ),
    Scene(
        id="abuse-report",
        title="Abuse report",
        alt="The abuse report dialog for a documentation address, with a notice that it is on a DROP list.",
        path="/map?inspect={inspect_ip}",
        viewports=("desktop", "phone"),
    ),
    Scene(
        id="security",
        title="Security",
        alt="The Security page with CrowdSec stat cards, active decisions and the alert history.",
        path="/security",
        viewports=("desktop", "phone"),
    ),
    Scene(
        id="drop-networks",
        title="DROP networks",
        alt="The DROP networks in your traffic card on the Security page, listing documentation-range networks only.",
        path="/security",
        viewports=("desktop", "phone"),
    ),
    Scene(
        id="banned-map",
        title="Banned IPs map",
        alt="The map in its Banned view, with markers for IPs that CrowdSec has banned.",
        path="/map",
        viewports=("desktop", "phone"),
    ),
    Scene(
        id="status",
        title="Status",
        alt="The Status settings page with ingestion, database, GeoIP and CrowdSec cards.",
        path="/settings/status",
        viewports=("desktop", "phone"),
    ),
    Scene(
        id="settings",
        title="Appearance",
        alt="The Appearance settings page with the color scheme switch and the theme choices.",
        path="/settings/appearance",
        viewports=("desktop", "phone"),
    ),
    Scene(
        id="nav-more",
        title="Phone navigation",
        alt="The floating navigation bar on a phone with its More menu open.",
        path="/",
        viewports=("phone",),
    ),
    Scene(
        id="live",
        title="Live map",
        alt="The map in live mode with pulses for incoming requests beside the live traffic feed and its summary.",
        path="/map",
        viewports=("desktop", "phone", "landscape"),
        live=True,
    ),
    Scene(
        id="live-tail",
        title="Live tail",
        alt="The Access Logs Live tail tab streaming new requests as they arrive.",
        path="/access-logs",
        viewports=("desktop", "phone"),
        live=True,
    ),
)


@dataclass(frozen=True, slots=True)
class Shot:
    scene: Scene
    viewport: Viewport
    theme: Theme

    @property
    def name(self) -> str:
        return f"{self.scene.id}-{self.viewport}-{self.theme}"


class UnknownSceneError(ValueError):
    """``--only`` named a scene that is not on the shot list."""


class MissingParamError(KeyError):
    """A scene path needs a run parameter that was not supplied."""


def shot_filename(scene_id: str, viewport: Viewport, theme: Theme) -> str:
    return f"{scene_id}-{viewport}-{theme}.webp"


def parse_shot_filename(filename: str) -> tuple[str, Viewport, Theme] | None:
    """Split ``<scene>-<viewport>-<theme>.webp``; None for anything else."""
    stem, dot, extension = filename.rpartition(".")
    if not dot or extension != "webp":
        return None
    parts = stem.rsplit("-", 2)
    if len(parts) != 3:
        return None
    scene_id, raw_viewport, raw_theme = parts
    viewport = next((name for name in VIEWPORT_ORDER if name == raw_viewport), None)
    theme = next((name for name in THEMES if name == raw_theme), None)
    if viewport is None or theme is None or not _SCENE_ID.fullmatch(scene_id):
        return None
    return scene_id, viewport, theme


def build_shots(only: Collection[str] | None = None, scenes: Sequence[Scene] = SCENES) -> list[Shot]:
    """Every shot to take, still scenes before live ones so the feeder runs only at the end."""
    if only is not None:
        unknown = sorted(set(only) - {scene.id for scene in scenes})
        if unknown:
            raise UnknownSceneError(f"unknown scene(s): {', '.join(unknown)}")
    chosen = [scene for scene in scenes if only is None or scene.id in only]
    ordered = [scene for scene in chosen if not scene.live] + [scene for scene in chosen if scene.live]
    return [
        Shot(scene=scene, viewport=viewport, theme=theme)
        for scene in ordered
        for viewport in VIEWPORT_ORDER
        if viewport in scene.viewports
        for theme in THEMES
    ]


def resolve_path(scene: Scene, params: Mapping[str, str]) -> str:
    try:
        return scene.path.format_map(params)
    except KeyError as error:
        raise MissingParamError(f"scene {scene.id!r} needs the {error.args[0]!r} parameter") from None


def capture_plan(shots: Sequence[Shot], params: Mapping[str, str], *, base_url: str, png_dir: Path) -> dict[str, object]:
    """The JSON the Playwright spec reads; camelCase keys are its contract."""
    return {
        "baseUrl": base_url,
        "pngDir": str(png_dir),
        "shots": [
            {
                "name": shot.name,
                "scene": shot.scene.id,
                "title": shot.scene.title,
                "path": resolve_path(shot.scene, params),
                "live": shot.scene.live,
                "theme": shot.theme,
                "viewport": _viewport_json(shot.viewport),
            }
            for shot in shots
        ],
    }


def _viewport_json(viewport: Viewport) -> dict[str, object]:
    spec = VIEWPORTS[viewport]
    safe_area = None
    if spec.safe_area is not None:
        top, right, bottom, left = spec.safe_area
        safe_area = {"top": top, "right": right, "bottom": bottom, "left": left}
    return {
        "name": viewport,
        "width": spec.width,
        "height": spec.height,
        "deviceScaleFactor": spec.device_scale_factor,
        "isMobile": spec.mobile,
        "safeArea": safe_area,
    }
