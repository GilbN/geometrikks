import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveChartGranularity } from "./api"

afterEach(() => vi.useRealTimers())

describe("resolveChartGranularity", () => {
  it("uses daily buckets from 7 days up", () => {
    expect(resolveChartGranularity("auto", "7d")).toBe("daily")
    expect(resolveChartGranularity("auto", "14d")).toBe("daily")
    expect(resolveChartGranularity("auto", "custom", { from: "2026-08-14T00:00:00Z", to: "2026-08-21T00:00:00Z" })).toBe("daily")
  })

  it("treats Last week as 7 days although it ends a millisecond short", () => {
    // Monday 00:00 to Sunday 23:59:59.999 is 6.99999999 days.
    expect(resolveChartGranularity("auto", "last_week")).toBe("daily")
  })

  it("treats Last week as 7 days when it contains the spring daylight-saving change", () => {
    // Europe/Oslo moves clocks forward on 2026-03-29, so Mon 23 Mar 00:00 to
    // Sun 29 Mar 23:59:59.999 local time is 167 hours minus a millisecond.
    const tz = process.env.TZ
    process.env.TZ = "Europe/Oslo"
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-01T12:00:00+02:00"))
    try {
      expect(resolveChartGranularity("auto", "last_week")).toBe("daily")
    } finally {
      vi.useRealTimers()
      process.env.TZ = tz
    }
  })

  it("treats a week that loses an hour to daylight saving as 7 days", () => {
    expect(resolveChartGranularity("auto", "custom", { from: "2026-03-23T00:00:00Z", to: "2026-03-29T23:00:00Z" })).toBe("daily")
  })

  it("keeps hourly buckets below 7 days", () => {
    expect(resolveChartGranularity("auto", "24h")).toBe("hourly")
    expect(resolveChartGranularity("auto", "custom", { from: "2026-08-14T00:00:00Z", to: "2026-08-20T00:00:00Z" })).toBe("hourly")
  })

  it("honors an explicit choice", () => {
    expect(resolveChartGranularity("hourly", "7d")).toBe("hourly")
    expect(resolveChartGranularity("daily", "24h")).toBe("daily")
  })
})
