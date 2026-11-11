import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { releaseDocs } from "../scripts/docs-release";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function published(...versions: string[]) {
  return async (version: string) => versions.includes(version);
}

function makeContent(releases: string[] = ["0.24.0"]) {
  const root = mkdtempSync(join(tmpdir(), "docs-release-"));
  roots.push(root);
  const dir = join(root, "content");
  write(
    join(dir, "docs/next/meta.json"),
    JSON.stringify({ title: "Next", description: "Unreleased, on develop", root: "version", pages: ["index", "guides"] }),
  );
  write(join(dir, "docs/next/index.mdx"), "---\ntitle: Home\n---\n\nSee [quickstart](./quickstart.mdx).\n");
  write(join(dir, "docs/next/guides/meta.json"), JSON.stringify({ title: "Guides" }));
  write(join(dir, "docs/next/guides/nested.mdx"), "---\ntitle: Nested\n---\n\nNEXT-NESTED\n");
  for (const release of releases) {
    write(join(dir, `docs/${release}/meta.json`), JSON.stringify({ title: release, root: "version" }));
    write(join(dir, `docs/${release}/index.mdx`), `---\ntitle: Home\n---\n\nRELEASE-${release}\n`);
    write(join(dir, `openapi/${release}.json`), `{"release":"${release}"}`);
  }
  const schemaPath = join(root, "openapi.json");
  writeFileSync(schemaPath, '{"openapi":"3.1.0"}');
  return { root, dir, schemaPath };
}

describe("releaseDocs", () => {
  test("snapshots next into a release folder with its own schema", async () => {
    const { dir, schemaPath } = makeContent();
    const result = await releaseDocs({
      version: "0.25.0",
      contentDir: dir,
      openapiSource: schemaPath,
      isPublished: published("0.24.0"),
    });

    expect(result).toEqual({ folder: join(dir, "docs/0.25.0"), refreshed: false, dropped: [] });
    expect(readJson(`${dir}/docs/0.25.0/meta.json`)).toEqual({
      title: "0.25.0",
      root: "version",
      pages: ["index", "guides"],
    });
    expect(readFileSync(`${dir}/docs/0.25.0/guides/nested.mdx`, "utf8")).toContain("NEXT-NESTED");
    expect(readJson(`${dir}/docs/0.25.0/guides/meta.json`)).toEqual({ title: "Guides" });
    expect(existsSync(`${dir}/openapi/0.25.0.json`)).toBe(true);
    expect(readJson(`${dir}/openapi/0.25.0.json`)).toEqual({ openapi: "3.1.0" });
    expect(readJson(`${dir}/docs/next/meta.json`)).toMatchObject({ title: "Next" });
  });

  test("a meta.json without pages gains none", async () => {
    const { dir, schemaPath } = makeContent();
    write(join(dir, "docs/next/meta.json"), JSON.stringify({ title: "Next", root: "version" }));
    await releaseDocs({ version: "0.25.0", contentDir: dir, openapiSource: schemaPath, isPublished: published("0.24.0") });
    expect(readJson(`${dir}/docs/0.25.0/meta.json`)).toEqual({ title: "0.25.0", root: "version" });
  });

  test("running again for the same version refreshes the folder", async () => {
    const { dir, schemaPath } = makeContent();
    const base = { contentDir: dir, openapiSource: schemaPath, isPublished: published("0.24.0") };
    await releaseDocs({ version: "0.25.0", ...base });
    rmSync(join(dir, "docs/next/guides"), { recursive: true });
    write(join(dir, "docs/next/index.mdx"), "---\ntitle: Home\n---\n\nREFRESHED\n");
    writeFileSync(schemaPath, '{"openapi":"3.1.0","refreshed":true}');

    const result = await releaseDocs({ version: "0.25.0", ...base });

    expect(result.refreshed).toBe(true);
    expect(readFileSync(`${dir}/docs/0.25.0/index.mdx`, "utf8")).toContain("REFRESHED");
    expect(existsSync(`${dir}/docs/0.25.0/guides`)).toBe(false);
    expect(readJson(`${dir}/openapi/0.25.0.json`)).toEqual({ openapi: "3.1.0", refreshed: true });
  });

  test("a v prefix is rejected with a hint", async () => {
    const { dir, schemaPath } = makeContent();
    const base = { contentDir: dir, openapiSource: schemaPath, isPublished: published() };
    await expect(releaseDocs({ version: "v0.25.0", ...base })).rejects.toThrow(
      "image tags have no v prefix: use 0.25.0",
    );
    expect(existsSync(`${dir}/docs/v0.25.0`)).toBe(false);
  });

  test("a version that is not bare semver is rejected", async () => {
    const { dir, schemaPath } = makeContent();
    const base = { contentDir: dir, openapiSource: schemaPath, isPublished: published() };
    await expect(releaseDocs({ version: "0.25", ...base })).rejects.toThrow(/0\.25/);
    await expect(releaseDocs({ version: "next", ...base })).rejects.toThrow(/X\.Y\.Z/);
  });

  test("a published version is frozen", async () => {
    const { dir, schemaPath } = makeContent();
    write(join(dir, "docs/next/index.mdx"), "CHANGED\n");
    await expect(
      releaseDocs({ version: "0.24.0", contentDir: dir, openapiSource: schemaPath, isPublished: published("0.24.0") }),
    ).rejects.toThrow("0.24.0 is published; its folder is frozen");
    expect(readFileSync(`${dir}/docs/0.24.0/index.mdx`, "utf8")).toContain("RELEASE-0.24.0");
  });

  test("another pending folder blocks a new release and is named", async () => {
    const { dir, schemaPath } = makeContent(["0.24.0", "0.25.0"]);
    await expect(
      releaseDocs({ version: "0.26.0", contentDir: dir, openapiSource: schemaPath, isPublished: published("0.24.0") }),
    ).rejects.toThrow(/0\.25\.0/);
    expect(existsSync(`${dir}/docs/0.26.0`)).toBe(false);
  });

  test("a version older than latest is refused", async () => {
    const { dir, schemaPath } = makeContent();
    await expect(
      releaseDocs({ version: "0.23.5", contentDir: dir, openapiSource: schemaPath, isPublished: published("0.24.0") }),
    ).rejects.toThrow(/0\.24\.0/);
    expect(existsSync(`${dir}/docs/0.23.5`)).toBe(false);
  });

  test("superseded folders and their schemas are deleted", async () => {
    const { dir, schemaPath } = makeContent(["0.23.0", "0.24.0"]);
    const result = await releaseDocs({
      version: "0.25.0",
      contentDir: dir,
      openapiSource: schemaPath,
      isPublished: published("0.24.0"),
    });

    expect(result.dropped).toEqual(["0.23.0"]);
    expect(existsSync(`${dir}/docs/0.23.0`)).toBe(false);
    expect(existsSync(`${dir}/openapi/0.23.0.json`)).toBe(false);
    expect(existsSync(`${dir}/docs/0.24.0`)).toBe(true);
    expect(existsSync(`${dir}/openapi/0.24.0.json`)).toBe(true);
  });

  test("the first release with nothing published drops nothing", async () => {
    const { dir, schemaPath } = makeContent([]);
    const result = await releaseDocs({
      version: "0.25.0",
      contentDir: dir,
      openapiSource: schemaPath,
      isPublished: published(),
    });
    expect(result).toEqual({ folder: join(dir, "docs/0.25.0"), refreshed: false, dropped: [] });
    expect(existsSync(`${dir}/openapi/0.25.0.json`)).toBe(true);
  });

  test("an absolute link into next fails and names the file", async () => {
    const { dir, schemaPath } = makeContent();
    write(join(dir, "docs/next/guides/linked.mdx"), "See [quickstart](/docs/next/quickstart/).\n");
    const release = releaseDocs({
      version: "0.25.0",
      contentDir: dir,
      openapiSource: schemaPath,
      isPublished: published("0.24.0"),
    });
    await expect(release).rejects.toThrow(/relative/);
    await expect(release).rejects.toThrow(/guides\/linked\.mdx/);
    expect(existsSync(`${dir}/docs/0.25.0`)).toBe(false);
  });

  test.each([
    "[a](https://geometrikks.dev/docs/next/quickstart/)",
    '<a href="/docs/next/quickstart/">a</a>',
    '<a href = "/docs/next/quickstart/">Guide</a>',
    '<img src\n=\n{"/docs/next/a.png"} />',
    "[a](/docs/next)",
    "[ref]: /docs/next/quickstart/",
    "<a href={`/docs/next/quickstart/`}>a</a>",
    "Use `code` and <a href={`/docs/next/quickstart/`}>a</a> with `more code`.",
    "See ``` [a](/docs/next/quickstart/) `` here.",
    '<a href={"/docs/next/x/"}>a</a>',
    "[r]: /docs/next/x/",
    "Stray ` tick\n```\nx\n```\n[a](/docs/next/q/) and `y`",
    "Press the ` key.\n```bash\necho `date`\n```\n\n[a](/docs/next/q/)",
    "<span title={`}`} /> [a](/docs/next/quickstart/) then `example`",
  ])("the link %p into next fails", async (link) => {
    const { dir, schemaPath } = makeContent();
    write(join(dir, "docs/next/index.mdx"), `${link}\n`);
    await expect(
      releaseDocs({ version: "0.25.0", contentDir: dir, openapiSource: schemaPath, isPublished: published("0.24.0") }),
    ).rejects.toThrow(/relative/);
    expect(existsSync(`${dir}/docs/0.25.0`)).toBe(false);
  });

  test("prose that mentions the next path is not a link", async () => {
    const { dir, schemaPath } = makeContent();
    write(join(dir, "docs/next/index.mdx"), "Unreleased pages live under `/docs/next/`.\n");
    await releaseDocs({ version: "0.25.0", contentDir: dir, openapiSource: schemaPath, isPublished: published("0.24.0") });
    expect(existsSync(`${dir}/docs/0.25.0/index.mdx`)).toBe(true);
  });

  test.each([
    "Never write `[a](/docs/next/quickstart/)`.\n",
    "``[a](/docs/next/quickstart/)``\n",
    "```mdx\n[a](/docs/next/quickstart/)\n<a href=\"/docs/next/quickstart/\">a</a>\n```\n",
    "~~~~\n```\n[a](/docs/next/quickstart/)\n```\n~~~~\n",
    "Write `<a href={`/docs/next/quickstart/`}>` as a relative link.\n",
    "```jsx\n<a href={`/docs/next/quickstart/`}>a</a>\n```\n",
    "```\n[a](/docs/next/x/)\n```\n",
    "Inline `[a](/docs/next/x/)` only.\n",
  ])("a link into next inside a code example passes: %p", async (body) => {
    const { dir, schemaPath } = makeContent();
    write(join(dir, "docs/next/index.mdx"), body);
    await releaseDocs({ version: "0.25.0", contentDir: dir, openapiSource: schemaPath, isPublished: published("0.24.0") });
    expect(existsSync(`${dir}/docs/0.25.0/index.mdx`)).toBe(true);
  });

  test("a link into next after a closed code example fails", async () => {
    const { dir, schemaPath } = makeContent();
    write(join(dir, "docs/next/index.mdx"), "```\nexample\n```\n\n`code` then [a](/docs/next/quickstart/)\n");
    await expect(
      releaseDocs({ version: "0.25.0", contentDir: dir, openapiSource: schemaPath, isPublished: published("0.24.0") }),
    ).rejects.toThrow(/relative/);
  });

  test("a page that fails to parse as MDX fails and names the file", async () => {
    const { dir, schemaPath } = makeContent();
    write(join(dir, "docs/next/guides/broken.mdx"), "An unclosed { brace.\n");
    const release = releaseDocs({
      version: "0.25.0",
      contentDir: dir,
      openapiSource: schemaPath,
      isPublished: published("0.24.0"),
    });
    await expect(release).rejects.toThrow(/guides\/broken\.mdx .*brace.*failed to parse/);
    expect(existsSync(`${dir}/docs/0.25.0`)).toBe(false);
  });

  test("a .md page is read as Markdown, so raw HTML parses and its links are checked", async () => {
    const { dir, schemaPath } = makeContent();
    write(join(dir, "docs/next/guides/plain.md"), "Line<br>\n\n<a href=\"/docs/next/x/\">a</a>\n");
    await expect(
      releaseDocs({ version: "0.25.0", contentDir: dir, openapiSource: schemaPath, isPublished: published("0.24.0") }),
    ).rejects.toThrow(/guides\/plain\.md link to \/docs\/next/);
  });

  test("a stray backtick does not hide a link in a later paragraph", async () => {
    const { dir, schemaPath } = makeContent();
    write(join(dir, "docs/next/index.mdx"), "A stray ` here.\n\n[a](/docs/next/quickstart/) and ` there.\n");
    await expect(
      releaseDocs({ version: "0.25.0", contentDir: dir, openapiSource: schemaPath, isPublished: published("0.24.0") }),
    ).rejects.toThrow(/relative/);
  });

  test.each(["next.mdx", "next/index.mdx", "(guides)/next.mdx", "(guides)/next/index.mdx"])("a top-level page with the slug next fails: %p", async (page) => {
    const { dir, schemaPath } = makeContent();
    write(join(dir, "docs/next", page), "---\ntitle: Next\n---\n");
    const release = releaseDocs({
      version: "0.25.0",
      contentDir: dir,
      openapiSource: schemaPath,
      isPublished: published("0.24.0"),
    });
    await expect(release).rejects.toThrow(/slug next/);
    await expect(release).rejects.toThrow(page);
    expect(existsSync(`${dir}/docs/0.25.0`)).toBe(false);
  });

  test("gitignored generated output in next is not copied", async () => {
    const { root, dir, schemaPath } = makeContent();
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, ".gitignore"), "content/docs/*/reference/api/*/\n");
    write(join(dir, "docs/next/reference/api/index.mdx"), "---\ntitle: API\n---\n");
    write(join(dir, "docs/next/reference/api/health/check.mdx"), "---\ntitle: Health\n---\n");

    await releaseDocs({ version: "0.25.0", contentDir: dir, openapiSource: schemaPath, isPublished: published("0.24.0") });

    expect(existsSync(`${dir}/docs/0.25.0/reference/api/index.mdx`)).toBe(true);
    expect(existsSync(`${dir}/docs/0.25.0/reference/api/health`)).toBe(false);
  });
});
