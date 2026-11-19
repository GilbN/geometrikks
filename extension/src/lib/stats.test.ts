import { describe, expect, it } from "vite-plus/test"
import type { TimeSeriesDataPoint } from "@/generated/api/types.gen"
import { summarize, toSixHour, zeroFillHourly, type HourBucket } from "./stats"

function point(timestamp: string, counts: Partial<TimeSeriesDataPoint>): TimeSeriesDataPoint {
  return {
    timestamp,
    totalRequests: 0,
    status2xx: 0,
    status3xx: 0,
    status4xx: 0,
    status5xx: 0,
    totalBytesSent: 0,
    errorRate: 0,
    timedRequests: 0,
    totalGeoEvents: 0,
    avgRequestTime: null,
    maxRequestTime: null,
    p50RequestTime: null,
    p95RequestTime: null,
    p99RequestTime: null,
    ...counts,
  }
}

describe("summarize", () => {
  it("sums requests, bytes and 4xx plus 5xx errors", () => {
    const result = summarize([
      point("2026-11-19T10:00:00Z", { totalRequests: 30, status4xx: 2, totalBytesSent: 1000 }),
      point("2026-11-19T11:00:00Z", {
        totalRequests: 10,
        status4xx: 1,
        status5xx: 1,
        totalBytesSent: 500,
      }),
    ])
    expect(result).toEqual({ requests: 40, errors: 4, bytes: 1500, errorRate: 0.1 })
  })

  it("has no error rate without requests", () => {
    expect(summarize([]).errorRate).toBeNull()
    expect(summarize([point("2026-11-19T10:00:00Z", {})]).errorRate).toBeNull()
  })
})

describe("zeroFillHourly", () => {
  it("gives one bucket per hour, both ends included, and keeps edge points", () => {
    const buckets = zeroFillHourly(
      [
        point("2026-11-18T10:00:00Z", { totalRequests: 3, status5xx: 1 }),
        point("2026-11-19T10:00:00Z", { totalRequests: 5, status4xx: 2 }),
      ],
      new Date("2026-11-18T10:20:00Z"),
      new Date("2026-11-19T10:20:00Z"),
    )
    expect(buckets).toHaveLength(25)
    expect(buckets[0]).toEqual({ start: new Date("2026-11-18T10:00:00Z"), requests: 3, errors: 1 })
    expect(buckets[24]).toEqual({ start: new Date("2026-11-19T10:00:00Z"), requests: 5, errors: 2 })
    expect(buckets.slice(1, 24).every((bucket) => bucket.requests === 0)).toBe(true)
  })

  it("drops points outside the range", () => {
    const buckets = zeroFillHourly(
      [point("2026-11-17T10:00:00Z", { totalRequests: 9 })],
      new Date("2026-11-18T10:20:00Z"),
      new Date("2026-11-18T12:20:00Z"),
    )
    expect(buckets.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(0)
  })
})

describe("toSixHour", () => {
  it("sums hours into local 00, 06, 12 and 18 blocks", () => {
    const hour = (h: number, requests: number, errors = 0): HourBucket => ({
      start: new Date(2026, 10, 18, h),
      requests,
      errors,
    })
    const blocks = toSixHour([hour(4, 1), hour(5, 2, 1), hour(6, 3), hour(11, 4, 2), hour(12, 5)])
    expect(blocks).toEqual([
      { start: new Date(2026, 10, 18, 0), requests: 3, errors: 1 },
      { start: new Date(2026, 10, 18, 6), requests: 7, errors: 2 },
      { start: new Date(2026, 10, 18, 12), requests: 5, errors: 0 },
    ])
  })
})
