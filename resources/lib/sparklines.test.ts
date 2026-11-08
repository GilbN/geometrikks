import { describe, expect, it } from "vitest"
import { buildGeoLogSparklines, buildOverviewSparklines, fillGaps, geoLogSparklinesFromSeries, hasSparklines, sparklineGranularity } from "./sparklines"
import type { TimeSeriesResponse } from "./api"

const HOUR = 3_600_000
const at = (iso: string) => Date.parse(iso)

describe("sparklineGranularity", () => {
  it("uses hours up to a week and days above", () => {
    expect(sparklineGranularity(0, 24 * HOUR)).toBe("hourly")
    expect(sparklineGranularity(0, 7 * 24 * HOUR)).toBe("hourly")
    expect(sparklineGranularity(0, 14 * 24 * HOUR)).toBe("daily")
  })
})

describe("hasSparklines", () => {
  it("skips ranges too short to draw a shape", () => {
    expect(hasSparklines(0, 3 * HOUR)).toBe(false)
    expect(hasSparklines(0, 6 * HOUR)).toBe(true)
    expect(hasSparklines(0, 30 * 24 * HOUR)).toBe(true)
  })
})

describe("hasSparklines with a chosen granularity", () => {
  const start = at("2026-11-07T00:00:00Z")

  it("needs enough buckets at that granularity", () => {
    expect(hasSparklines(start, start + 24 * 3_600_000, "hourly")).toBe(true)
    expect(hasSparklines(start, start + 24 * 3_600_000, "daily")).toBe(false)
    expect(hasSparklines(start, start + 7 * 24 * 3_600_000, "daily")).toBe(true)
  })
})

describe("fillGaps", () => {
  const start = at("2026-11-06T10:37:00Z")
  const end = at("2026-11-06T16:37:00Z")

  it("puts zeros back for hours without traffic", () => {
    const points = [
      { timestamp: "2026-11-06T11:00:00Z", value: 5 },
      { timestamp: "2026-11-06T14:00:00Z", value: 7 },
    ]
    // 10:00, [11:00], 12:00, 13:00, [14:00], 15:00, 16:00
    expect(fillGaps(points, start, end, HOUR)).toEqual([0, 5, 0, 0, 7, 0, 0])
  })

  it("starts at the bucket that holds the range start", () => {
    const points = [{ timestamp: "2026-11-06T10:00:00Z", value: 3 }]
    expect(fillGaps(points, start, end, HOUR)).toEqual([3, 0, 0, 0, 0, 0, 0])
  })

  it("draws a flat line when the range has no traffic", () => {
    expect(fillGaps([], start, end, HOUR)).toEqual([0, 0, 0, 0, 0, 0])
  })

  it("counts a 25-hour local day as one step", () => {
    const day = 24 * HOUR
    const points = [
      { timestamp: "2026-10-24T22:00:00Z", value: 1 },
      { timestamp: "2026-10-25T23:00:00Z", value: 2 },
      { timestamp: "2026-10-26T23:00:00Z", value: 3 },
    ]
    const filled = fillGaps(points, at("2026-10-24T22:00:00Z"), at("2026-10-27T10:00:00Z"), day)
    expect(filled).toEqual([1, 2, 3])
  })
})

describe("buildOverviewSparklines", () => {
  const row = (timestamp: string, totalRequests: number, avgRequestTime: number | null) => ({
    timestamp,
    totalRequests,
    totalGeoEvents: 0,
    totalBytesSent: totalRequests * 100,
    status2xx: totalRequests,
    status3xx: 0,
    status4xx: 0,
    status5xx: 0,
    errorRate: 0,
    timedRequests: avgRequestTime == null ? 0 : totalRequests,
    avgRequestTime,
    maxRequestTime: avgRequestTime,
    p50RequestTime: null,
    p95RequestTime: null,
    p99RequestTime: null,
  })

  it("zero-fills counts but leaves empty buckets out of averages", () => {
    const series = {
      granularity: "hourly",
      startDate: "2026-11-06T10:00:00Z",
      endDate: "2026-11-06T16:00:00Z",
      data: [row("2026-11-06T10:00:00Z", 4, 0.2), row("2026-11-06T13:00:00Z", 2, null)],
    } as TimeSeriesResponse
    const lines = buildOverviewSparklines(series, undefined, at(series.startDate), at(series.endDate))

    expect(lines.requests).toEqual([4, 0, 0, 2, 0, 0])
    expect(lines.avgRequestTime).toEqual([0.2])
    expect(lines.avgRequestSize).toEqual([100, 100])
    expect(lines.successRate).toEqual([1, 1])
    expect(lines.geoEvents).toEqual([0, 0, 0, 0, 0, 0])
  })
})

describe("buildGeoLogSparklines", () => {
  it("zero-fills every count from the gaps between buckets", () => {
    const start = at("2026-11-06T10:00:00Z")
    const end = at("2026-11-06T16:00:00Z")
    const series = {
      granularity: "hourly",
      startDate: "2026-11-06T10:00:00Z",
      endDate: "2026-11-06T16:00:00Z",
      data: [
        { timestamp: "2026-11-06T11:00:00Z", totalEvents: 9, uniqueIps: 4, uniqueCountries: 3, uniqueCities: 2 },
        { timestamp: "2026-11-06T14:00:00Z", totalEvents: 5, uniqueIps: 2, uniqueCountries: 1, uniqueCities: 1 },
      ],
    }
    expect(buildGeoLogSparklines(series, start, end)).toEqual({
      events: [0, 9, 0, 0, 5, 0],
      uniqueIps: [0, 4, 0, 0, 2, 0],
      uniqueCountries: [0, 3, 0, 0, 1, 0],
      uniqueCities: [0, 2, 0, 0, 1, 0],
    })
  })
})

describe("buildGeoLogSparklines at a daily granularity", () => {
  it("fills gaps a day apart on a range Auto draws hourly", () => {
    const series = {
      granularity: "daily",
      startDate: "2026-11-01T00:00:00Z",
      endDate: "2026-11-08T00:00:00Z",
      data: [{ timestamp: "2026-11-03T00:00:00Z", totalEvents: 7, uniqueIps: 3, uniqueCountries: 2, uniqueCities: 1 }],
    }
    expect(geoLogSparklinesFromSeries(series).events).toEqual([0, 0, 7, 0, 0, 0, 0])
  })
})

describe("buildGeoLogSparklines on an hourly range over 30 days", () => {
  const row = { totalEvents: 4, uniqueIps: 2, uniqueCountries: 1, uniqueCities: 1 }

  it("keeps a quiet start at 30 days or less, where no hourly rows have expired", () => {
    const series = {
      granularity: "hourly",
      startDate: "2026-10-16T00:00:00Z",
      endDate: "2026-11-15T00:00:00Z",
      data: [{ timestamp: "2026-11-14T23:00:00Z", ...row }],
    }
    const events = geoLogSparklinesFromSeries(series).events
    expect(events).toHaveLength(720)
    expect(events[0]).toBe(0)
    expect(events[719]).toBe(4)
  })

  it("starts at the first bucket an hour past 30 days", () => {
    const series = {
      granularity: "hourly",
      startDate: "2026-10-16T00:00:00Z",
      endDate: "2026-11-15T01:00:00Z",
      data: [{ timestamp: "2026-11-14T23:00:00Z", ...row }],
    }
    expect(geoLogSparklinesFromSeries(series).events).toEqual([4, 0])
  })

  it("draws nothing when every hourly row has expired", () => {
    const series = { granularity: "hourly", startDate: "2026-08-01T00:00:00Z", endDate: "2026-11-08T00:00:00Z", data: [] }
    expect(geoLogSparklinesFromSeries(series).events).toEqual([])
  })

  it("starts at the first bucket, since older hourly rows have expired", () => {
    const series = {
      granularity: "hourly",
      startDate: "2026-08-01T00:00:00Z",
      endDate: "2026-11-08T00:00:00Z",
      data: [
        { timestamp: "2026-11-07T21:00:00Z", totalEvents: 4, uniqueIps: 2, uniqueCountries: 1, uniqueCities: 1 },
        { timestamp: "2026-11-07T23:00:00Z", totalEvents: 6, uniqueIps: 3, uniqueCountries: 1, uniqueCities: 1 },
      ],
    }
    expect(geoLogSparklinesFromSeries(series).events).toEqual([4, 0, 6])
  })
})

describe("geoLogSparklinesFromSeries", () => {
  it("fills gaps across the window the response echoes", () => {
    const series = {
      granularity: "hourly",
      startDate: "2026-11-06T10:00:00.000000+00:00",
      endDate: "2026-11-06T16:00:00.000000+00:00",
      data: [{ timestamp: "2026-11-06T12:00:00Z", totalEvents: 7, uniqueIps: 3, uniqueCountries: 2, uniqueCities: 1 }],
    }
    expect(geoLogSparklinesFromSeries(series).events).toEqual([0, 0, 7, 0, 0, 0])
  })
})
