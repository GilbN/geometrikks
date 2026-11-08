import { afterEach, describe, expect, it, vi } from "vitest"
import {
  loadCardChartsPreference,
  saveCardChartsPreference,
  setCardCharts,
} from "@/lib/card-charts"

function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  })
  return data
}

afterEach(() => vi.unstubAllGlobals())

describe("card charts preference", () => {
  it("is on until switched off", () => {
    const data = stubStorage()
    expect(loadCardChartsPreference("overview")).toBe(true)
    saveCardChartsPreference("overview", false)
    expect(data.get("geometrikks-overview-charts")).toBe("false")
    expect(loadCardChartsPreference("overview")).toBe(false)
    saveCardChartsPreference("overview", true)
    expect(loadCardChartsPreference("overview")).toBe(true)
  })

  it("keeps each page's choice apart", () => {
    const data = stubStorage({ "geometrikks-overview-charts": "false" })
    expect(loadCardChartsPreference("overview")).toBe(false)
    expect(loadCardChartsPreference("geo-logs")).toBe(true)
    saveCardChartsPreference("geo-logs", false)
    expect(data.get("geometrikks-geo-logs-charts")).toBe("false")
    expect(data.get("geometrikks-overview-charts")).toBe("false")
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
    expect(loadCardChartsPreference("geo-logs")).toBe(true)
    expect(() => saveCardChartsPreference("geo-logs", false)).not.toThrow()
  })

  it("saves a choice made through the shared setter", () => {
    const data = stubStorage()
    setCardCharts("geo-logs", false)
    expect(data.get("geometrikks-geo-logs-charts")).toBe("false")
    setCardCharts("geo-logs", true)
    expect(data.get("geometrikks-geo-logs-charts")).toBe("true")
    expect(data.has("geometrikks-overview-charts")).toBe(false)
  })
})
