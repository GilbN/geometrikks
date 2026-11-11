import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exportedPages } from "../scripts/lib/out-pages";
import { buildRedirects, formatRedirects, writeRedirects } from "../scripts/lib/redirects";

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

  test.each([
    [{ "/old": "renamed" }, "/old"],
    [{ "old/": "renamed" }, "old/"],
    [{ "docs/old": "renamed" }, "docs/old"],
    [{ "a//b": "renamed" }, "a//b"],
    [{ "": "renamed" }, '""'],
    [{ old: "/renamed" }, "/renamed"],
    [{ old: "renamed/" }, "renamed/"],
    [{ old: "docs/renamed" }, "docs/renamed"],
    [{ old: "guides//renamed" }, "guides//renamed"],
    [{ "next/foo": "renamed" }, '"next/foo"'],
    [{ "0.24.0/foo": "renamed" }, '"0.24.0/foo"'],
    [{ old: "next/renamed" }, '"next/renamed"'],
    [{ "old page": "renamed" }, '"old page"'],
    [{ "old\nother": "renamed" }, '"old\\nother"'],
    [{ "old#anchor": "renamed" }, '"old#anchor"'],
    [{ "old?x=1": "renamed" }, '"old?x=1"'],
    [{ "a\\old": "renamed" }, '"a\\\\old"'],
    [{ "a/../old": "renamed" }, '"a/../old"'],
    [{ "a/./old": "renamed" }, '"a/./old"'],
    [{ "old.mdx": "renamed" }, '"old.mdx"'],
    [{ old: "renamed.md" }, '"renamed.md"'],
    [{ "x/index": "renamed" }, '"x/index"'],
    [{ old: "index" }, '"index"'],
    [{ old: null }, "null"],
    [{ old: 3 }, "3"],
  ])("rejects %p as a slug", (renames, shown) => {
    expect(() => buildRedirects({ latest, next, renames })).toThrow(/slug/);
    expect(() => buildRedirects({ latest, next, renames })).toThrow(shown);
  });

  test("names the problem with the slug", () => {
    const reject = (renames: Record<string, unknown>) => () => buildRedirects({ latest, next, renames });
    expect(reject({ "next/foo": "renamed" })).toThrow(/version folder "next"/);
    expect(reject({ "0.24.0/foo": "renamed" })).toThrow(/version folder "0.24.0"/);
    expect(reject({ "old page": "renamed" })).toThrow(/segment "old page"/);
    expect(reject({ "a/../old": "renamed" })).toThrow(/"\.\." segment/);
    expect(reject({ "old.mdx": "renamed" })).toThrow(/file extension/);
    expect(reject({ "x/index": "renamed" })).toThrow(/ends in "index"/);
    expect(reject({ old: null })).toThrow(/not a slug string/);
  });

  test("rejects a renames.json that is not an object", () => {
    for (const renames of [null, [], "old"]) {
      expect(() => buildRedirects({ latest, next, renames })).toThrow(/must be an object/);
    }
  });

  test("accepts slugs with dots, underscores and capitals inside a segment", () => {
    const rules = buildRedirects({
      latest: new Set(["", "v1.2_notes"]),
      next: new Set(["", "v1.2_notes"]),
      renames: { "Old_Page.v1": "v1.2_notes" },
    });
    expect(rules).toContainEqual({ from: "/docs/Old_Page.v1/", to: "/docs/v1.2_notes/", status: 301 });
  });

  test("accepts the docs index as a rename target", () => {
    const rules = buildRedirects({ latest: new Set([""]), next: new Set([""]), renames: { gone: "" } });
    expect(rules).toContainEqual({ from: "/docs/gone/", to: "/docs/", status: 301 });
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

describe("writeRedirects", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function dirs() {
    const root = mkdtempSync(join(tmpdir(), "docs-site-"));
    roots.push(root);
    const outDir = join(root, "out");
    const publicDir = join(root, "public");
    mkdirSync(outDir);
    mkdirSync(publicDir);
    return { outDir, publicDir };
  }

  test("writes out/_redirects", () => {
    const { outDir, publicDir } = dirs();
    writeRedirects(outDir, publicDir, [{ from: "/a/", to: "/b/", status: 301 }]);
    expect(readFileSync(join(outDir, "_redirects"), "utf8")).toBe("/a/ /b/ 301\n");
  });

  test("overwrites the out/_redirects an earlier postbuild run wrote", () => {
    const { outDir, publicDir } = dirs();
    writeRedirects(outDir, publicDir, [{ from: "/a/", to: "/b/", status: 301 }]);
    writeRedirects(outDir, publicDir, [{ from: "/c/", to: "/d/", status: 302 }]);
    expect(readFileSync(join(outDir, "_redirects"), "utf8")).toBe("/c/ /d/ 302\n");
  });

  test("refuses to run while public/_redirects exists", () => {
    const { outDir, publicDir } = dirs();
    writeFileSync(join(publicDir, "_redirects"), "/hand /written 301\n");
    writeFileSync(join(outDir, "_redirects"), "/hand /written 301\n");
    expect(() => writeRedirects(outDir, publicDir, [{ from: "/a/", to: "/b/", status: 301 }])).toThrow(
      /public\/_redirects exists/,
    );
    expect(readFileSync(join(outDir, "_redirects"), "utf8")).toBe("/hand /written 301\n");
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
