import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import {
  loadInspectorDockedPreference,
  saveInspectorDockedPreference,
} from "@/lib/inspector-dock-preference"

function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  })
  return data
}

afterEach(() => vi.unstubAllGlobals())

describe("inspector dock preference", () => {
  it("defaults to docked", () => {
    stubStorage()
    expect(loadInspectorDockedPreference()).toBe(true)
  })
  it("round-trips an undock and a dock", () => {
    const data = stubStorage()
    saveInspectorDockedPreference(false)
    expect(data.get("geometrikks-inspector-docked")).toBe("false")
    expect(loadInspectorDockedPreference()).toBe(false)
    saveInspectorDockedPreference(true)
    expect(loadInspectorDockedPreference()).toBe(true)
  })
  it("survives blocked storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
    })
    expect(loadInspectorDockedPreference()).toBe(true)
    expect(() => saveInspectorDockedPreference(false)).not.toThrow()
  })
})
