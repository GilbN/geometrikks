import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import sharp from "sharp";
import { includeCopy } from "./lib/markdown";
import { imageExists, publishedFromEnv, RegistryError } from "./lib/registry";
import { resolveVersions } from "./lib/resolve-versions";
import { NEXT } from "../lib/versions";

const siteRoot = resolve(import.meta.dir, "..");
const contentDir = resolve(siteRoot, process.env.DOCS_CONTENT_DIR ?? "content");
const isPublished = publishedFromEnv(process.env) ?? ((version: string) => imageExists(version));

// Turbopack refuses an <include> outside site/, so the pages include copies.
mkdirSync(join(siteRoot, ".generated"), { recursive: true });
for (const name of ["CHANGELOG.md", "SECURITY.md"]) {
  const markdown = readFileSync(join(siteRoot, "..", name), "utf8");
  writeFileSync(join(siteRoot, ".generated", name), includeCopy(markdown));
}

const screenshotsDir = join(siteRoot, "..", "data", "screenshots");
const screenshotsOut = join(siteRoot, "public", "screenshots");
mkdirSync(screenshotsOut, { recursive: true });
const screenshotSizes: Record<string, { width: number; height: number }> = {};
for (const file of readdirSync(screenshotsDir).filter((entry) => entry.endsWith(".png")).sort()) {
  const name = basename(file, ".png");
  const info = await sharp(join(screenshotsDir, file))
    .resize({ width: 1912 })
    .webp()
    .toFile(join(screenshotsOut, `${name}.webp`));
  screenshotSizes[name] = { width: info.width, height: info.height };
}
writeFileSync(join(siteRoot, ".generated", "screenshots.json"), `${JSON.stringify(screenshotSizes, null, 2)}\n`);

const landDots: [number, number][] = JSON.parse(readFileSync(join(siteRoot, "data", "land-dots.json"), "utf8"));
const dotCircles = landDots.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.5"/>`).join("");
writeFileSync(
  join(siteRoot, "public", "land-dots.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg"><g id="d">${dotCircles}</g></svg>\n`,
);

try {
  const plan = await resolveVersions(join(contentDir, "docs"), isPublished);
  writeFileSync(join(siteRoot, ".generated", "versions.json"), `${JSON.stringify(plan, null, 2)}\n`);
  console.log(
    `docs: latest=${plan.latest ?? "none"} next served, pending=[${plan.pending.join(", ")}] superseded=[${plan.superseded.join(", ")}]`,
  );
} catch (error) {
  if (!(error instanceof RegistryError)) throw error;
  console.error("docs: cannot reach ghcr.io; refusing to guess which release is latest");
  console.error(error.message);
  process.exit(1);
}

// The API pages leave the schema out of their props (includeDocument: false) and import these instead.
const { openapiFor } = await import("../lib/openapi");
const plan = JSON.parse(readFileSync(join(siteRoot, ".generated", "versions.json"), "utf8"));
rmSync(join(siteRoot, ".generated", "openapi"), { recursive: true, force: true });
mkdirSync(join(siteRoot, ".generated", "openapi"), { recursive: true });
for (const version of [NEXT, ...(plan.latest === null ? [] : [plan.latest])]) {
  const { bundled } = await openapiFor(version).getSchema(version);
  writeFileSync(join(siteRoot, ".generated", "openapi", `${version}.json`), JSON.stringify(bundled));
}
