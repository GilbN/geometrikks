import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { contentSlugs } from "../scripts/lib/content";
import { stripCode } from "../scripts/lib/markdown";

const nextDir = join(import.meta.dir, "../content/docs/next");
const CONFIGURATION_PAGE = "reference/configuration.mdx";

const EXTRA_ENV_NAMES = new Set([
  "GEOMETRIKKS_ENV_FILE",
  "IT_DB_HOST",
  "IT_DB_PORT",
  "IT_DB_USER",
  "IT_DB_PASSWORD",
  "IT_DB_NAME",
  "DISABLE_ROTATION_CHECK",
  "DISABLE_WAIT",
  // Legacy names: the fields carrying LEGACY_FIELD_MARKER in geometrikks/config/settings.py.
  "LOGPARSER_HOST_NAME",
  "MAP_HOME_LOCATIONS",
  "MAP_HOME_LATITUDE",
  "MAP_HOME_LONGITUDE",
  "MAP_AUTO_DETECT_HOME",
  "MAP_HOME_REFRESH_HOURS",
]);

const INLINE_ENV_NAME = /`([A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9])(=[^`]*)?`/g;
const FENCED_ENV_NAME = /^\s*-?\s*([A-Z][A-Z0-9]*_[A-Z0-9_]+)\s*[=:]/;
const CONFIGURATION_ROW = /^\| `([A-Z0-9_]+)` \|/gm;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ABSOLUTE_DOCS_LINK = /\]\(\s*<?\/docs\/|\bhref\s*=\s*\{?\s*["'`]\/docs\//;

const linksAbsolutely = (source: string) => ABSOLUTE_DOCS_LINK.test(stripCode(source));

function files(root: string, prefix = ""): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...files(root, path));
    else paths.push(path);
  }
  return paths.sort();
}

const pages = files(nextDir).filter((path) => path.endsWith(".mdx"));
const metas = files(nextDir).filter((path) => path.endsWith("meta.json"));
const read = (path: string) => readFileSync(join(nextDir, path), "utf8");

function frontmatter(source: string): Record<string, string> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1] ?? "";
  const keys: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (match) keys[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  }
  return keys;
}

function envNames(source: string): string[] {
  const names: string[] = [];
  const prose: string[] = [];
  let fence: string | null = null;
  for (const line of source.split("\n")) {
    const opener = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (opener?.[0] === fence[0] && opener.length >= fence.length) fence = null;
      else {
        const name = FENCED_ENV_NAME.exec(line)?.[1];
        if (name) names.push(name);
      }
    } else if (opener) {
      fence = opener;
    } else {
      prose.push(line);
    }
  }
  for (const match of prose.join("\n").matchAll(INLINE_ENV_NAME)) names.push(match[1]);
  return names;
}

describe("content/docs/next", () => {
  test("pages link to each other with relative file links", () => {
    const absolute = pages.filter((page) => linksAbsolutely(read(page)));
    expect(absolute).toEqual([]);
  });

  test("pages have no em dash and no HTML comments", () => {
    const offending = [...pages, ...metas].flatMap((path) => {
      const source = read(path);
      return [
        ...(source.includes("\u2014") ? [`${path}: em dash`] : []),
        ...(source.includes("<!--") ? [`${path}: HTML comment`] : []),
      ];
    });
    expect(offending).toEqual([]);
  });

  test("pages have a title and a description", () => {
    const missing = pages.flatMap((page) => {
      const keys = frontmatter(read(page));
      return ["title", "description"].filter((key) => !keys[key]).map((key) => `${page}: ${key}`);
    });
    expect(missing).toEqual([]);
  });

  test("env vars named in pages are documented", () => {
    const documented = new Set([...read(CONFIGURATION_PAGE).matchAll(CONFIGURATION_ROW)].map((match) => match[1]));
    expect(documented.size).toBeGreaterThan(0);
    const undocumented = pages
      .filter((page) => page !== CONFIGURATION_PAGE)
      .flatMap((page) =>
        [...new Set(envNames(read(page)))]
          .filter((name) => !documented.has(name) && !EXTRA_ENV_NAMES.has(name))
          .map((name) => `${page}: ${name}`),
      );
    expect(undocumented).toEqual([]);
  });
});

describe("linksAbsolutely", () => {
  test.each([
    "[a](/docs/next/quickstart/)",
    '<a href="/docs/quickstart/">a</a>',
    "<a href={`/docs/next/quickstart/`}>a</a>",
    "`code` then <a href={`/docs/next/quickstart/`}>a</a> and `more`",
    "See ``` [a](/docs/next/quickstart/) `` here.",
  ])("flags %p", (source) => {
    expect(linksAbsolutely(source)).toBe(true);
  });

  test.each([
    "Never write `[a](/docs/next/quickstart/)`.",
    "Write `<a href={`/docs/next/quickstart/`}>` as a relative link.",
    "```jsx\n<a href={`/docs/next/quickstart/`}>a</a>\n```",
    "[Quickstart](./quickstart.mdx)",
  ])("passes %p", (source) => {
    expect(linksAbsolutely(source)).toBe(false);
  });
});

describe("envNames", () => {
  test("reads inline code spans and fenced assignments", () => {
    const source = [
      "Set `LOG_LEVEL` or `DB_HOST=db`, not `Db_host` or `PATH`.",
      "```yaml",
      "environment:",
      "  - APP_ADMIN_USER=admin",
      "  GEOIP_DB_PATH: /data",
      "```",
      "MAP_PROSE_NAME=1 outside a fence is prose.",
    ].join("\n");
    expect(envNames(source).sort()).toEqual(["APP_ADMIN_USER", "DB_HOST", "GEOIP_DB_PATH", "LOG_LEVEL"]);
  });
});

describe("contentSlugs", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  test("contentSlugs strips .mdx and index", () => {
    const versionDir = mkdtempSync(join(tmpdir(), "docs-content-"));
    roots.push(versionDir);
    for (const file of ["index.mdx", "a/b.mdx", "c/index.mdx", "(group)/d.mdx", "meta.json", "a/meta.json"]) {
      mkdirSync(dirname(join(versionDir, file)), { recursive: true });
      writeFileSync(join(versionDir, file), "");
    }
    expect(contentSlugs(versionDir)).toEqual(new Set(["", "a/b", "c", "d"]));
  });
});
