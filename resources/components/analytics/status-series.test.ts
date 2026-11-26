import { describe, expect, it } from "vite-plus/test"
import type { TimeSeriesDataPoint } from "@/generated/api/types.gen"
import {
  errorRateSeries,
  isIsolated,
  shareRows,
  statusTotal,
  withInformational,
} from "./status-series"

function point(overrides: Partial<TimeSeriesDataPoint>): TimeSeriesDataPoint {
  return {
    timestamp: "2026-08-14T00:00:00Z",
    totalRequests: 0,
    totalBytesSent: 0,
    totalGeoEvents: 0,
    status2xx: 0,
    status3xx: 0,
    status4xx: 0,
    status5xx: 0,
    errorRate: 0,
    timedRequests: 0,
    avgRequestTime: null,
    maxRequestTime: null,
    p50RequestTime: null,
    p95RequestTime: null,
    p99RequestTime: null,
    ...overrides,
  }
}

describe("shareRows", () => {
  it("nulls every class for a zero-sum bucket so areas break", () => {
    const [empty, busy] = shareRows([
      point({}),
      point({ status2xx: 9, status4xx: 1, totalRequests: 10 }),
    ])
    expect([empty.status2xx, empty.status3xx, empty.status4xx, empty.status5xx]).toEqual([
      null,
      null,
      null,
      null,
    ])
    expect(busy.status2xx).toBe(9)
  })
})

describe("statusTotal", () => {
  it("adds the four classes and counts a missing class as 0", () => {
    expect(statusTotal({ status2xx: 1234, status3xx: null, status4xx: 266, status5xx: 0 })).toBe(
      1500,
    )
  })
})

describe("withInformational", () => {
  it("counts the requests no class holds as 1xx", () => {
    const [ws, plain] = withInformational([
      point({ totalRequests: 50, status2xx: 8, status4xx: 2 }),
      point({ totalRequests: 10, status2xx: 10 }),
    ])
    expect(ws.status1xx).toBe(40)
    expect(plain.status1xx).toBe(0)
  })
})

describe("isIsolated", () => {
  it("flags a value with no neighbours, which a line cannot draw", () => {
    const values = [null, 0.5, null, 0.1, 0.2, null, 1]
    expect(values.map((_, i) => isIsolated(values, i))).toEqual([
      false,
      true,
      false,
      false,
      false,
      false,
      true,
    ])
  })
})

describe("errorRateSeries", () => {
  it("plots a gap, not 0%, for buckets without requests", () => {
    const { rows } = errorRateSeries(
      [point({}), point({ totalRequests: 10, errorRate: 0.1 })],
      "full",
    )
    expect(rows.map((r) => r.errorRate)).toEqual([null, 0.1])
  })

  it("uses a 0 to 100% axis when every rate is 0", () => {
    const points = Array.from({ length: 10 }, () => point({ totalRequests: 5 }))
    expect(errorRateSeries(points, "full").axis).toEqual({ domain: [0, 1] })
    expect(errorRateSeries(points, "clip")).toMatchObject({
      axis: { domain: [0, 1] },
      clipMax: null,
    })
  })

  it("lets Recharts pick the top when some rate is above 0", () => {
    const points = [point({ totalRequests: 5, errorRate: 0.02 }), point({ totalRequests: 5 })]
    expect(errorRateSeries(points, "full").axis).toEqual({ domain: [0, "auto"] })
  })

  it("clips a spike below 100%", () => {
    const points = [
      ...Array.from({ length: 99 }, () => point({ totalRequests: 5, errorRate: 0.01 })),
      point({ totalRequests: 5, errorRate: 0.9 }),
    ]
    const out = errorRateSeries(points, "clip")
    expect(out.clipMax).toBeCloseTo(0.02)
    expect(out.axis).toMatchObject({ allowDataOverflow: true })
  })

  it("never clips at or above 100%", () => {
    const points = [
      ...Array.from({ length: 99 }, () => point({ totalRequests: 5, errorRate: 0.9 })),
      point({ totalRequests: 5, errorRate: 1 }),
    ]
    expect(errorRateSeries(points, "clip").clipMax).toBeNull()
  })
})
