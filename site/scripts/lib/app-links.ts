import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { NEXT, SEMVER } from "../../lib/versions";
import { resolvesInOut, rootRelativePath } from "./links";
import type { RedirectRule } from "./redirects";

const DOCS_URL_IN_TEXT = /https:\/\/geometrikks\.dev\/docs\/[^\s"'`<>()\[\]]*/g;
const SCANNED = new Set([".py", ".ts", ".tsx", ".md", ".json"]);

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && SCANNED.has(extname(entry.name))) files.push(path);
  }
  return files.sort();
}

export function findAppDocsUrls(roots: string[]): { file: string; url: string }[] {
  const found: { file: string; url: string }[] = [];
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      const seen = new Set<string>();
      for (const match of readFileSync(file, "utf8").matchAll(DOCS_URL_IN_TEXT)) {
        const url = match[0].replace(/[.,;:!?]+$/, "");
        if (seen.has(url)) continue;
        seen.add(url);
        found.push({ file, url });
      }
    }
  }
  return found;
}

export function checkAppDocsUrls(
  found: { file: string; url: string }[],
  outDir: string,
  rules: RedirectRule[],
): string[] {
  const problems: string[] = [];
  for (const { file, url } of found) {
    const path = rootRelativePath(new URL(url).pathname);
    const firstSegment = path?.split("/")[2] ?? "";
    let reason: string | null = null;
    if (firstSegment === NEXT || SEMVER.test(firstSegment)) reason = "version-prefixed";
    else if (path === null || !resolvesInOut(outDir, path, rules)) reason = "no such page or redirect";
    if (reason) problems.push(`${file}: ${url} (${reason})`);
  }
  return problems;
}
