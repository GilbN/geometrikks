import { describe, expect, it } from "vite-plus/test"
import { liveSteps, zoomFits, type ZoomStep } from "./chart-zoom"

const week: ZoomStep = {
  from: { range: "7d", customRange: null },
  to: { from: "2026-11-23T00:00:00.000Z", to: "2026-11-23T10:00:00.000Z" },
}
const hours: ZoomStep = {
  from: { range: "custom", customRange: week.to },
  to: { from: "2026-11-23T02:00:00.000Z", to: "2026-11-23T06:00:00.000Z" },
}

describe("zoomFits", () => {
  const HOUR = 3_600_000
  const kept = Date.parse("2026-10-01T00:00:00Z")
  const old = Date.parse("2026-08-01T00:00:00Z")

  it("refuses a zoom with no kept hours in it", () => {
    expect(zoomFits(old, old + 10 * HOUR, kept)).toBe(false)
    expect(zoomFits(old, old + 10 * 24 * HOUR, kept)).toBe(false)
    expect(zoomFits(kept - 5 * HOUR, kept + 30 * 60_000, kept)).toBe(false)
  })

  it("allows a zoom that reaches at least an hour into the kept hours", () => {
    expect(zoomFits(kept, kept + 10 * HOUR, kept)).toBe(true)
    expect(zoomFits(kept - 24 * HOUR, kept + 4 * 24 * HOUR, kept)).toBe(true)
  })
})

describe("liveSteps", () => {
  it("keeps the stack while the page shows the last zoom's range", () => {
    expect(liveSteps([week, hours], "custom", hours.to)).toEqual([week, hours])
  })

  it("forgets the stack after any other range change", () => {
    expect(liveSteps([week, hours], "custom", week.to)).toEqual([])
    expect(liveSteps([week], "24h", week.to)).toEqual([])
    expect(liveSteps([], "custom", week.to)).toEqual([])
  })
})
