import { describe, expect, it } from "vite-plus/test"
import { keptHourDays } from "./use-traffic-buckets"

const settings = { hourlyRetentionDays: 60, rawRetentionDays: 180 }

describe("keptHourDays", () => {
  it("uses the hourly retention for an unfiltered series", () => {
    expect(keptHourDays(false, false, settings)).toBe(60)
  })

  it("uses the raw retention when filters or the muted flag send the series to raw rows", () => {
    expect(keptHourDays(true, false, settings)).toBe(180)
    expect(keptHourDays(false, true, settings)).toBe(180)
  })

  it("falls back to the server defaults before the settings arrive", () => {
    expect(keptHourDays(false, false, undefined)).toBe(60)
    expect(keptHourDays(true, false, undefined)).toBe(180)
  })
})
