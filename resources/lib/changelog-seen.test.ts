import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  CHANGELOG_SEEN_STORAGE_KEY,
  currentBuildKey,
  hasUnseenChanges,
  loadSeenBuild,
  saveSeenBuild,
  subscribeSeenBuild,
} from "./changelog-seen"

const store = new Map<string, string>()
let blocked = false

vi.stubGlobal("localStorage", {
  getItem: (key: string) => {
    if (blocked) throw new Error("storage blocked")
    return store.get(key) ?? null
  },
  setItem: (key: string, value: string) => {
    if (blocked) throw new Error("storage blocked")
    store.set(key, value)
  },
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
})

describe("currentBuildKey", () => {
  it("is the changelog digest, which changes with every build that has something new to read", () => {
    expect(currentBuildKey({ version: "0.12.0", changelogDigest: "abc123def456" })).toBe("abc123def456")
  })

  it("falls back to the package version when the install has no changelog", () => {
    expect(currentBuildKey({ version: "0.12.0", changelogDigest: null })).toBe("0.12.0")
  })
})

describe("seen build storage", () => {
  beforeEach(() => store.clear())
  afterEach(() => {
    blocked = false
  })

  it("is empty before anything was marked seen", () => {
    expect(loadSeenBuild()).toBeNull()
  })

  it("round-trips the last seen build", () => {
    saveSeenBuild("0.12.0")
    expect(store.get(CHANGELOG_SEEN_STORAGE_KEY)).toBe("0.12.0")
    expect(loadSeenBuild()).toBe("0.12.0")
  })

  it("survives blocked storage", () => {
    blocked = true
    expect(() => saveSeenBuild("0.12.0")).not.toThrow()
    expect(loadSeenBuild()).toBeNull()
  })

  it("notifies subscribers when the seen build changes", () => {
    const listener = vi.fn()
    const unsubscribe = subscribeSeenBuild(listener)
    saveSeenBuild("0.12.0")
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    saveSeenBuild("0.13.0")
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe("hasUnseenChanges", () => {
  it("is quiet on a first visit, when nothing has been marked seen yet", () => {
    expect(hasUnseenChanges(null, "0.12.0")).toBe(false)
  })

  it("is quiet while the build is unknown", () => {
    expect(hasUnseenChanges("0.11.0", null)).toBe(false)
  })

  it("is quiet when the running build is the one last seen", () => {
    expect(hasUnseenChanges("0.12.0", "0.12.0")).toBe(false)
  })

  it("flags a build the user has not looked at", () => {
    expect(hasUnseenChanges("0.11.0", "0.12.0")).toBe(true)
  })
})
