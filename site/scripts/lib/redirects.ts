import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NEXT, SEMVER } from "../../lib/versions";

export type RedirectRule = { from: string; to: string; status: 301 | 302 };

const RULE_LIMIT = 2000;

function docsPath(key: string, prefix = "/docs"): string {
  return key === "" ? `${prefix}/` : `${prefix}/${key}/`;
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function slugProblem(slug: string): string | null {
  if (slug.startsWith("/") || slug.endsWith("/")) return "has a leading or trailing slash";
  if (slug === "docs" || slug.startsWith("docs/")) return 'starts with "docs/"';
  const segments = slug.split("/");
  if (segments.includes("")) return "has an empty segment";
  if (segments.some((segment) => segment === "." || segment === "..")) return 'has a "." or ".." segment';
  const bad = segments.find((segment) => !SEGMENT.test(segment));
  if (bad !== undefined) {
    return `has the segment ${JSON.stringify(bad)}, which is not letters, digits, ".", "_" and "-" starting with a letter or digit`;
  }
  if (/\.mdx?$/i.test(slug)) return "ends in a file extension; drop the .mdx or .md";
  if (segments.at(-1) === "index") return 'ends in "index"; name the folder instead, or use "" for the docs index';
  if (segments[0] === NEXT || SEMVER.test(segments[0])) {
    return `starts with the version folder ${JSON.stringify(segments[0])}; renames apply to every version, so leave it out`;
  }
  return null;
}

function checkSlugs(renames: unknown): asserts renames is Record<string, string> {
  if (typeof renames !== "object" || renames === null || Array.isArray(renames)) {
    throw new Error('renames.json must be an object that maps old slugs to new ones, such as {"old-name": "renamed"}');
  }
  const shape = 'write slugs as "operate/geolite2", without "/docs/" or slashes at either end';
  for (const [old, target] of Object.entries(renames)) {
    const oldProblem = old === "" ? "is empty" : slugProblem(old);
    if (oldProblem) throw new Error(`renames.json: key ${JSON.stringify(old)} is not a slug: it ${oldProblem}; ${shape}`);
    if (typeof target !== "string") {
      throw new Error(`renames.json: key ${JSON.stringify(old)} maps to ${JSON.stringify(target)}, which is not a slug string; ${shape}`);
    }
    const targetProblem = target === "" ? null : slugProblem(target);
    if (targetProblem) {
      throw new Error(`renames.json: target ${JSON.stringify(target)} is not a slug: it ${targetProblem}; ${shape}`);
    }
  }
}

function checkRenames(
  renames: unknown,
  latest: Set<string>,
  next: Set<string>,
): asserts renames is Record<string, string> {
  checkSlugs(renames);
  for (const start of Object.keys(renames)) {
    const seen = new Set([start]);
    let current = renames[start];
    while (current !== undefined && Object.hasOwn(renames, current)) {
      if (seen.has(current)) throw new Error(`renames.json has a cycle: ${[...seen, current].join(" -> ")}`);
      seen.add(current);
      current = renames[current];
    }
  }
  for (const old of Object.keys(renames)) {
    if (next.has(old)) throw new Error(`renames.json: "${old}" still exists in next; remove the page or the rename`);
  }
  for (const [old, target] of Object.entries(renames)) {
    if (!latest.has(target) && !next.has(target)) {
      throw new Error(`renames.json: "${old}" points at target "${target}", which is in neither latest nor next`);
    }
  }
}

export function buildRedirects(input: {
  latest: Set<string>;
  next: Set<string>;
  renames: unknown;
}): RedirectRule[] {
  const { latest, next, renames } = input;
  checkRenames(renames, latest, next);

  const sources: { key: string; to: string; status: 301 | 302 }[] = [];
  for (const [old, target] of Object.entries(renames)) {
    if (!latest.has(old)) sources.push({ key: old, to: docsPath(target), status: 301 });
  }
  for (const key of [...next].sort()) {
    if (latest.has(key) || Object.hasOwn(renames, key)) continue;
    sources.push({ key, to: docsPath(key, `/docs/${NEXT}`), status: 302 });
  }

  const rules: RedirectRule[] = [];
  for (const source of sources) {
    if (latest.has(source.key)) throw new Error(`redirect from ${docsPath(source.key)} would shadow a latest page`);
    const from = docsPath(source.key);
    rules.push({ from, to: source.to, status: source.status });
    rules.push({ from: from.slice(0, -1), to: source.to, status: source.status });
  }
  if (rules.length > RULE_LIMIT) {
    throw new Error(`${rules.length} redirect rules exceed the Workers limit of 2,000 static redirects`);
  }
  return rules;
}

export function formatRedirects(rules: RedirectRule[]): string {
  return rules.map((rule) => `${rule.from} ${rule.to} ${rule.status}\n`).join("");
}

/** Next copies `public/` into `out/`, and this overwrites `out/_redirects`, so a `public/_redirects` would vanish. */
export function writeRedirects(outDir: string, publicDir: string, rules: RedirectRule[]): void {
  if (existsSync(join(publicDir, "_redirects"))) {
    throw new Error(
      "public/_redirects exists, and postbuild would overwrite its copy in out/. Delete public/_redirects and put renames in content/renames.json.",
    );
  }
  writeFileSync(join(outDir, "_redirects"), formatRedirects(rules));
}
