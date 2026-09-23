import { describe, expect, it } from "vitest"
import { scaleSeries } from "@/lib/chart-scale"
import { bandRows, LATENCY_KEYS, latencyTooltipRows } from "./latency-series"

describe("bandRows", () => {
  it("holds exactly p50 and p95, or null when either is missing", () => {
    const rows = bandRows([
      { p50RequestTime: 0.08, p95RequestTime: 0.4 },
      { p50RequestTime: null, p95RequestTime: 0.4 },
      { p50RequestTime: 0.08, p95RequestTime: undefined },
    ])
    expect(rows.map((r) => r.band)).toEqual([[0.08, 0.4], null, null])
  })

  it("uses floored endpoints in log mode while the tooltip keeps raw zeros", () => {
    const rows = [
      { avgRequestTime: 0, p50RequestTime: 0, p95RequestTime: 0.4, p99RequestTime: 1.1 },
      { avgRequestTime: 0.12, p50RequestTime: 0.08, p95RequestTime: 0.4, p99RequestTime: 1.1 },
    ]
    // Smallest positive value 0.08 gives a log axis minimum of 0.01.
    const [first] = bandRows(scaleSeries(rows, LATENCY_KEYS, "log").rows)
    expect(first.band).toEqual([0.01, 0.4])
    expect(latencyTooltipRows(first).map((r) => r.value)).toEqual([0, 0, 0.4, 1.1])
  })
})

describe("latencyTooltipRows", () => {
  it("lists Average, p50, p95 and p99 with raw values and colors", () => {
    const row = {
      avgRequestTime: 0.001, p50RequestTime: 0.001, p95RequestTime: 0.4, p99RequestTime: 1.1,
      raw: { avgRequestTime: 0, p50RequestTime: 0, p95RequestTime: 0.4, p99RequestTime: 1.1 },
    }
    const out = latencyTooltipRows(row)
    expect(out.map((r) => [r.dataKey, r.name, r.value])).toEqual([
      ["avgRequestTime", "Average", 0],
      ["p50RequestTime", "p50", 0],
      ["p95RequestTime", "p95", 0.4],
      ["p99RequestTime", "p99", 1.1],
    ])
    expect(out[3].color).toBe("var(--chart-4)")
  })

  it("turns missing and undefined values into null", () => {
    const out = latencyTooltipRows({ avgRequestTime: null })
    expect(out.map((r) => r.value)).toEqual([null, null, null, null])
  })
})
