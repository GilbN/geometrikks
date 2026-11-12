import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Manifest, manifestFiles, sceneEntry, shotSrc, variant } from "../lib/screenshots";

const screenshotsDir = join(import.meta.dir, "..", "..", "data", "screenshots");
const realManifest: Manifest = JSON.parse(readFileSync(join(screenshotsDir, "manifest.json"), "utf8"));

// The scene ids in tests/screenshots/plan.py.
const PLAN_SCENES = [
  "login",
  "dashboard",
  "map",
  "access-logs",
  "filter-drawer",
  "geo-logs",
  "debug-logs",
  "analytics",
  "ip-inspector",
  "abuse-report",
  "security",
  "drop-networks",
  "banned-map",
  "status",
  "settings",
  "nav-more",
  "live",
  "live-tail",
];

const manifest: Manifest = {
  version: 1,
  scenes: {
    map: {
      title: "Map",
      alt: "The map",
      variants: {
        "desktop-dark": { file: "map-desktop-dark.webp", width: 2160, height: 1350 },
        "phone-light": { file: "map-phone-light.webp", width: 786, height: 1704 },
      },
    },
  },
};

describe("sceneEntry", () => {
  test("returns the scene", () => {
    expect(sceneEntry(manifest, "map").alt).toBe("The map");
  });

  test("throws for an unknown id", () => {
    expect(() => sceneEntry(manifest, "nope")).toThrow("unknown screenshot scene: nope");
  });
});

describe("variant", () => {
  test("finds desktop-dark", () => {
    expect(variant(sceneEntry(manifest, "map"), "desktop", "dark")).toEqual({
      file: "map-desktop-dark.webp",
      width: 2160,
      height: 1350,
    });
  });

  test("returns undefined for a viewport the scene lacks", () => {
    expect(variant(sceneEntry(manifest, "map"), "landscape", "dark")).toBeUndefined();
  });
});

test("shotSrc serves from /screenshots/", () => {
  expect(shotSrc({ file: "map-desktop-dark.webp", width: 2160, height: 1350 })).toBe(
    "/screenshots/map-desktop-dark.webp",
  );
});

test("manifestFiles lists every variant file", () => {
  expect(manifestFiles(manifest).sort()).toEqual(["map-desktop-dark.webp", "map-phone-light.webp"]);
});

describe("the published manifest", () => {
  test("is version 1 and has every scene the capture plan defines", () => {
    expect(realManifest.version).toBe(1);
    for (const scene of PLAN_SCENES) expect(Object.keys(realManifest.scenes)).toContain(scene);
  });

  test("every listed file exists", () => {
    const missing = manifestFiles(realManifest).filter((file) => !existsSync(join(screenshotsDir, file)));
    expect(missing).toEqual([]);
  });

  test("every scene has an alt text and a dark and light pair per viewport", () => {
    for (const [id, entry] of Object.entries(realManifest.scenes)) {
      expect(entry.alt, id).not.toBe("");
      for (const key of Object.keys(entry.variants)) {
        const [viewport, theme] = key.split("-");
        const other = theme === "dark" ? "light" : "dark";
        expect(entry.variants[`${viewport}-${other}`], `${id} ${key}`).toBeDefined();
      }
    }
  });
});
