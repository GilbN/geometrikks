import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findDeadLinks } from "../scripts/lib/links";
import type { RedirectRule } from "../scripts/lib/redirects";

const roots: string[] = [];

function outTree(files: Record<string, string>): string {
  const outDir = mkdtempSync(join(tmpdir(), "docs-links-"));
  roots.push(outDir);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(outDir, file)), { recursive: true });
    writeFileSync(join(outDir, file), content);
  }
  return outDir;
}

function page(...hrefs: string[]): string {
  return `<html><body>${hrefs.map((href) => `<a href="${href}">x</a>`).join("")}</body></html>`;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("findDeadLinks", () => {
  test("reports only the link that resolves to nothing", () => {
    const outDir = outTree({
      "index.html": `<html><head><script src="/_next/static/a.js"></script></head><body>
        <a href="/docs/x/">x</a><a href="/docs/y/">y</a><a href="/docs/z/#part">z</a>
        <a href="/docs/with%20space/">space</a><a href="https://github.com/GilbN/geometrikks">gh</a>
      </body></html>`,
      "_next/static/a.js": "",
      "docs/x/index.html": page(),
      "docs/with space/index.html": page(),
    });
    const rules: RedirectRule[] = [{ from: "/docs/y/", to: "/docs/x/", status: 302 }];
    const dead = findDeadLinks(outDir, rules);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toContain("/docs/z/");
    expect(dead[0]).toContain("index.html");
  });

  test("skips external, mailto and fragment-only links", () => {
    const outDir = outTree({
      "index.html": page("https://example.com/a", "//cdn.example.com/b", "mailto:a@example.com", "#top", ""),
    });
    expect(findDeadLinks(outDir, [])).toEqual([]);
  });

  test("strips the query and decodes entities before resolving", () => {
    const outDir = outTree({
      "index.html": page("/docs/x/?a=1&amp;b=2", "/docs/it&#x27;s/", "/docs/x"),
      "docs/x/index.html": page(),
      "docs/it's/index.html": page(),
    });
    expect(findDeadLinks(outDir, [])).toEqual([]);
  });

  test("resolves a slashless path to a file or a folder index", () => {
    const outDir = outTree({
      "index.html": page("/favicon.svg", "/docs/x", "/docs/x/index.html", "/missing.svg"),
      "favicon.svg": "",
      "docs/x/index.html": page(),
    });
    const dead = findDeadLinks(outDir, []);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toContain("/missing.svg");
  });

  test("reports relative and .mdx hrefs in docs pages but not on the landing page", () => {
    const outDir = outTree({
      "index.html": page("./lokii.mdx", "../b/"),
      "docs/next/a/index.html": page("./lokii.mdx", "../b/"),
      "docs/next/b/index.html": page(),
    });
    const dead = findDeadLinks(outDir, []);
    expect(dead).toHaveLength(2);
    expect(dead.every((entry) => entry.startsWith("docs/next/a/index.html"))).toBe(true);
    expect(dead.some((entry) => entry.includes("./lokii.mdx"))).toBe(true);
    expect(dead.some((entry) => entry.includes("../b/"))).toBe(true);
  });

  test("reports a root-relative .mdx href in a docs page", () => {
    const outDir = outTree({
      "docs/index.html": page("/docs/x.mdx"),
      "docs/x.mdx": "",
    });
    expect(findDeadLinks(outDir, [])).toHaveLength(1);
  });

  const chain: RedirectRule[] = [
    { from: "/docs/old/", to: "/docs/new/", status: 301 },
    { from: "/docs/new/", to: "/docs/next/new/", status: 302 },
  ];

  test("follows a rename into the next-only redirect when there is no latest", () => {
    const outDir = outTree({
      "docs/next/index.html": page("/docs/old/"),
      "docs/next/new/index.html": page(),
    });
    expect(findDeadLinks(outDir, chain)).toEqual([]);
  });

  test("reports the chain when its final page is gone", () => {
    const outDir = outTree({ "docs/next/index.html": page("/docs/old/") });
    expect(findDeadLinks(outDir, chain)).toHaveLength(1);
  });

  test("reports a three-rule chain", () => {
    const outDir = outTree({
      "docs/next/index.html": page("/docs/a/"),
      "docs/next/d/index.html": page(),
    });
    const rules: RedirectRule[] = [
      { from: "/docs/a/", to: "/docs/b/", status: 301 },
      { from: "/docs/b/", to: "/docs/c/", status: 301 },
      { from: "/docs/c/", to: "/docs/next/d/", status: 302 },
    ];
    expect(findDeadLinks(outDir, rules)).toHaveLength(1);
  });

  test("checks a fragment on the page the link resolves to", () => {
    const outDir = outTree({
      "docs/next/index.html": page("/docs/x/#present", "/docs/x/#missing", "/docs/y/#present", "/docs/old/#missing"),
      "docs/x/index.html": `<html><body><h2 id="present">Present</h2></body></html>`,
    });
    const rules: RedirectRule[] = [
      { from: "/docs/old/", to: "/docs/y/", status: 301 },
      { from: "/docs/y/", to: "/docs/x/", status: 302 },
    ];
    expect(findDeadLinks(outDir, rules)).toEqual([
      "docs/next/index.html -> /docs/x/#missing",
      "docs/next/index.html -> /docs/old/#missing",
    ]);
  });

  test("decodes the fragment and ignores ids inside scripts", () => {
    const outDir = outTree({
      "docs/next/index.html": page("/docs/x/#f%C3%B8r", "/docs/x#single", "/docs/x/#scripted", "/docs/x/#"),
      "docs/x/index.html": `<html><body><h2 id="før">x</h2><p id='single'>y</p><script>self.a = ' id="scripted"';</script></body></html>`,
    });
    expect(findDeadLinks(outDir, [])).toEqual(["docs/next/index.html -> /docs/x/#scripted"]);
  });

  test("ignores href-like text inside inline scripts", () => {
    const outDir = outTree({
      "docs/index.html": `<html><body><script>self.x = ' href="./nope.mdx" src="/nope.js"';</script></body></html>`,
    });
    expect(findDeadLinks(outDir, [])).toEqual([]);
  });
});
