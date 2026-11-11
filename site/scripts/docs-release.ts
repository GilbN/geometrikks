import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { compareSemver, NEXT, SEMVER } from "../lib/versions";
import { stripCode } from "./lib/markdown";
import { imageExists, publishedFromEnv } from "./lib/registry";
import { resolveVersions } from "./lib/resolve-versions";

export type ReleaseOptions = {
  version: string;
  contentDir: string;
  openapiSource: string;
  isPublished: (version: string) => Promise<boolean>;
};

export type ReleaseResult = { folder: string; refreshed: boolean; dropped: string[] };

const NEXT_LINK =
  /(?:\]\(\s*<?|\b(?:href|src)\s*=\s*\{?\s*["'`]|^\s*\[[^\]]+\]:\s*<?)(?:https?:\/\/[^/\s)"'`>]+)?\/docs\/next(?=[/)#?"'`>\s]|$)/m;

function walk(root: string, prefix = ""): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    paths.push(path);
    if (entry.isDirectory()) paths.push(...walk(root, path));
  }
  return paths;
}

function firstSlug(path: string): string | undefined {
  const segments = path.split("/");
  const name = segments.pop()!.replace(/\.mdx?$/, "");
  const slugs = segments.filter((segment) => !/^\(.+\)$/.test(segment));
  if (name !== "index") slugs.push(name);
  return slugs[0];
}

function gitIgnored(cwd: string, paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();
  const result = spawnSync("git", ["check-ignore", "-z", "--stdin"], {
    cwd,
    input: paths.join("\0"),
    encoding: "utf8",
  });
  if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
  if (result.status === 1) return new Set();
  if (result.status === 128 && result.stderr.includes("not a git repository")) return new Set();
  if (result.status !== 0) throw new Error(`git check-ignore failed: ${result.stderr.trim() || result.error}`);
  return new Set(result.stdout.split("\0").filter((path) => path !== ""));
}

function isSkipped(path: string, ignored: Set<string>): boolean {
  const parts = path.split("/");
  return parts.some((_, index) => ignored.has(parts.slice(0, index + 1).join("/")));
}

export async function releaseDocs(opts: ReleaseOptions): Promise<ReleaseResult> {
  const { version, contentDir, openapiSource, isPublished } = opts;
  if (/^v\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`image tags have no v prefix: use ${version.slice(1)}`);
  }
  if (!SEMVER.test(version)) throw new Error(`${version} is not a bare X.Y.Z version`);
  if (await isPublished(version)) throw new Error(`${version} is published; its folder is frozen`);

  const docsDir = join(contentDir, "docs");
  const plan = await resolveVersions(docsDir, isPublished);
  if (plan.latest !== null && compareSemver(version, plan.latest) < 0) {
    throw new Error(`${version} is older than the latest release ${plan.latest}`);
  }
  const otherPending = plan.pending.filter((folder) => folder !== version);
  if (otherPending.length > 0) {
    throw new Error(
      `pending release folder ${otherPending.join(", ")} is not on ghcr.io yet; publish it or delete it before releasing ${version}`,
    );
  }
  if (!existsSync(openapiSource)) throw new Error(`OpenAPI schema ${openapiSource} is missing`);

  const nextDir = join(docsDir, NEXT);
  const allPaths = walk(nextDir);
  const ignored = gitIgnored(nextDir, allPaths);
  const copied = allPaths.filter((path) => !isSkipped(path, ignored));
  const shown = (path: string) => relative(contentDir, join(nextDir, path)).split(sep).join("/");

  const nextSlug = copied.filter((path) => /\.mdx?$/.test(path) && firstSlug(path) === NEXT);
  if (nextSlug.length > 0) {
    throw new Error(
      `${nextSlug.map(shown).join(", ")} would get the top-level slug next, which clashes with /docs/next/; rename it`,
    );
  }

  const linking = copied.filter(
    (path) => /\.mdx?$/.test(path) && NEXT_LINK.test(stripCode(readFileSync(join(nextDir, path), "utf8"))),
  );
  if (linking.length > 0) {
    throw new Error(
      `${linking.map(shown).join(", ")} link to /docs/next/, which breaks once the folder is latest; use relative file links such as ./quickstart.mdx`,
    );
  }

  const folder = join(docsDir, version);
  const refreshed = existsSync(folder);
  rmSync(folder, { recursive: true, force: true });
  cpSync(nextDir, folder, {
    recursive: true,
    filter: (source) => {
      const path = relative(nextDir, source).split(sep).join("/");
      return path === "" || !isSkipped(path, ignored);
    },
  });

  const metaPath = join(folder, "meta.json");
  const nextMeta = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, "utf8")) as { pages?: unknown }) : {};
  const meta = { title: version, root: "version", ...(nextMeta.pages === undefined ? {} : { pages: nextMeta.pages }) };
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

  const openapiDir = join(contentDir, "openapi");
  mkdirSync(openapiDir, { recursive: true });
  copyFileSync(openapiSource, join(openapiDir, `${version}.json`));

  for (const superseded of plan.superseded) {
    rmSync(join(docsDir, superseded), { recursive: true, force: true });
    rmSync(join(openapiDir, `${superseded}.json`), { force: true });
  }

  return { folder, refreshed, dropped: plan.superseded };
}

if (import.meta.main) {
  const version = process.argv[2];
  if (version === undefined) {
    console.error("usage: bun run docs:release X.Y.Z");
    process.exit(1);
  }
  const siteRoot = resolve(import.meta.dir, "..");
  try {
    const result = await releaseDocs({
      version,
      contentDir: resolve(siteRoot, process.env.DOCS_CONTENT_DIR ?? "content"),
      openapiSource: resolve(siteRoot, "../resources/generated/openapi.json"),
      isPublished: publishedFromEnv(process.env) ?? ((candidate: string) => imageExists(candidate)),
    });
    console.log(
      `docs:release: folder=${relative(siteRoot, result.folder)} refreshed=${result.refreshed} dropped=[${result.dropped.join(", ")}]`,
    );
  } catch (error) {
    console.error(`docs:release: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
