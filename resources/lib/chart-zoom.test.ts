import { describe, expect, it } from "vite-plus/test"
import { liveSteps, zoomFits, type ZoomSource, type ZoomStep } from "./chart-zoom"

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
  const DAY = 24 * HOUR
  const kept = Date.parse("2026-10-01T00:00:00Z")
  const old = Date.parse("2026-05-01T00:00:00Z")
  const auto: ZoomSource = { readsRaw: false, granularity: "auto", utc: false }

  it("refuses a zoom with no kept hours in it", () => {
    expect(zoomFits(old, old + 10 * HOUR, kept, auto)).toBe(false)
    expect(zoomFits(old, old + 10 * DAY, kept, auto)).toBe(false)
    expect(zoomFits(kept - 5 * HOUR, kept + 30 * 60_000, kept, auto)).toBe(false)
  })

  it("allows a zoom that reaches at least an hour into the kept hours", () => {
    expect(zoomFits(kept, kept + 10 * HOUR, kept, auto)).toBe(true)
    expect(zoomFits(kept - DAY, kept + 4 * DAY, kept, auto)).toBe(true)
  })

  it("allows old zooms the daily rollup answers, unless filters send them to raw rows", () => {
    expect(zoomFits(old, old + 40 * DAY, kept, auto)).toBe(true)
    expect(zoomFits(old, old + 10 * DAY, kept, { ...auto, utc: true })).toBe(true)
    expect(zoomFits(old, old + 40 * DAY, kept, { ...auto, readsRaw: true })).toBe(false)
    expect(zoomFits(old, old + 40 * DAY, kept, { ...auto, granularity: "hourly" })).toBe(false)
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
