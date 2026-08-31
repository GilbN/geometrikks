import { createPropertyExpression, latest, type StylePropertySpecification } from "@maplibre/maplibre-gl-style-spec"
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
  // MapLibre validates fill-color through this same parser and silently
  // declines to add a layer whose paint fails, so parsing the expression here
  // is the guard against colors it cannot read (oklch(), the serialization a
  // CSS custom property in that space resolves to).
  const FILL_COLOR = (latest as unknown as Record<string, Record<string, StylePropertySpecification>>)
    .paint_fill["fill-color"]
  const RAMP = ["rgb(10, 10, 10)", "rgb(20, 20, 20)", "rgb(30, 30, 30)", "rgb(40, 40, 40)", "rgb(50, 50, 50)"]
  const BREAKS = [1, 10, 100, 1000, 10000]
  const NO_DATA = "rgb(1, 2, 3)"
  const FEATURE = { type: "Polygon" as const, properties: {} }

  function compile(ramp: string[], noData: string) {
    return createPropertyExpression(buildFillColor(ramp, BREAKS, noData), "fill-color", FILL_COLOR)
  }

  it("compiles as a fill-color property expression", () => {
    const compiled = compile(RAMP, NO_DATA)
    expect(compiled.result).toBe("success")
  })

  it("evaluates to the no-data color without feature state, and to the ramp with it", () => {
    const compiled = compile(RAMP, NO_DATA)
    if (compiled.result !== "success") throw new Error("expression did not compile")
    expect(compiled.value.evaluate({ zoom: 0 }, FEATURE, {}).toString()).toBe("rgba(1,2,3,1)")
    // 100 requests is log10 2, landing exactly on the third break's color.
    expect(compiled.value.evaluate({ zoom: 0 }, FEATURE, { value: 100 }).toString()).toBe("rgba(30,30,30,1)")
  })

  it("rejects colors MapLibre cannot parse", () => {
    const compiled = compile(RAMP, "oklch(0.93 0.0325 195)")
    expect(compiled.result).toBe("error")
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
