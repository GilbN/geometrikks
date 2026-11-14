import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exportedPages } from "../scripts/lib/out-pages";
import { buildRedirects, formatRedirects } from "../scripts/lib/redirects";

const latest = new Set(["", "quickstart", "old-name"]);
const next = new Set(["", "quickstart", "new-feature", "renamed"]);

describe("buildRedirects", () => {
  test("sends next-only pages to next, with and without the trailing slash", () => {
    const rules = buildRedirects({ latest, next, renames: { "old-name": "renamed" } });
    expect(rules).toContainEqual({ from: "/docs/new-feature/", to: "/docs/next/new-feature/", status: 302 });
    expect(rules).toContainEqual({ from: "/docs/new-feature", to: "/docs/next/new-feature/", status: 302 });
    expect(rules).toContainEqual({ from: "/docs/renamed/", to: "/docs/next/renamed/", status: 302 });
    expect(rules).toContainEqual({ from: "/docs/renamed", to: "/docs/next/renamed/", status: 302 });
  });

  test("leaves pages latest still serves alone", () => {
    const rules = buildRedirects({ latest, next, renames: { "old-name": "renamed" } });
    expect(rules.some((r) => r.from.startsWith("/docs/old-name"))).toBe(false);
    expect(rules.some((r) => r.from === "/docs/quickstart/")).toBe(false);
    expect(rules.some((r) => r.from === "/docs/quickstart")).toBe(false);
    expect(rules.some((r) => r.from === "/docs/" || r.from === "/docs")).toBe(false);
    expect(rules).toHaveLength(4);
  });

  test("emits a rename once the old page has left latest", () => {
    const promoted = buildRedirects({
      latest: new Set(["", "renamed"]),
      next: new Set(["", "renamed"]),
      renames: { "old-name": "renamed" },
    });
    expect(promoted).toContainEqual({ from: "/docs/old-name/", to: "/docs/renamed/", status: 301 });
    expect(promoted).toContainEqual({ from: "/docs/old-name", to: "/docs/renamed/", status: 301 });
    expect(promoted).toHaveLength(2);
  });

  test("with no latest, a rename and the next-only rule form a chain", () => {
    const rules = buildRedirects({ latest: new Set(), next: new Set(["", "new"]), renames: { old: "new" } });
    expect(rules).toContainEqual({ from: "/docs/old/", to: "/docs/new/", status: 301 });
    expect(rules).toContainEqual({ from: "/docs/new/", to: "/docs/next/new/", status: 302 });
  });

  test("sends the docs index to next when latest is empty", () => {
    const rules = buildRedirects({ latest: new Set(), next: new Set([""]), renames: {} });
    expect(rules).toContainEqual({ from: "/docs/", to: "/docs/next/", status: 302 });
    expect(rules).toContainEqual({ from: "/docs", to: "/docs/next/", status: 302 });
    expect(rules).toHaveLength(2);
  });

  test("rejects a rename whose old page still exists in next", () => {
    expect(() => buildRedirects({ latest, next, renames: { renamed: "x" } })).toThrow(/still exists in next/);
  });

  test("checks for a cycle before anything else", () => {
    expect(() => buildRedirects({ latest, next, renames: { a: "b", b: "a" } })).toThrow(/cycle/);
    expect(() => buildRedirects({ latest, next, renames: { a: "a" } })).toThrow(/cycle/);
    expect(() => buildRedirects({ latest, next, renames: { a: "b", b: "c", c: "a" } })).toThrow(/cycle/);
  });

  test("rejects a rename whose target is in neither version", () => {
    expect(() => buildRedirects({ latest, next, renames: { gone: "nowhere" } })).toThrow(/target/);
  });

  test("refuses more than 2,000 rules", () => {
    const many = new Set([""]);
    for (let index = 0; index < 999; index++) many.add(`page-${index}`);
    expect(buildRedirects({ latest: new Set(), next: many, renames: {} })).toHaveLength(2000);
    many.add("page-999");
    expect(() => buildRedirects({ latest: new Set(), next: many, renames: {} })).toThrow(/2,000/);
  });
});

describe("formatRedirects", () => {
  test("writes one line per rule", () => {
    expect(formatRedirects([{ from: "/a/", to: "/b/", status: 301 }])).toBe("/a/ /b/ 301\n");
    expect(
      formatRedirects([
        { from: "/a/", to: "/b/", status: 301 },
        { from: "/a", to: "/b/", status: 301 },
      ]),
    ).toBe("/a/ /b/ 301\n/a /b/ 301\n");
  });
});

describe("exportedPages", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  test("splits exported index.html files into latest and next slugs", () => {
    const outDir = mkdtempSync(join(tmpdir(), "docs-out-"));
    roots.push(outDir);
    const files = [
      "index.html",
      "404.html",
      "docs/index.html",
      "docs/quickstart/index.html",
      "docs/guides/nested/index.html",
      "docs/next/index.html",
      "docs/next/guides/nested/index.html",
      "docs/next/new-feature/index.html",
      "docs/__next._tree.txt",
      "docs/quickstart/index.txt",
    ];
    for (const file of files) {
      mkdirSync(dirname(join(outDir, file)), { recursive: true });
      writeFileSync(join(outDir, file), "");
    }
    const pages = exportedPages(outDir);
    expect([...pages.latest].sort()).toEqual(["", "guides/nested", "quickstart"]);
    expect([...pages.next].sort()).toEqual(["", "guides/nested", "new-feature"]);
  });
});
