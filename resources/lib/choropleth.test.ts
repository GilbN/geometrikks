import { describe, expect, it, vi } from "vitest"
import { applyCountryValues, buildFillColor, computeBreaks } from "./choropleth"

describe("computeBreaks", () => {
  it("snaps the top to the next 1/2/5 step and scales down by decades", () => {
    expect(computeBreaks(30000)).toEqual([1, 50, 500, 5000, 50000])
  })
  it("defaults on empty data", () => {
    expect(computeBreaks(0)).toEqual([1, 10, 100, 1000, 10000])
  })
  it("stays strictly increasing for tiny maxima", () => {
    const breaks = computeBreaks(1)
    expect(breaks).toEqual([1, 2, 5, 10, 20])
    for (let i = 1; i < breaks.length; i++) expect(breaks[i]).toBeGreaterThan(breaks[i - 1])
  })
  it("is strictly increasing for every magnitude", () => {
    for (const max of [3, 42, 700, 8_888, 123_456, 9_999_999]) {
      const breaks = computeBreaks(max)
      expect(breaks[4]).toBeGreaterThanOrEqual(max)
      for (let i = 1; i < 5; i++) expect(breaks[i]).toBeGreaterThan(breaks[i - 1])
    }
  })
})

describe("buildFillColor", () => {
  it("uses the no-data color for missing feature state", () => {
    const expr = buildFillColor(["#a", "#b", "#c", "#d", "#e"], [1, 10, 100, 1000, 10000], "#nd") as unknown[]
    expect(expr[0]).toBe("case")
    expect(JSON.stringify(expr)).toContain("#nd")
  })
})

describe("applyCountryValues", () => {
  it("sets new values and clears departed ids", () => {
    const map = { setFeatureState: vi.fn(), removeFeatureState: vi.fn() }
    applyCountryValues(map, "countries", [{ id: "NO", value: 5 }, { id: "SE", value: 3 }], [{ id: "NO", value: 9 }])
    expect(map.setFeatureState).toHaveBeenCalledWith(
      { source: "countries", id: "NO" }, { value: 9 },
    )
    expect(map.removeFeatureState).toHaveBeenCalledWith({ source: "countries", id: "SE" })
  })
})
