import { afterEach, describe, expect, it, vi } from "vitest"
import {
  loadOverviewChartsPreference,
  saveOverviewChartsPreference,
  setOverviewCharts,
} from "@/lib/overview-preferences"

function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  })
  return data
}

afterEach(() => vi.unstubAllGlobals())

describe("overview charts preference", () => {
  it("is on until switched off", () => {
    const data = stubStorage()
    expect(loadOverviewChartsPreference()).toBe(true)
    saveOverviewChartsPreference(false)
    expect(data.get("geometrikks-overview-charts")).toBe("false")
    expect(loadOverviewChartsPreference()).toBe(false)
    saveOverviewChartsPreference(true)
    expect(loadOverviewChartsPreference()).toBe(true)
  })

  it("stays on when storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
    })
    expect(loadOverviewChartsPreference()).toBe(true)
    expect(() => saveOverviewChartsPreference(false)).not.toThrow()
  })

  it("saves a choice made through the shared setter", () => {
    const data = stubStorage()
    setOverviewCharts(false)
    expect(data.get("geometrikks-overview-charts")).toBe("false")
    setOverviewCharts(true)
    expect(data.get("geometrikks-overview-charts")).toBe("true")
  })
})
