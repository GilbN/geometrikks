import { describe, expect, it } from "vite-plus/test"
import { liveSteps, type ZoomStep } from "./chart-zoom"

const week: ZoomStep = {
  from: { range: "7d", customRange: null },
  to: { from: "2026-11-23T00:00:00.000Z", to: "2026-11-23T10:00:00.000Z" },
}
const hours: ZoomStep = {
  from: { range: "custom", customRange: week.to },
  to: { from: "2026-11-23T02:00:00.000Z", to: "2026-11-23T06:00:00.000Z" },
}

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
