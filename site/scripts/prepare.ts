import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { imageExists, publishedFromEnv, RegistryError } from "./lib/registry";
import { resolveVersions } from "./lib/resolve-versions";

const siteRoot = resolve(import.meta.dir, "..");
const contentDir = resolve(siteRoot, process.env.DOCS_CONTENT_DIR ?? "content");
const isPublished = publishedFromEnv(process.env) ?? ((version: string) => imageExists(version));

try {
  const plan = await resolveVersions(join(contentDir, "docs"), isPublished);
  mkdirSync(join(siteRoot, ".generated"), { recursive: true });
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
