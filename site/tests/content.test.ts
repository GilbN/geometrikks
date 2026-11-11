import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { contentSlugs } from "../scripts/lib/content";
import { visit } from "unist-util-visit";
import { extractLinks, parseMarkdown } from "../scripts/lib/markdown";

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

const INLINE_ENV_NAME = /^([A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9])(?:=[\s\S]*)?$/;
const FENCED_ENV_NAME = /^\s*-?\s*([A-Z][A-Z0-9]*_[A-Z0-9_]+)\s*[=:]/;
const CONFIGURATION_ROW = /^\| `([A-Z0-9_]+)` \|/gm;
const ABSOLUTE_DOCS_LINK = /^\/docs(?:[/#?]|$)/;

/** The page's absolute /docs links, or its parse error. */
function linkProblems(source: string): string[] {
  try {
    return extractLinks(source).filter((link) => ABSOLUTE_DOCS_LINK.test(link));
  } catch (error) {
    return [`parse error: ${error instanceof Error ? error.message : String(error)}`];
  }
}

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
  visit(parseMarkdown(source), (node) => {
    if (node.type === "inlineCode") {
      const name = INLINE_ENV_NAME.exec(node.value)?.[1];
      if (name) names.push(name);
    } else if (node.type === "code") {
      for (const line of node.value.split("\n")) {
        const name = FENCED_ENV_NAME.exec(line)?.[1];
        if (name) names.push(name);
      }
    }
  });
  return names;
}

describe("content/docs/next", () => {
  test("pages link to each other with relative file links", () => {
    const problems = pages.flatMap((page) => linkProblems(read(page)).map((problem) => `${page}: ${problem}`));
    expect(problems).toEqual([]);
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

describe("linkProblems", () => {
  test.each([
    "[a](/docs/next/quickstart/)",
    '<a href="/docs/quickstart/">a</a>',
    '<a href={"/docs/next/x/"}>a</a>',
    "<a href={`/docs/next/quickstart/`}>a</a>",
    "`code` then <a href={`/docs/next/quickstart/`}>a</a> and `more`",
    "See ``` [a](/docs/next/quickstart/) `` here.",
    "[r]: /docs/next/x/",
    "![shot](/docs/next/x.png)",
    "Stray ` tick\n```\nx\n```\n[a](/docs/next/q/) and `y`",
    "Press the ` key.\n```bash\necho `date`\n```\n\n[a](/docs/next/q/)",
    "<span title={`}`} /> [a](/docs/next/quickstart/) then `example`",
    '{<a href="/docs/next/quickstart/">Guide</a>}',
    'See {cond && <img src={"/docs/next/x.png"} />} here.',
    "{<a href={`/docs/next/quickstart/`}>Guide</a>}",
  ])("flags %p", (source) => {
    expect(linkProblems(source)).toHaveLength(1);
    expect(linkProblems(source)[0]).toMatch(/^\/docs\//);
  });

  test.each([
    "Never write `[a](/docs/next/quickstart/)`.",
    "Write `<a href={`/docs/next/quickstart/`}>` as a relative link.",
    "```jsx\n<a href={`/docs/next/quickstart/`}>a</a>\n```",
    "```mdx\n[a](/docs/next/x/)\n```",
    '```mdx\n{<a href="/docs/next/quickstart/">Guide</a>}\n```',
    '`{<a href="/docs/next/quickstart/">Guide</a>}`',
    "[Quickstart](./quickstart.mdx)",
    "---\ntitle: A { page\ndescription: <b>\n---\n\n[Quickstart](./quickstart.mdx)",
  ])("passes %p", (source) => {
    expect(linkProblems(source)).toEqual([]);
  });

  test("reports a page that fails to parse as MDX", () => {
    expect(linkProblems("An unclosed { brace and [a](/docs/next/x/)")).toEqual([
      expect.stringMatching(/^parse error: .*brace/),
    ]);
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
