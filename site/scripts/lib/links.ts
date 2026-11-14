import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RedirectRule } from "./redirects";

const ATTRIBUTE = /\s(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const SCRIPT_BODY = /(<script\b[^>]*>)[\s\S]*?<\/script>/gi;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

function stripSuffix(value: string): string {
  const suffixStart = value.search(/[?#]/);
  return suffixStart === -1 ? value : value.slice(0, suffixStart);
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function isExported(outDir: string, path: string): boolean {
  const relative = path.replace(/^\/+/, "");
  if (path.endsWith("/")) return isFile(join(outDir, relative, "index.html"));
  return isFile(join(outDir, relative)) || isFile(join(outDir, relative, "index.html"));
}

const ruleMaps = new WeakMap<RedirectRule[], Map<string, string>>();

function targetsBySource(rules: RedirectRule[]): Map<string, string> {
  let map = ruleMaps.get(rules);
  if (!map) {
    map = new Map(rules.map((rule) => [rule.from, rule.to]));
    ruleMaps.set(rules, map);
  }
  return map;
}

/** `path` is a decoded root-relative path with no query or fragment. */
export function resolvesInOut(outDir: string, path: string, rules: RedirectRule[]): boolean {
  const ruleFrom = targetsBySource(rules);
  const target = ruleFrom.get(path);
  if (target === undefined) return isExported(outDir, path);
  if (isExported(outDir, target)) return true;
  const hop = ruleFrom.get(target);
  return hop !== undefined && isExported(outDir, hop);
}

export function rootRelativePath(value: string): string | null {
  try {
    return decodeURIComponent(stripSuffix(value));
  } catch {
    return null;
  }
}

function htmlFiles(outDir: string): string[] {
  return readdirSync(outDir, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".html"))
    .map((entry) => entry.split("\\").join("/"))
    .sort();
}

export function findDeadLinks(outDir: string, rules: RedirectRule[]): string[] {
  const dead: string[] = [];
  for (const file of htmlFiles(outDir)) {
    const isDocsPage = file.startsWith("docs/");
    const html = readFileSync(join(outDir, file), "utf8").replace(SCRIPT_BODY, "$1");
    const reported = new Set<string>();
    for (const match of html.matchAll(ATTRIBUTE)) {
      const attribute = match[1].toLowerCase();
      const raw = match[2] ?? match[3];
      const value = decodeEntities(raw).trim();
      if (value === "" || value.startsWith("#") || value.startsWith("//") || SCHEME.test(value)) continue;

      let isDead: boolean;
      if (!value.startsWith("/")) {
        isDead = isDocsPage && attribute === "href";
      } else {
        const path = rootRelativePath(value);
        isDead =
          path === null ||
          (isDocsPage && attribute === "href" && path.endsWith(".mdx")) ||
          !resolvesInOut(outDir, path, rules);
      }
      if (isDead && !reported.has(raw)) {
        reported.add(raw);
        dead.push(`${file} -> ${raw}`);
      }
    }
  }
  return dead;
}
