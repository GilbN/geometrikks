import { describe, expect, test } from "bun:test";
import { compareSemver, SEMVER, toUrlSlugs, versionOfUrl, withSlash } from "../lib/versions";

describe("toUrlSlugs", () => {
  test("strips the latest folder", () => {
    expect(toUrlSlugs(["0.1.0", "quickstart"], "0.1.0")).toEqual(["quickstart"]);
    expect(toUrlSlugs(["0.1.0"], "0.1.0")).toEqual([]);
  });

  test("keeps next as a prefix", () => {
    expect(toUrlSlugs(["next", "guides", "nested"], "0.1.0")).toEqual(["next", "guides", "nested"]);
  });

  test("leaves slugs alone when no release is latest", () => {
    expect(toUrlSlugs(["next", "x"], null)).toEqual(["next", "x"]);
  });
});

describe("compareSemver", () => {
  test("compares numerically, not lexically", () => {
    expect(compareSemver("0.10.0", "0.9.1")).toBeGreaterThan(0);
    expect(compareSemver("0.9.1", "0.10.0")).toBeLessThan(0);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  test("throws on anything but bare X.Y.Z", () => {
    expect(() => compareSemver("next", "0.1.0")).toThrow(/next/);
    expect(() => compareSemver("0.1.0", "v0.2.0")).toThrow(/v0.2.0/);
  });

  test("SEMVER accepts bare X.Y.Z only", () => {
    expect(SEMVER.test("0.24.0")).toBe(true);
    expect(SEMVER.test("v0.24.0")).toBe(false);
    expect(SEMVER.test("next")).toBe(false);
  });
});

describe("versionOfUrl", () => {
  test("next prefix", () => {
    expect(versionOfUrl("/docs/next/quickstart/")).toBe("next");
    expect(versionOfUrl("/docs/next")).toBe("next");
  });

  test("everything else is latest", () => {
    expect(versionOfUrl("/docs/quickstart/")).toBe("latest");
    expect(versionOfUrl("/docs/")).toBe("latest");
    expect(versionOfUrl("/docs/nextgen/")).toBe("latest");
  });
});

describe("withSlash", () => {
  test("appends a missing slash", () => {
    expect(withSlash("/docs/next/quickstart")).toBe("/docs/next/quickstart/");
    expect(withSlash("/docs")).toBe("/docs/");
    expect(withSlash("https://geometrikks.dev/docs/next")).toBe("https://geometrikks.dev/docs/next/");
  });

  test("leaves a slashed path alone", () => {
    expect(withSlash("/docs/")).toBe("/docs/");
  });

  test("puts the slash before a fragment or query", () => {
    expect(withSlash("/docs/reference/configuration#loki")).toBe("/docs/reference/configuration/#loki");
    expect(withSlash("/docs/quickstart?x=1")).toBe("/docs/quickstart/?x=1");
  });
});
