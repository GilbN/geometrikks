import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  LIVE_OVERLAYS_STORAGE_KEY,
  loadLiveOverlays,
  saveLiveOverlays,
} from "./live-overlays"

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

describe("live overlay preferences", () => {
  beforeEach(() => store.clear())
  afterEach(() => {
    blocked = false
  })

  it("defaults every overlay to on", () => {
    expect(loadLiveOverlays()).toEqual({ vitals: true, strips: true, wire: true })
  })

  it("round-trips a saved preference", () => {
    saveLiveOverlays({ vitals: true, strips: false, wire: true })
    expect(loadLiveOverlays()).toEqual({ vitals: true, strips: false, wire: true })
  })

  it("falls back to the defaults on malformed storage", () => {
    store.set(LIVE_OVERLAYS_STORAGE_KEY, "{not json")
    expect(loadLiveOverlays()).toEqual({ vitals: true, strips: true, wire: true })
  })

  it("fills in missing keys from a partial object", () => {
    store.set(LIVE_OVERLAYS_STORAGE_KEY, JSON.stringify({ wire: false }))
    expect(loadLiveOverlays()).toEqual({ vitals: true, strips: true, wire: false })
  })

  it("ignores non-boolean values", () => {
    store.set(LIVE_OVERLAYS_STORAGE_KEY, JSON.stringify({ wire: "nope" }))
    expect(loadLiveOverlays().wire).toBe(true)
  })

  it("falls back to the defaults when storage access is blocked", () => {
    blocked = true
    expect(loadLiveOverlays()).toEqual({ vitals: true, strips: true, wire: true })
  })

  it("does not throw when saving while storage access is blocked", () => {
    blocked = true
    expect(() =>
      saveLiveOverlays({ vitals: true, strips: false, wire: true }),
    ).not.toThrow()
  })
})
