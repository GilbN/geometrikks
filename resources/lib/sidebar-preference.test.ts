import { afterEach, describe, expect, it, vi } from "vitest"
import { loadSidebarOpenPreference, saveSidebarOpenPreference } from "@/lib/sidebar-preference"

function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  })
  return data
}

afterEach(() => vi.unstubAllGlobals())

describe("sidebar preference", () => {
  it("defaults to open", () => {
    stubStorage()
    expect(loadSidebarOpenPreference()).toBe(true)
  })
  it("round-trips a collapse and an expand", () => {
    const data = stubStorage()
    saveSidebarOpenPreference(false)
    expect(data.get("geometrikks-sidebar-open")).toBe("false")
    expect(loadSidebarOpenPreference()).toBe(false)
    saveSidebarOpenPreference(true)
    expect(loadSidebarOpenPreference()).toBe(true)
  })
  it("survives a missing localStorage", () => {
    expect(loadSidebarOpenPreference()).toBe(true)
    expect(() => saveSidebarOpenPreference(false)).not.toThrow()
  })
})
