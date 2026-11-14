import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { includeCopy } from "./lib/markdown";
import { imageExists, publishedFromEnv, RegistryError } from "./lib/registry";
import { resolveVersions } from "./lib/resolve-versions";
import { manifestFiles } from "../lib/screenshots";
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
const manifestText = readFileSync(join(screenshotsDir, "manifest.json"), "utf8");
const missingShots = manifestFiles(JSON.parse(manifestText)).filter((file) => !existsSync(join(screenshotsDir, file)));
if (missingShots.length > 0) {
  console.error(`screenshots: manifest.json lists files missing from data/screenshots/: ${missingShots.join(", ")}`);
  process.exit(1);
}
rmSync(screenshotsOut, { recursive: true, force: true });
mkdirSync(screenshotsOut, { recursive: true });
for (const file of readdirSync(screenshotsDir).filter((entry) => entry.endsWith(".webp"))) {
  copyFileSync(join(screenshotsDir, file), join(screenshotsOut, file));
}
writeFileSync(join(siteRoot, ".generated", "screenshots.json"), manifestText);

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
