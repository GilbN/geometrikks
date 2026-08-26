import { describe, expect, it } from "vitest"
import { formatDurationOrNa, timingCoverage } from "./timing"

describe("formatDurationOrNa", () => {
  it("renders n/a for a missing measurement", () => {
    expect(formatDurationOrNa(null)).toBe("n/a")
    expect(formatDurationOrNa(undefined)).toBe("n/a")
  })

  it("takes seconds and formats like formatDuration in milliseconds", () => {
    expect(formatDurationOrNa(0.0004)).toBe("400μs")
    expect(formatDurationOrNa(0.04)).toBe("40ms")
    expect(formatDurationOrNa(5.67)).toBe("5.67s")
    expect(formatDurationOrNa(0)).toBe("0μs")
  })
})

describe("timingCoverage", () => {
  it("is none when nothing was measured, including an empty range", () => {
    expect(timingCoverage(0, 10)).toEqual({ state: "none", percent: 0 })
    expect(timingCoverage(0, 0)).toEqual({ state: "none", percent: 0 })
  })

  it("is partial with an integer percent", () => {
    expect(timingCoverage(63, 100)).toEqual({ state: "partial", percent: 63 })
    expect(timingCoverage(1, 3)).toEqual({ state: "partial", percent: 33 })
  })

  it("is full when every request was measured", () => {
    expect(timingCoverage(10, 10)).toEqual({ state: "full", percent: 100 })
  })
})
