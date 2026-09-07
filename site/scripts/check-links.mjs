#!/usr/bin/env node
// Fails the build on any root-relative href/src in dist/ that has no file
// behind it. Catches a broken README split or a renamed docs page before
// Cloudflare serves a 404.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const pages = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith(".html")) pages.push(path);
  }
})(DIST);

const attr = /\b(?:href|src)="(\/[^"#?]*)/g;
const dead = new Set();
for (const page of pages) {
  for (const match of readFileSync(page, "utf8").matchAll(attr)) {
    const target = decodeURIComponent(match[1]);
    const candidates = [join(DIST, target), join(DIST, target, "index.html"), join(DIST, `${target}.html`)];
    if (!candidates.some((c) => existsSync(c))) dead.add(`${page.slice(DIST.length)} -> ${target}`);
  }
}

if (dead.size) {
  console.error(`check-links: ${dead.size} dead link(s)\n${[...dead].join("\n")}`);
  process.exit(1);
}
console.log(`check-links: ${pages.length} pages, no dead links`);
