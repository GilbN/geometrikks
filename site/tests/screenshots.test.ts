import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShotPair } from "../components/ShotPair";
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

describe("ShotPair", () => {
  const images = (html: string) => [...html.matchAll(/<img [^>]*>/g)].map((match) => match[0]);
  const attribute = (tag: string, name: string) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];

  test("shows desktop and phone by default", () => {
    const sources = images(renderToStaticMarkup(createElement(ShotPair, { scene: "map" }))).map((tag) =>
      attribute(tag, "src"),
    );
    expect(sources).toEqual([
      "/screenshots/map-desktop-light.webp",
      "/screenshots/map-desktop-dark.webp",
      "/screenshots/map-phone-light.webp",
      "/screenshots/map-phone-dark.webp",
    ]);
  });

  test("viewport landscape shows the sideways shot alone in the reader's theme", () => {
    const html = renderToStaticMarkup(
      createElement(ShotPair, { scene: "map", viewport: "landscape", caption: "Held sideways" }),
    );
    const tags = images(html);
    expect(tags.map((tag) => [attribute(tag, "src"), attribute(tag, "class")])).toEqual([
      ["/screenshots/map-landscape-light.webp", "shot-light"],
      ["/screenshots/map-landscape-dark.webp", "shot-dark"],
    ]);
    const landscape = sceneEntry(realManifest, "map").variants["landscape-dark"];
    for (const tag of tags) {
      expect(attribute(tag, "width")).toBe(String(landscape.width));
      expect(attribute(tag, "height")).toBe(String(landscape.height));
      expect(attribute(tag, "alt")).toBe("The Map page on a phone held sideways.");
      expect(attribute(tag, "loading")).toBe("lazy");
      expect(attribute(tag, "decoding")).toBe("async");
    }
    expect(html).toContain("<figcaption");
    expect(html).toContain("Held sideways");
  });

  test("viewport landscape with theme dark shows only the dark shot", () => {
    const tags = images(
      renderToStaticMarkup(createElement(ShotPair, { scene: "map", viewport: "landscape", theme: "dark" })),
    );
    expect(tags.map((tag) => attribute(tag, "src"))).toEqual(["/screenshots/map-landscape-dark.webp"]);
    expect(attribute(tags[0], "class")).toBeUndefined();
  });

  test("viewport landscape throws for a scene with no sideways shot", () => {
    expect(() => renderToStaticMarkup(createElement(ShotPair, { scene: "dashboard", viewport: "landscape" }))).toThrow(
      "screenshot scene dashboard has no landscape shot",
    );
  });
});
