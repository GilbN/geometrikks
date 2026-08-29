import { describe, expect, it } from "vitest"
import { rangeCompareLabel, rangeSubtitle } from "./time-range-labels"

describe("rangeSubtitle", () => {
  it("prefixes duration presets with Last", () => {
    expect(rangeSubtitle("24h")).toBe("Last 24h")
    expect(rangeSubtitle("7d")).toBe("Last 7d")
  })

  it("uses calendar preset labels as they are", () => {
    expect(rangeSubtitle("today")).toBe("Today")
    expect(rangeSubtitle("yesterday")).toBe("Yesterday")
    expect(rangeSubtitle("this_week")).toBe("This week")
    expect(rangeSubtitle("last_week")).toBe("Last week")
    expect(rangeSubtitle("this_month")).toBe("This month")
    expect(rangeSubtitle("last_month")).toBe("Last month")
  })

  it("names a custom range without a Last prefix", () => {
    expect(rangeSubtitle("custom")).toBe("Custom range")
  })
})

describe("rangeCompareLabel", () => {
  it("compares duration presets against the same span before", () => {
    expect(rangeCompareLabel("24h")).toBe("vs last 24h")
  })

  it("compares calendar and custom ranges against the previous period", () => {
    expect(rangeCompareLabel("last_month")).toBe("vs previous period")
    expect(rangeCompareLabel("today")).toBe("vs previous period")
    expect(rangeCompareLabel("custom")).toBe("vs previous period")
  })
})
