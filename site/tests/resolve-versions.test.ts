import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryError } from "../scripts/lib/registry";
import { resolveVersions } from "../scripts/lib/resolve-versions";

const roots: string[] = [];

function docsDir(folders: string[], files: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "docs-versions-"));
  roots.push(root);
  for (const folder of folders) mkdirSync(join(root, folder));
  for (const file of files) writeFileSync(join(root, file), "");
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function published(...versions: string[]) {
  const asked: string[] = [];
  const lookup = async (version: string) => {
    asked.push(version);
    return versions.includes(version);
  };
  return Object.assign(lookup, { asked });
}

describe("resolveVersions", () => {
  const dir = docsDir(["next", "0.24.0", "0.25.0", "0.23.0"]);

  test("the newest published folder is latest", async () => {
    expect(await resolveVersions(dir, published("0.24.0"))).toEqual({
      latest: "0.24.0",
      pending: ["0.25.0"],
      superseded: ["0.23.0"],
      served: ["0.24.0", "next"],
    });
  });

  test("promotes the pending folder once its image is published", async () => {
    expect((await resolveVersions(dir, published("0.24.0", "0.25.0"))).latest).toBe("0.25.0");
  });

  test("sorts numerically, newest first", async () => {
    const plan = await resolveVersions(docsDir(["next", "0.9.0", "0.10.0", "0.2.0"]), published("0.2.0"));
    expect(plan).toEqual({
      latest: "0.2.0",
      pending: ["0.10.0", "0.9.0"],
      superseded: [],
      served: ["0.2.0", "next"],
    });
  });

  test("stops asking once latest is found", async () => {
    const lookup = published("0.24.0");
    await resolveVersions(dir, lookup);
    expect(lookup.asked).toEqual(["0.25.0", "0.24.0"]);
  });

  test("only next serves next", async () => {
    expect(await resolveVersions(docsDir(["next"]), published())).toEqual({
      latest: null,
      pending: [],
      superseded: [],
      served: ["next"],
    });
  });

  test("no published folder leaves latest null and every folder pending", async () => {
    expect(await resolveVersions(dir, published())).toEqual({
      latest: null,
      pending: ["0.25.0", "0.24.0", "0.23.0"],
      superseded: [],
      served: ["next"],
    });
  });

  test("a registry failure on the newer folder propagates instead of falling back to an older one", async () => {
    const asked: string[] = [];
    const lookup = async (version: string): Promise<boolean> => {
      asked.push(version);
      if (version === "0.25.0") throw new RegistryError("ghcr.io answered 503");
      return true;
    };
    await expect(resolveVersions(docsDir(["0.24.0", "0.25.0", "next"]), lookup)).rejects.toBeInstanceOf(RegistryError);
    expect(asked).toEqual(["0.25.0"]);
  });

  test("ignores folders that are not semver or next, and files", async () => {
    const mixed = docsDir(["next", "0.24.0", "drafts", "v0.25.0", "0.25"], ["0.26.0", "meta.json"]);
    const lookup = published("0.24.0", "v0.25.0", "0.26.0");
    expect(await resolveVersions(mixed, lookup)).toEqual({
      latest: "0.24.0",
      pending: [],
      superseded: [],
      served: ["0.24.0", "next"],
    });
    expect(lookup.asked).toEqual(["0.24.0"]);
  });

  test("throws when next is missing", async () => {
    await expect(resolveVersions(docsDir(["0.24.0"]), published("0.24.0"))).rejects.toThrow(/next/);
  });

  test("throws when next is a file, not a folder", async () => {
    await expect(resolveVersions(docsDir(["0.24.0"], ["next"]), published("0.24.0"))).rejects.toThrow(/next/);
  });
});
