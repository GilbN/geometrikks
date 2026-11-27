import { afterEach, describe, expect, it } from "vite-plus/test"
import type { TimeSeriesDataPoint } from "@/generated/api/types.gen"
import {
  bucketEndMs,
  byteTicks,
  dragSelection,
  fillHourlyGaps,
  hourlyTicks,
  hoursSince,
  trafficTotals,
} from "./traffic-series"

const HOUR = 3_600_000
const START = Date.parse("2026-11-19T22:00:00Z")

function row(hour: number, total = 10): TimeSeriesDataPoint {
  return {
    timestamp: new Date(START + hour * HOUR).toISOString(),
    totalRequests: total,
    totalBytesSent: total * 100,
    totalGeoEvents: total,
    status2xx: total - 2,
    status3xx: 1,
    status4xx: 1,
    status5xx: 0,
    errorRate: 0.1,
    timedRequests: total,
    avgRequestTime: 0.1,
    maxRequestTime: 1,
    p50RequestTime: 0.05,
    p95RequestTime: 0.3,
    p99RequestTime: 0.6,
  }
}

function response(
  rows: TimeSeriesDataPoint[],
  startMs: number,
  endMs: number,
  granularity = "hourly",
) {
  return {
    data: rows,
    granularity,
    startDate: new Date(startMs).toISOString(),
    endDate: new Date(endMs).toISOString(),
  }
}

describe("fillHourlyGaps", () => {
  it("puts empty hours back between, before and after the returned rows", () => {
    // Range 21:37 to 03:37 the next day; rows at 22:00, 23:00 and 01:00.
    const filled = fillHourlyGaps(
      response([row(0), row(1), row(3)], START - 23 * 60_000, START + 5 * HOUR + 37 * 60_000),
      0,
    )
    expect(filled.map((point) => (Date.parse(point.timestamp) - START) / HOUR)).toEqual([
      -1, 0, 1, 2, 3, 4, 5,
    ])
    expect(filled[3]).toMatchObject({ totalRequests: 0, p99RequestTime: null, timedRequests: 0 })
  })

  it("keeps daily rows as they are", () => {
    const rows = [row(0), row(48)]
    expect(fillHourlyGaps(response(rows, START, START + 72 * HOUR, "daily"), 0)).toBe(rows)
  })

  it("starts at the first row when the range starts before the kept hours", () => {
    const rows = [row(0), row(2)]
    const range = response(rows, START - 10 * HOUR, START + 3 * HOUR)
    const filled = fillHourlyGaps(range, START - 5 * HOUR)
    expect(filled).toHaveLength(3)
    expect(filled[0]).toBe(rows[0])
    expect(fillHourlyGaps(range, START - 10 * HOUR)).toHaveLength(13)
  })

  it("adds no empty buckets after now", () => {
    const range = response([row(0)], START, START + 10 * HOUR)
    expect(fillHourlyGaps(range, 0, START + 2 * HOUR + 60_000)).toHaveLength(3)
  })

  it("adds no bucket at the range's exclusive end", () => {
    const filled = fillHourlyGaps(response([row(0), row(1)], START, START + 3 * HOUR), 0)
    expect(filled.map((point) => (Date.parse(point.timestamp) - START) / HOUR)).toEqual([0, 1, 2])
  })

  it("follows half-hour bucket edges", () => {
    const half = (hour: number) => ({
      ...row(hour),
      timestamp: new Date(START + hour * HOUR + 30 * 60_000).toISOString(),
    })
    const filled = fillHourlyGaps(response([half(0), half(2)], START, START + 3 * HOUR), 0)
    // The bucket from half past the hour before the start overlaps the range too.
    expect(filled.map((point) => new Date(point.timestamp).getUTCMinutes())).toEqual([
      30, 30, 30, 30,
    ])
    expect(Date.parse(filled[0].timestamp)).toBe(START - 30 * 60_000)
  })

  it("draws the rows as sent when one is off the hour grid", () => {
    const odd = { ...row(1), timestamp: new Date(START + HOUR + 60_000).toISOString() }
    const rows = [row(0), odd, row(2)]
    expect(fillHourlyGaps(response(rows, START, START + 2 * HOUR), 0)).toBe(rows)
  })
})

describe("trafficTotals", () => {
  it("sums requests, bytes and the four classes", () => {
    expect(trafficTotals([row(0, 10), row(1, 20)])).toEqual({
      totalRequests: 30,
      totalBytesSent: 3000,
      status2xx: 26,
      status3xx: 2,
      status4xx: 2,
      status5xx: 0,
    })
  })
})

describe("hourlyTicks", () => {
  const tz = process.env.TZ
  afterEach(() => {
    process.env.TZ = tz
  })

  const hours = (from: string, count: number) =>
    Array.from({ length: count }, (_, index) =>
      new Date(Date.parse(from) + index * HOUR).toISOString(),
    )

  it("leaves daily buckets to the axis", () => {
    expect(hourlyTicks(hours("2026-11-19T00:00:00Z", 8), "daily", 1000)).toBeNull()
  })

  it("puts one date label at each midnight on a week", () => {
    process.env.TZ = "UTC"
    const ticks = hourlyTicks(hours("2026-11-19T22:00:00Z", 169), "hourly", 1060)!
    expect(ticks.ticks.map(ticks.format)).toEqual([
      "Nov 20",
      "Nov 21",
      "Nov 22",
      "Nov 23",
      "Nov 24",
      "Nov 25",
      "Nov 26",
    ])
  })

  it("labels every second midnight on a narrow week, leaving out one on the edge", () => {
    process.env.TZ = "UTC"
    const ticks = hourlyTicks(hours("2026-11-19T22:00:00Z", 169), "hourly", 265)!
    expect(ticks.ticks.map(ticks.format)).toEqual(["Nov 22", "Nov 24", "Nov 26"])
  })

  it("marks every second hour on a short zoom and dates midnight", () => {
    process.env.TZ = "UTC"
    const ticks = hourlyTicks(hours("2026-11-23T00:00:00Z", 10), "hourly", 1060)!
    expect(ticks.ticks.map(ticks.format)).toEqual(["Nov 23", "2 AM", "4 AM", "6 AM", "8 AM"])
  })

  it("spaces date labels by width on a long range", () => {
    process.env.TZ = "UTC"
    const ticks = hourlyTicks(hours("2025-11-27T00:00:00Z", 365 * 24), "hourly", 240)!
    expect(ticks.ticks.length * 56).toBeLessThanOrEqual(240)
  })

  it("marks hours, not dates, on a two-day range of 49 buckets", () => {
    process.env.TZ = "UTC"
    const ticks = hourlyTicks(hours("2026-11-23T10:00:00Z", 49), "hourly", 1060)!
    expect(ticks.ticks.map(ticks.format)).toContain("Nov 24")
    expect(ticks.ticks.map(ticks.format)).toContain("3 PM")
  })

  it("labels the repeated hour at the end of daylight saving once", () => {
    process.env.TZ = "Europe/Oslo"
    // 2026-10-25 02:00 local happens twice: 00:00Z and 01:00Z.
    const ticks = hourlyTicks(hours("2026-10-24T22:00:00Z", 12), "hourly", 1060)!
    expect(ticks.ticks.map(ticks.format)).toEqual([
      "Oct 25",
      "2 AM",
      "4 AM",
      "6 AM",
      "8 AM",
      "10 AM",
    ])
  })

  it("dates the first hour of a day whose midnight daylight saving skips", () => {
    process.env.TZ = "America/Santiago"
    // Clocks jump from 00:00 to 01:00 on 2026-09-06 in Santiago.
    const week = hours("2026-09-03T04:00:00Z", 169)
    const ticks = hourlyTicks(week, "hourly", 1060)!
    expect(ticks.ticks.map(ticks.format)).toContain("Sep 6")
  })

  it("shows minutes on buckets that start at half past in the browser's timezone", () => {
    process.env.TZ = "Asia/Kolkata"
    const ticks = hourlyTicks(hours("2026-11-23T00:00:00Z", 12), "hourly", 1060)!
    expect(ticks.ticks.map(ticks.format)[0]).toMatch(/^\d{1,2}:30 [AP]M$/)
  })

  it("labels the only bucket of a short range", () => {
    process.env.TZ = "UTC"
    const ticks = hourlyTicks(hours("2026-11-23T13:00:00Z", 1), "hourly", 1060)!
    expect(ticks.ticks.map(ticks.format)).toEqual(["1 PM"])
  })

  it("marks every third hour on a day, and fewer on a phone", () => {
    process.env.TZ = "UTC"
    const day = hours("2026-11-23T00:00:00Z", 25)
    expect(hourlyTicks(day, "hourly", 1060)!.ticks).toHaveLength(9)
    // Every sixth hour; the midnights at both ends sit on the edge.
    expect(hourlyTicks(day, "hourly", 280)!.ticks).toHaveLength(3)
  })
})

describe("byteTicks", () => {
  const MB = 1024 ** 2
  it("steps in whole units of the label", () => {
    expect(byteTicks(7.3 * MB).ticks.map((tick) => tick / MB)).toEqual([0, 2, 4, 6, 8])
    expect(byteTicks(4 * MB).ticks.map((tick) => tick / MB)).toEqual([0, 1, 2, 3, 4])
    expect(byteTicks(900 * 1024).ticks.map((tick) => tick / 1024)).toEqual([0, 250, 500, 750, 1000])
  })

  it("draws an empty axis to 1 KB", () => {
    expect(byteTicks(0)).toEqual({ ticks: [0, 1024], domain: [0, 1024] })
  })
})

describe("hoursSince", () => {
  it("names the first drawn day when the hours before it have expired", () => {
    const rows = [{ timestamp: "2026-09-28T05:00:00Z" }]
    expect(hoursSince(rows, "2026-08-01T00:00:00Z", "hourly")).toMatch(/^since Sep 2[78]$/)
    expect(hoursSince(rows, "2026-09-28T04:30:00Z", "hourly")).toBeNull()
    expect(hoursSince(rows, "2026-08-01T00:00:00Z", "daily")).toBeNull()
  })
})

describe("bucketEndMs and dragSelection", () => {
  const tz = process.env.TZ
  afterEach(() => {
    process.env.TZ = tz
  })
  const day = (iso: string) => Date.parse(iso)

  it("ends a daily bucket at the next day, not at the next row after a quiet gap", () => {
    process.env.TZ = "UTC"
    const times = [
      day("2026-11-01T00:00:00Z"),
      day("2026-11-02T00:00:00Z"),
      day("2026-11-10T00:00:00Z"),
    ]
    expect(bucketEndMs(times, 0, "daily")).toBe(day("2026-11-02T00:00:00Z"))
    expect(bucketEndMs(times, 1, "daily")).toBe(day("2026-11-03T00:00:00Z"))
  })

  it("ends a local day at the next local midnight across daylight saving", () => {
    process.env.TZ = "Europe/Oslo"
    // 2026-10-25 has 25 hours in Oslo; local midnight is 22:00Z the day before.
    const times = [day("2026-10-24T22:00:00Z")]
    expect(bucketEndMs(times, 0, "daily")).toBe(day("2026-10-25T23:00:00Z"))
  })

  it("keeps a selection inside the page's range", () => {
    const times = [0, 1, 2, 3].map((hour) => START + hour * HOUR)
    const range = { startMs: START + 15 * 60_000, endMs: START + 3 * HOUR + 30 * 60_000 }
    expect(dragSelection(times, times[0], times[3], "hourly", range)).toEqual({
      startMs: range.startMs,
      endMs: range.endMs,
      buckets: 4,
    })
    expect(dragSelection(times, times[1], times[0], "hourly", range)).toBeNull()
  })
})
