import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Components import the manifest that scripts/prepare.ts copies at build time, and CI runs the tests before the build.
const siteRoot = join(import.meta.dir, "..");
const target = join(siteRoot, ".generated", "screenshots.json");
if (!existsSync(target)) {
  mkdirSync(join(siteRoot, ".generated"), { recursive: true });
  copyFileSync(join(siteRoot, "..", "data", "screenshots", "manifest.json"), target);
}
