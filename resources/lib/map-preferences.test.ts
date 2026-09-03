import { afterEach, describe, expect, it, vi } from "vitest"
import {
  loadAttributionPreference,
  loadLayerPreference,
  loadLivePreference,
  saveAttributionPreference,
  saveLayerPreference,
  saveLivePreference,
} from "@/lib/map-preferences"

function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  })
  return data
}

afterEach(() => vi.unstubAllGlobals())

describe("map preferences", () => {
  it("defaults to markers and live off", () => {
    stubStorage()
    expect(loadLayerPreference()).toBe("markers")
    expect(loadLivePreference()).toBe(false)
  })
  it("round-trips explicit choices", () => {
    const data = stubStorage()
    saveLayerPreference("heatmap")
    saveLivePreference(true)
    expect(data.get("geometrikks-map-layer")).toBe("heatmap")
    expect(loadLayerPreference()).toBe("heatmap")
    expect(loadLivePreference()).toBe(true)
  })
  it("defaults the attribution to expanded and round-trips a collapse", () => {
    const data = stubStorage()
    expect(loadAttributionPreference()).toBe(true)
    saveAttributionPreference(false)
    expect(data.get("geometrikks-map-attribution")).toBe("false")
    expect(loadAttributionPreference()).toBe(false)
    saveAttributionPreference(true)
    expect(loadAttributionPreference()).toBe(true)
  })
  it("survives a missing localStorage", () => {
    // no stub at all: loaders must return defaults, savers must not throw
    expect(loadLayerPreference()).toBe("markers")
    expect(() => saveLivePreference(true)).not.toThrow()
    expect(loadAttributionPreference()).toBe(true)
    expect(() => saveAttributionPreference(false)).not.toThrow()
  })
})
