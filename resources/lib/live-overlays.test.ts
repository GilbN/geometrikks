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
    expect(loadLiveOverlays()).toEqual({ rail: true })
  })

  it("round-trips a saved preference", () => {
    saveLiveOverlays({ rail: false })
    expect(loadLiveOverlays()).toEqual({ rail: false })
  })

  it("falls back to the defaults on malformed storage", () => {
    store.set(LIVE_OVERLAYS_STORAGE_KEY, "{not json")
    expect(loadLiveOverlays()).toEqual({ rail: true })
  })

  it("ignores non-boolean values", () => {
    store.set(LIVE_OVERLAYS_STORAGE_KEY, JSON.stringify({ rail: "nope" }))
    expect(loadLiveOverlays().rail).toBe(true)
  })

  it("ignores keys for overlays that no longer exist", () => {
    store.set(LIVE_OVERLAYS_STORAGE_KEY, JSON.stringify({ vitals: false, strips: false }))
    expect(loadLiveOverlays()).toEqual({ rail: true })
  })

  it("falls back to the defaults when storage access is blocked", () => {
    blocked = true
    expect(loadLiveOverlays()).toEqual({ rail: true })
  })

  it("does not throw when saving while storage access is blocked", () => {
    blocked = true
    expect(() => saveLiveOverlays({ rail: false })).not.toThrow()
  })
})
