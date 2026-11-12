import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { checkAppDocsUrls, findAppDocsUrls } from "./lib/app-links";
import { findDeadLinks } from "./lib/links";
import { exportedPages } from "./lib/out-pages";
import { buildRedirects, type RedirectRule, writeRedirects } from "./lib/redirects";

const siteRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(siteRoot, "..");
const outDir = join(siteRoot, "out");
const contentDir = resolve(siteRoot, process.env.DOCS_CONTENT_DIR ?? "content");

function fail(summary: string, lines: string[] = []): never {
  console.error(`postbuild: ${summary}`);
  for (const line of lines) console.error(`  ${line}`);
  process.exit(1);
}

const notFoundPage = join(outDir, "404.html");
if (existsSync(notFoundPage)) {
  console.log("postbuild: 404.html present");
} else {
  const exported = ["_not-found/index.html", "404/index.html"].find((path) => existsSync(join(outDir, path)));
  if (!exported) fail("no not-found HTML in out/ (404.html, _not-found/index.html, 404/index.html)");
  copyFileSync(join(outDir, exported), notFoundPage);
  console.log(`postbuild: 404.html copied from ${exported}`);
}

const pages = exportedPages(outDir);
const renames: unknown = JSON.parse(readFileSync(join(contentDir, "renames.json"), "utf8"));
let rules: RedirectRule[];
try {
  rules = buildRedirects({ ...pages, renames });
  writeRedirects(outDir, join(siteRoot, "public"), rules);
} catch (error) {
  fail((error as Error).message);
}
console.log(
  `postbuild: ${rules.length} redirects written to out/_redirects (${pages.latest.size} latest pages, ${pages.next.size} next pages)`,
);

const deadLinks = findDeadLinks(outDir, rules);
if (deadLinks.length > 0) fail(`${deadLinks.length} dead links in out/`, deadLinks);
console.log("postbuild: no dead links in out/");

if (contentDir !== resolve(siteRoot, "content")) {
  console.log(`postbuild: app docs URL check skipped, DOCS_CONTENT_DIR is ${relative(siteRoot, contentDir)}`);
} else {
  const scanned = [
    "geometrikks",
    "resources",
    "README.md",
    // Named one by one: a main checkout's docs/superpowers/ holds untracked plans full of example URLs.
    "docs/proxy-setup.md",
    "docs/configuration.md",
    ".env.example",
    "Dockerfile",
  ];
  const found = findAppDocsUrls(scanned.map((path) => join(repoRoot, path))).map((entry) => ({
    ...entry,
    file: relative(repoRoot, entry.file),
  }));
  const problems = checkAppDocsUrls(found, outDir, rules);
  if (problems.length > 0) fail(`${problems.length} app docs URLs do not resolve`, problems);
  console.log(`postbuild: ${found.length} app docs URLs resolve`);
}
