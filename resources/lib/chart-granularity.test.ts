import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { resolveChartGranularity } from "./api"
import { autoChartGranularity } from "./sparklines"

const HOUR = 3_600_000

afterEach(() => vi.useRealTimers())

describe("autoChartGranularity", () => {
  it("uses hours up to a week and days above", () => {
    expect(autoChartGranularity(0, 24 * HOUR)).toBe("hourly")
    expect(autoChartGranularity(0, 7 * 24 * HOUR)).toBe("hourly")
    // A week that gains an hour to daylight saving.
    expect(autoChartGranularity(0, 7 * 24 * HOUR + HOUR)).toBe("hourly")
    expect(autoChartGranularity(0, 7 * 24 * HOUR + 2 * HOUR)).toBe("daily")
    expect(autoChartGranularity(0, 14 * 24 * HOUR)).toBe("daily")
  })
})

describe("resolveChartGranularity", () => {
  it("uses hourly buckets up to 7 days", () => {
    expect(resolveChartGranularity("auto", "24h")).toBe("hourly")
    expect(resolveChartGranularity("auto", "7d")).toBe("hourly")
    expect(resolveChartGranularity("auto", "last_week")).toBe("hourly")
    expect(
      resolveChartGranularity("auto", "custom", {
        from: "2026-08-14T00:00:00Z",
        to: "2026-08-21T00:00:00Z",
      }),
    ).toBe("hourly")
  })

  it("keeps Last week hourly when it contains the autumn daylight-saving change", () => {
    // Europe/Oslo moves clocks back on 2026-10-25, so Mon 19 Oct 00:00 to
    // Sun 25 Oct 23:59:59.999 local time is 169 hours minus a millisecond.
    const tz = process.env.TZ
    process.env.TZ = "Europe/Oslo"
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-28T12:00:00+01:00"))
    try {
      expect(resolveChartGranularity("auto", "last_week")).toBe("hourly")
    } finally {
      vi.useRealTimers()
      process.env.TZ = tz
    }
  })

  it("uses daily buckets above 7 days", () => {
    expect(resolveChartGranularity("auto", "14d")).toBe("daily")
    expect(resolveChartGranularity("auto", "30d")).toBe("daily")
    expect(
      resolveChartGranularity("auto", "custom", {
        from: "2026-08-14T00:00:00Z",
        to: "2026-08-21T02:00:00Z",
      }),
    ).toBe("daily")
  })

  it("honors an explicit choice", () => {
    expect(resolveChartGranularity("hourly", "14d")).toBe("hourly")
    expect(resolveChartGranularity("daily", "24h")).toBe("daily")
  })
})
