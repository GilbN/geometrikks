import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  RELEASE_SEEN_STORAGE_KEY,
  hasUnseenRelease,
  loadSeenRelease,
  saveSeenRelease,
  subscribeSeenRelease,
} from "./release-seen"

const store = new Map<string, string>()
let blocked = false
let writesBlocked = false

vi.stubGlobal("localStorage", {
  getItem: (key: string) => {
    if (blocked) throw new Error("storage blocked")
    return store.get(key) ?? null
  },
  setItem: (key: string, value: string) => {
    if (blocked || writesBlocked) throw new Error("storage blocked")
    store.set(key, value)
  },
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
})

describe("hasUnseenRelease", () => {
  it("shows the dot when nothing was ever marked seen", () => {
    expect(hasUnseenRelease(null, "0.23.0")).toBe(true)
  })

  it("is quiet once the release was seen", () => {
    expect(hasUnseenRelease("0.23.0", "0.23.0")).toBe(false)
  })

  it("shows the dot again for a newer release than the one seen", () => {
    expect(hasUnseenRelease("0.22.1", "0.23.0")).toBe(true)
  })

  it("is quiet when there is no newer release", () => {
    expect(hasUnseenRelease("0.23.0", null)).toBe(false)
    expect(hasUnseenRelease(null, null)).toBe(false)
  })
})

describe("seen release storage", () => {
  beforeEach(() => store.clear())
  afterEach(() => {
    blocked = false
    writesBlocked = false
  })

  it("round-trips the last seen release", () => {
    saveSeenRelease("0.23.0")
    expect(store.get(RELEASE_SEEN_STORAGE_KEY)).toBe("0.23.0")
    expect(loadSeenRelease()).toBe("0.23.0")
  })

  it("notifies subscribers when a release is marked seen", () => {
    const listener = vi.fn()
    const unsubscribe = subscribeSeenRelease(listener)
    saveSeenRelease("0.23.0")
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    saveSeenRelease("0.24.0")
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("keeps the release seen for the life of the page when storage is blocked", () => {
    blocked = true
    expect(() => saveSeenRelease("0.23.0")).not.toThrow()
    expect(hasUnseenRelease(loadSeenRelease(), "0.23.0")).toBe(false)
  })

  it("prefers the in-memory release when a write fails but reads still work", async () => {
    vi.resetModules()
    const fresh = await import("./release-seen")
    fresh.saveSeenRelease("0.22.1")
    writesBlocked = true
    fresh.saveSeenRelease("0.23.0")
    expect(store.get(RELEASE_SEEN_STORAGE_KEY)).toBe("0.22.1")
    expect(fresh.hasUnseenRelease(fresh.loadSeenRelease(), "0.23.0")).toBe(false)
  })
})
