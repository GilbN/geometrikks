import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NEXT } from "../../lib/versions";

export type RedirectRule = { from: string; to: string; status: 301 | 302 };

const RULE_LIMIT = 2000;

function docsPath(key: string, prefix = "/docs"): string {
  return key === "" ? `${prefix}/` : `${prefix}/${key}/`;
}

function slugProblem(slug: string): string | null {
  if (slug.startsWith("/") || slug.endsWith("/")) return "has a leading or trailing slash";
  if (slug === "docs" || slug.startsWith("docs/")) return 'starts with "docs/"';
  if (slug.split("/").includes("")) return "has an empty segment";
  return null;
}

function checkSlugs(renames: Record<string, string>): void {
  const shape = 'write slugs as "operate/geolite2", without "/docs/" or slashes at either end';
  for (const [old, target] of Object.entries(renames)) {
    const oldProblem = old === "" ? "is empty" : slugProblem(old);
    if (oldProblem) throw new Error(`renames.json: key ${JSON.stringify(old)} is not a slug: it ${oldProblem}; ${shape}`);
    const targetProblem = target === "" ? null : slugProblem(target);
    if (targetProblem) {
      throw new Error(`renames.json: target ${JSON.stringify(target)} is not a slug: it ${targetProblem}; ${shape}`);
    }
  }
}

function checkRenames(renames: Record<string, string>, latest: Set<string>, next: Set<string>): void {
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
  renames: Record<string, string>;
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

/** Next copies `public/` into `out/`, so a hand-written `public/_redirects` would land there first. */
export function writeRedirects(outDir: string, rules: RedirectRule[]): void {
  const path = join(outDir, "_redirects");
  if (existsSync(path)) {
    throw new Error(
      "out/_redirects exists before postbuild wrote it. Next copies public/ into out/, so delete public/_redirects and put renames in content/renames.json. If postbuild already ran on this out/, run the whole build again.",
    );
  }
  writeFileSync(path, formatRedirects(rules));
}
