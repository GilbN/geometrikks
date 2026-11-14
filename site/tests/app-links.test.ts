import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkAppDocsUrls, findAppDocsUrls } from "../scripts/lib/app-links";
import type { RedirectRule } from "../scripts/lib/redirects";

const roots: string[] = [];

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "docs-app-links-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const configurationUrl = "https://geometrikks.dev/docs/reference/configuration#loki";

function appRoots(): string[] {
  return [
    tree({ "proxy.py": `DOCS = "${configurationUrl}"\n` }),
    tree({
      "a.tsx": "const href = `https://geometrikks.dev/docs/next/x/`;\n",
      "b.ts": `const site = "https://geometrikks.dev";\n`,
    }),
  ];
}

describe("findAppDocsUrls", () => {
  test("finds docs URLs and ignores the bare site URL", () => {
    const found = findAppDocsUrls(appRoots());
    expect(found.map((entry) => entry.url).sort()).toEqual([
      "https://geometrikks.dev/docs/next/x/",
      configurationUrl,
    ]);
    expect(found.find((entry) => entry.url === configurationUrl)?.file).toEndWith("proxy.py");
  });

  test("scans only source and docs extensions and skips node_modules", () => {
    const root = tree({
      "keep.json": `{"url": "https://geometrikks.dev/docs/json/"}`,
      "notes.txt": "https://geometrikks.dev/docs/txt/",
      "style.css": "/* https://geometrikks.dev/docs/css/ */",
      "node_modules/pkg/index.ts": `"https://geometrikks.dev/docs/dep/"`,
      "deep/node_modules/x.md": "https://geometrikks.dev/docs/dep2/",
    });
    expect(findAppDocsUrls([root]).map((entry) => entry.url)).toEqual(["https://geometrikks.dev/docs/json/"]);
  });

  test("scans a file root whatever its name or extension", () => {
    const root = tree({
      Dockerfile: "# https://geometrikks.dev/docs/x/\n",
      ".env.example": "# https://geometrikks.dev/docs/x/\n",
    });
    const found = findAppDocsUrls([join(root, "Dockerfile"), join(root, ".env.example")]);
    expect(found.map((entry) => entry.file)).toEqual([join(root, "Dockerfile"), join(root, ".env.example")]);
    expect(found.map((entry) => entry.url)).toEqual(["https://geometrikks.dev/docs/x/", "https://geometrikks.dev/docs/x/"]);
  });

  test("stops at link syntax and drops sentence punctuation", () => {
    const root = tree({
      "README.md": [
        "See https://geometrikks.dev/docs/a/.",
        "[x](https://geometrikks.dev/docs/b/)",
        '<a href="https://geometrikks.dev/docs/c/">c</a>',
      ].join("\n"),
    });
    expect(findAppDocsUrls([root]).map((entry) => entry.url)).toEqual([
      "https://geometrikks.dev/docs/a/",
      "https://geometrikks.dev/docs/b/",
      "https://geometrikks.dev/docs/c/",
    ]);
  });
});

describe("checkAppDocsUrls", () => {
  const found = () => findAppDocsUrls(appRoots());

  test("rejects a next-prefixed URL and accepts a page that exists", () => {
    const outDir = tree({ "docs/reference/configuration/index.html": "" });
    const problems = checkAppDocsUrls(found(), outDir, []);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("https://geometrikks.dev/docs/next/x/");
    expect(problems[0]).toContain("(version-prefixed)");
    expect(problems[0]).toContain("a.tsx: ");
  });

  test("accepts a URL a redirect rule covers", () => {
    const outDir = tree({ "docs/next/reference/configuration/index.html": "" });
    const rules: RedirectRule[] = [
      { from: "/docs/reference/configuration/", to: "/docs/next/reference/configuration/", status: 302 },
      { from: "/docs/reference/configuration", to: "/docs/next/reference/configuration/", status: 302 },
    ];
    const problems = checkAppDocsUrls(found(), outDir, rules);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("/docs/next/x/");
  });

  test("reports a URL that resolves to nothing", () => {
    const problems = checkAppDocsUrls(found(), tree({ "index.html": "" }), []);
    expect(problems).toHaveLength(2);
    expect(problems.some((problem) => problem.includes(configurationUrl) && !problem.includes("version-prefixed"))).toBe(
      true,
    );
  });

  test("rejects a release-prefixed URL", () => {
    const outDir = tree({ "docs/0.24.0/x/index.html": "" });
    const problems = checkAppDocsUrls([{ file: "a.py", url: "https://geometrikks.dev/docs/0.24.0/x/" }], outDir, []);
    expect(problems).toEqual(["a.py: https://geometrikks.dev/docs/0.24.0/x/ (version-prefixed)"]);
  });
});
