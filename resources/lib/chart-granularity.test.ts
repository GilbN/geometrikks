import { describe, expect, it } from "vitest"
import { resolveChartGranularity } from "./api"

describe("resolveChartGranularity", () => {
  it("uses daily buckets from 7 days up", () => {
    expect(resolveChartGranularity("auto", "7d")).toBe("daily")
    expect(resolveChartGranularity("auto", "14d")).toBe("daily")
    expect(resolveChartGranularity("auto", "custom", { from: "2026-08-14T00:00:00Z", to: "2026-08-21T00:00:00Z" })).toBe("daily")
  })

  it("keeps hourly buckets below 7 days", () => {
    expect(resolveChartGranularity("auto", "24h")).toBe("hourly")
    expect(resolveChartGranularity("auto", "custom", { from: "2026-08-14T00:00:00Z", to: "2026-08-20T23:00:00Z" })).toBe("hourly")
  })

  it("honors an explicit choice", () => {
    expect(resolveChartGranularity("hourly", "7d")).toBe("hourly")
    expect(resolveChartGranularity("daily", "24h")).toBe("daily")
  })
})
