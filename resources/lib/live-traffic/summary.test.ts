import { describe, expect, it } from "vitest"
import { EMPTY_SUMMARY, smooth, summarize, trendPercent } from "./summary"
import type { LiveRequest } from "./types"

function request(overrides: Partial<LiveRequest> = {}): LiveRequest {
  return {
    id: Math.random().toString(36).slice(2),
    timestamp: "2026-07-22T19:57:54+02:00",
    receivedAt: 0,
    ip: "1.1.1.1",
    coordinates: [10, 59],
    city: "Oslo",
    countryCode: "NO",
    log: null,
    statusClass: "2xx",
    banned: false,
    threat: false,
    ...overrides,
  }
}

describe("summarize", () => {
  it("returns the empty summary for an empty window", () => {
    expect(summarize([])).toBe(EMPTY_SUMMARY)
  })

  it("counts the response mix as shares of the window", () => {
    const summary = summarize([
      request({ statusClass: "2xx" }),
      request({ statusClass: "2xx" }),
      request({ statusClass: "4xx" }),
      request({ statusClass: "5xx" }),
    ])

    expect(summary.total).toBe(4)
    expect(summary.mix).toEqual([
      { status: "2xx", count: 2, share: 0.5 },
      { status: "4xx", count: 1, share: 0.25 },
      { status: "5xx", count: 1, share: 0.25 },
    ])
  })

  it("orders the mix healthy to worst regardless of arrival order", () => {
    const summary = summarize([
      request({ statusClass: "5xx" }),
      request({ statusClass: "2xx" }),
      request({ statusClass: "3xx" }),
    ])

    expect(summary.mix.map((slice) => slice.status)).toEqual(["2xx", "3xx", "5xx"])
  })

  it("ranks origins by count and scales the bars against the busiest", () => {
    const summary = summarize([
      request({ countryCode: "NO" }),
      request({ countryCode: "NO" }),
      request({ countryCode: "NO" }),
      request({ countryCode: "US" }),
    ])

    expect(summary.origins).toEqual([
      { country: "NO", count: 3, share: 1 },
      { country: "US", count: 1, share: 1 / 3 },
    ])
  })

  it("breaks equal origin counts by code so the order does not flicker", () => {
    const summary = summarize([request({ countryCode: "US" }), request({ countryCode: "BR" })])

    expect(summary.origins.map((origin) => origin.country)).toEqual(["BR", "US"])
  })

  it("buckets requests with no GeoIP match under ??", () => {
    const summary = summarize([request({ countryCode: null })])

    expect(summary.origins).toEqual([{ country: "??", count: 1, share: 1 }])
  })

  it("caps the origin list", () => {
    const summary = summarize(
      ["A", "B", "C", "D", "E"].map((code) => request({ countryCode: code })),
      2,
    )

    expect(summary.origins).toHaveLength(2)
  })

  it("counts threats as requests but banned IPs as distinct addresses", () => {
    const summary = summarize([
      request({ ip: "9.9.9.9", banned: true, threat: true }),
      request({ ip: "9.9.9.9", banned: true, threat: true }),
      request({ ip: "8.8.8.8", threat: true }),
    ])

    // Three threatening requests, from two addresses, one of which is banned.
    expect(summary.threats).toBe(3)
    expect(summary.bannedIps).toBe(1)
  })
})

describe("trendPercent", () => {
  it("compares the second half of the window with the first", () => {
    expect(trendPercent([5, 5, 10, 10])).toBe(100)
    expect(trendPercent([10, 10, 5, 5])).toBe(-50)
  })

  it("is null when there is no earlier traffic to compare against", () => {
    expect(trendPercent([0, 0, 5, 5])).toBeNull()
  })

  it("is null while the earlier half is too thin to divide by", () => {
    // A page opened seconds ago: two requests then a burst is not "+900%".
    expect(trendPercent([1, 1, 10, 10])).toBeNull()
    expect(trendPercent([3, 2, 10, 10])).toBe(300)
  })

  it("is null for a window too short to halve meaningfully", () => {
    expect(trendPercent([1, 2, 3])).toBeNull()
  })

  it("is zero when the halves match", () => {
    expect(trendPercent([3, 3, 3, 3])).toBe(0)
  })

  it("rounds to the nearest 5 so bursty traffic does not flicker the reading", () => {
    // 3% up: a real change, but not one worth redrawing the badge for.
    expect(trendPercent([100, 100, 103, 103])).toBe(5)
    expect(trendPercent([100, 100, 100, 101])).toBe(0)
  })
})

describe("smooth", () => {
  it("averages each sample over its neighbours", () => {
    expect(smooth([0, 0, 10, 0, 0], 3)).toEqual([0, 10 / 3, 10 / 3, 10 / 3, 0])
  })

  it("averages edge samples over the window they have", () => {
    expect(smooth([6, 0, 0], 3)).toEqual([3, 2, 0])
  })

  it("flattens a burst comb into a rhythm", () => {
    const comb = [4, 0, 0, 4, 0, 0, 4, 0, 0]
    const smoothed = smooth(comb, 5)

    // The spikes and the troughs converge on the underlying rate.
    expect(Math.max(...smoothed) - Math.min(...smoothed)).toBeLessThan(
      Math.max(...comb) - Math.min(...comb),
    )
  })

  it("leaves the series alone when there is nothing to average over", () => {
    expect(smooth([1, 2, 3], 1)).toEqual([1, 2, 3])
    expect(smooth([], 5)).toEqual([])
  })
})
