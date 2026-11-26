import { describe, expect, it } from "vite-plus/test"
import { scaleSeries } from "@/lib/chart-scale"
import { bandRows, LATENCY_KEYS } from "./latency-series"

describe("bandRows", () => {
  it("holds exactly p50 and p95, or null when either is missing", () => {
    const rows = bandRows([
      { p50RequestTime: 0.08, p95RequestTime: 0.4 },
      { p50RequestTime: null, p95RequestTime: 0.4 },
      { p50RequestTime: 0.08, p95RequestTime: undefined },
    ])
    expect(rows.map((r) => r.band)).toEqual([[0.08, 0.4], null, null])
  })

  it("uses floored endpoints in log mode and keeps the raw zeros", () => {
    const rows = [
      { avgRequestTime: 0, p50RequestTime: 0, p95RequestTime: 0.4, p99RequestTime: 1.1 },
      { avgRequestTime: 0.12, p50RequestTime: 0.08, p95RequestTime: 0.4, p99RequestTime: 1.1 },
    ]
    // Smallest positive value 0.08 gives a log axis minimum of 0.01.
    const [first] = bandRows(scaleSeries(rows, LATENCY_KEYS, "log").rows)
    expect(first.band).toEqual([0.01, 0.4])
    expect(first.raw).toEqual({
      avgRequestTime: 0,
      p50RequestTime: 0,
      p95RequestTime: 0.4,
      p99RequestTime: 1.1,
    })
  })
})
