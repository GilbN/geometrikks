import { describe, expect, it } from "vitest"

import { LOCAL_BUILD_LABEL, displayVersion, isLocalBuild, publicVersion, sameRelease } from "./version"

describe("displayVersion", () => {
  it.each([
    ["0.22.0.dev4", "v0.22.0-dev.4"],
    ["0.22.0", "v0.22.0"],
    ["0.22.0.dev4+g52b67d62c", "v0.22.0-dev.4+g52b67d62c"],
    ["0.22.0+g2d297914e", "v0.22.0+g2d297914e"],
    ["0.0.0+local", LOCAL_BUILD_LABEL],
    ["0.0+g3da2446d9", LOCAL_BUILD_LABEL],
    ["unknown", LOCAL_BUILD_LABEL],
    ["", LOCAL_BUILD_LABEL],
    ["9.9.9-test", "v9.9.9-test"],
  ])("%s -> %s", (version, expected) => expect(displayVersion(version)).toBe(expected))
})

describe("isLocalBuild", () => {
  it.each([
    ["0.0.0+local", true],
    ["0.0+g3da2446d9", true],
    ["unknown", true],
    ["", true],
    ["0.22.0", false],
    ["0.22.0.dev4+g52b67d62c", false],
    ["9.9.9-test", false],
  ])("%s -> %s", (version, expected) => expect(isLocalBuild(version)).toBe(expected))
})

describe("sameRelease", () => {
  it.each([
    ["0.22.0.dev4", "0.22.0.dev4+g52b67d62c", true],
    ["0.22.0.dev3", "0.22.0.dev4", false],
    ["0.22.0", "0.22.0.dev4", false],
    ["0.0.0+local", "0.22.0", true],
    ["unknown", "0.22.0", true],
    ["9.9.9-test", "9.9.9-test", true],
    ["9.9.9-test", "0.22.0", false],
  ])("%s vs %s -> %s", (a, b, expected) => expect(sameRelease(a, b)).toBe(expected))
})

describe("publicVersion", () => {
  it("drops the local suffix", () => {
    expect(publicVersion("0.22.0+g2d297914e")).toBe("0.22.0")
    expect(publicVersion("0.22.0.dev4")).toBe("0.22.0.dev4")
  })
})
