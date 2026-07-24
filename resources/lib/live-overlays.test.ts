import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  LIVE_OVERLAYS_STORAGE_KEY,
  loadLiveOverlays,
  saveLiveOverlays,
} from "./live-overlays"

const store = new Map<string, string>()

vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
})

describe("live overlay preferences", () => {
  beforeEach(() => store.clear())

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
})
