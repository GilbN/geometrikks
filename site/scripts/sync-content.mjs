#!/usr/bin/env node
// Turns the repo's README, docs/, screenshots, the runr font and the package
// version into the inputs the site builds from. Pure Node, no dependencies,
// idempotent: every run wipes and rewrites the generated folders.
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(SITE, "..");
const DOCS_OUT = join(SITE, "src/content/docs/docs");
const SHOTS_OUT = join(SITE, "src/assets/screenshots");
const FONTS_OUT = join(SITE, "public/fonts");
const DATA_OUT = join(SITE, "src/data");

// README H2 title -> docs page. `merge` folds the section into the named
// page as an H2 instead of making a page of its own.
export const pageMap = {
  Quickstart: { path: "get-started/quickstart", order: 1 },
  "Docker image tags": { merge: "get-started/quickstart" },
  Configuration: { path: "get-started/configuration", order: 2 },
  "Nginx setup": { path: "sources/nginx", order: 1, title: "nginx" },
  "Traefik setup": { path: "sources/traefik", order: 2, title: "Traefik" },
  "Caddy setup": { path: "sources/caddy", order: 3, title: "Caddy" },
  "MaxMind GeoLite2": { path: "operate/geolite2", order: 1 },
  "Map tiles": { merge: "operate/geolite2" },
  Authentication: { path: "operate/authentication", order: 2 },
  "Running behind a reverse proxy": { path: "operate/reverse-proxy", order: 3, title: "Reverse proxy" },
  "CrowdSec integration (optional)": { path: "features/crowdsec", order: 1, title: "CrowdSec integration" },
  "Multi-source setup": { path: "features/multi-source", order: 2 },
  "CLI commands": { path: "features/cli", order: 3 },
  FAQ: { path: "reference/faq", order: 5 },
  Development: { path: "contribute/development", order: 1 },
};

// README sections the landing page covers instead.
const SKIP = new Set(["Features"]);

// Standalone Markdown files -> docs page.
export const fileMap = {
  "docs/configuration.md": {
    path: "reference/configuration",
    order: 1,
    title: "Configuration reference",
    tableOfContents: { maxHeadingLevel: 2 },
  },
  "docs/proxy-setup.md": { path: "sources/proxy-setup", order: 4, title: "Real client IP behind a proxy" },
  "docs/deployment.md": { path: "operate/deployment", order: 4, title: "Deployment" },
  "docs/api-conventions.md": { path: "reference/api-conventions", order: 2, title: "API conventions" },
  "CHANGELOG.md": { path: "reference/changelog", order: 3, title: "Changelog" },
  "SECURITY.md": { path: "reference/security", order: 4, title: "Security policy" },
};

const FENCE = /^(```|~~~)/;

/** Split Markdown into H2 sections, ignoring headings inside code fences. */
export function splitReadme(md) {
  const sections = [];
  let current = null;
  let inFence = false;
  for (const line of md.split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    if (!inFence && line.startsWith("## ")) {
      current = { title: line.slice(3).trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return sections.map((s) => ({ title: s.title, body: s.lines.join("\n").trim() }));
}

/** GitHub's heading anchor for the headings this repo uses. */
export function slugify(heading) {
  return heading
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/ /g, "-");
}

/** Every H2/H3 in a body, fence-aware. */
function headings(body, levels = /^(##|###) /) {
  const out = [];
  let inFence = false;
  for (const line of body.split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    if (!inFence && levels.test(line)) out.push(line.replace(/^#+ /, "").trim());
  }
  return out;
}

/**
 * Rewrite link targets for the docs site.
 * ctx.anchors maps a README anchor slug to a site path (with optional #hash).
 * Unknown README anchors throw so a broken cross-reference fails the build.
 */
export function rewriteLinks(md, ctx) {
  return md.replace(/\]\(([^)\s]+)\)/g, (whole, target) => {
    if (/^(https?:)?\/\//.test(target) || target.startsWith("mailto:")) return whole;
    const shots = target.match(/^\/?data\/screenshots\/([^#]+)$/);
    if (shots) return `](../../../../assets/screenshots/${shots[1]})`;
    const doc = target.match(/^\/?docs\/([a-z-]+)\.md(#.*)?$/);
    if (doc) {
      const entry = fileMap[`docs/${doc[1]}.md`];
      if (!entry) throw new Error(`No docs page for ${target}`);
      return `](/docs/${entry.path}/${doc[2] ?? ""})`;
    }
    const top = target.match(/^\/?(CHANGELOG|SECURITY)\.md(#.*)?$/);
    if (top) return `](/docs/${fileMap[`${top[1]}.md`].path}/${top[2] ?? ""})`;
    if (target.startsWith("#")) {
      const dest = ctx.anchors[target.slice(1)];
      if (!dest) throw new Error(`Unknown README anchor ${target}`);
      return `](${dest})`;
    }
    return whole;
  });
}

function firstParagraph(body) {
  const para = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith("#") && !p.startsWith("```") && !p.startsWith("<") && !p.startsWith("!") && !p.startsWith("|"));
  if (!para) return "";
  const text = para
    .replace(/\s+/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "");
  return text.length > 160 ? text.slice(0, 157).trimEnd() + "..." : text;
}

/** Apply pageMap to README sections: pages with frontmatter, merges folded in. */
export function buildPages(sections) {
  const pages = new Map();
  for (const { title, body } of sections) {
    if (SKIP.has(title)) continue;
    const entry = pageMap[title];
    if (!entry) throw new Error(`README section "${title}" has no entry in pageMap`);
    if (entry.merge) {
      const target = pages.get(entry.merge);
      if (!target) throw new Error(`Merge target ${entry.merge} must come before "${title}"`);
      target.body += `\n\n## ${title}\n\n${body}`;
      continue;
    }
    pages.set(entry.path, {
      path: entry.path,
      source: `README.md#${slugify(title)}`,
      frontmatter: {
        title: entry.title ?? title,
        description: firstParagraph(body),
        sidebar: { order: entry.order },
      },
      body,
    });
  }
  return [...pages.values()];
}

/** README anchor slug -> site URL, for every H2 and H3 the README has. */
export function anchorMap(sections) {
  const map = {};
  for (const { title, body } of sections) {
    const entry = pageMap[title];
    if (!entry) continue;
    const path = entry.merge ?? entry.path;
    map[slugify(title)] = entry.merge ? `/docs/${path}/#${slugify(title)}` : `/docs/${path}/`;
    for (const h of headings(body, /^### /)) map[slugify(h)] = `/docs/${path}/#${slugify(h)}`;
  }
  return map;
}

function yaml(value) {
  return JSON.stringify(value);
}

function render(page) {
  const fm = Object.entries(page.frontmatter)
    .map(([k, v]) => `${k}: ${yaml(v)}`)
    .join("\n");
  return `---\n${fm}\n---\n\n<!-- Generated from ${page.source} by site/scripts/sync-content.mjs. Do not edit; change the source. -->\n\n${page.body}\n`;
}

function stripH1(md) {
  return md.replace(/^# .*\n+/, "");
}

function writePage(page) {
  const file = join(DOCS_OUT, `${page.path}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, render(page));
}

export function main() {
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  const sections = splitReadme(readme);
  const ctx = { anchors: anchorMap(sections) };

  rmSync(DOCS_OUT, { recursive: true, force: true });
  let count = 0;
  for (const page of buildPages(sections)) {
    page.body = rewriteLinks(page.body, ctx);
    writePage(page);
    count++;
  }
  for (const [rel, entry] of Object.entries(fileMap)) {
    const raw = readFileSync(join(REPO, rel), "utf8");
    const body = rewriteLinks(stripH1(raw), ctx);
    const { path, order, title, ...extra } = entry;
    writePage({
      path,
      source: rel,
      frontmatter: { title, description: firstParagraph(body), sidebar: { order }, ...extra },
      body,
    });
    count++;
  }

  rmSync(SHOTS_OUT, { recursive: true, force: true });
  mkdirSync(SHOTS_OUT, { recursive: true });
  const shotsDir = join(REPO, "data/screenshots");
  for (const f of readdirSync(shotsDir).filter((f) => f.endsWith(".png"))) {
    copyFileSync(join(shotsDir, f), join(SHOTS_OUT, f));
  }

  mkdirSync(FONTS_OUT, { recursive: true });
  copyFileSync(join(REPO, "resources/static/fonts/runr-Regular.woff2"), join(FONTS_OUT, "runr-Regular.woff2"));

  const version = readFileSync(join(REPO, "pyproject.toml"), "utf8").match(/^version = "(.+)"$/m)?.[1];
  if (!version) throw new Error("Could not read version from pyproject.toml");
  mkdirSync(DATA_OUT, { recursive: true });
  writeFileSync(join(DATA_OUT, "meta.json"), JSON.stringify({ version, generatedAt: new Date().toISOString() }, null, 2) + "\n");

  console.log(`sync-content: ${count} docs pages, screenshots, font, version ${version}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
