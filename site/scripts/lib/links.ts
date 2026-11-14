import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RedirectRule } from "./redirects";

const ATTRIBUTE = /\s(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const SCRIPT_BODY = /(<script\b[^>]*>)[\s\S]*?<\/script>/gi;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const ID_ATTRIBUTE = /\sid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

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

function exportedFile(outDir: string, path: string): string | null {
  const relative = path.replace(/^\/+/, "");
  const candidates = path.endsWith("/")
    ? [join(outDir, relative, "index.html")]
    : [join(outDir, relative), join(outDir, relative, "index.html")];
  return candidates.find(isFile) ?? null;
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

/** The file in `outDir` that `path` (decoded, root-relative, no query or fragment) lands on, or null. */
function resolveInOut(outDir: string, path: string, rules: RedirectRule[]): string | null {
  const ruleFrom = targetsBySource(rules);
  const target = ruleFrom.get(path);
  if (target === undefined) return exportedFile(outDir, path);
  const landed = exportedFile(outDir, target);
  if (landed !== null) return landed;
  const hop = ruleFrom.get(target);
  return hop === undefined ? null : exportedFile(outDir, hop);
}

export function resolvesInOut(outDir: string, path: string, rules: RedirectRule[]): boolean {
  return resolveInOut(outDir, path, rules) !== null;
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

function elementIds(html: string): Set<string> {
  const ids = new Set<string>();
  for (const match of html.replace(SCRIPT_BODY, "$1").matchAll(ID_ATTRIBUTE)) {
    ids.add(decodeEntities(match[1] ?? match[2] ?? match[3]));
  }
  return ids;
}

function hasFragment(file: string, value: string, idCache: Map<string, Set<string>>): boolean {
  const hash = value.indexOf("#");
  if (hash === -1 || hash === value.length - 1 || !file.endsWith(".html")) return true;
  let fragment: string;
  try {
    fragment = decodeURIComponent(value.slice(hash + 1));
  } catch {
    return false;
  }
  let ids = idCache.get(file);
  if (!ids) {
    ids = elementIds(readFileSync(file, "utf8"));
    idCache.set(file, ids);
  }
  return ids.has(fragment);
}

export function findDeadLinks(outDir: string, rules: RedirectRule[]): string[] {
  const dead: string[] = [];
  const idCache = new Map<string, Set<string>>();
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
        const landed = path === null ? null : resolveInOut(outDir, path, rules);
        isDead =
          path === null ||
          (isDocsPage && attribute === "href" && path.endsWith(".mdx")) ||
          landed === null ||
          !hasFragment(landed, value, idCache);
      }
      if (isDead && !reported.has(raw)) {
        reported.add(raw);
        dead.push(`${file} -> ${raw}`);
      }
    }
  }
  return dead;
}
