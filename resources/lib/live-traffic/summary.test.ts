import { describe, expect, it } from "vitest"
import { describeDecisions, EMPTY_SUMMARY, smooth, summarize, trendPercent } from "./summary"
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
    hostname: null,
    statusClass: "2xx",
    banned: false,
    decisionType: null,
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

  it("counts threats as requests but decisions as distinct addresses per type", () => {
    const summary = summarize([
      request({ ip: "9.9.9.9", banned: true, decisionType: "ban", threat: true }),
      request({ ip: "9.9.9.9", banned: true, decisionType: "ban", threat: true }),
      request({ ip: "7.7.7.7", banned: true, decisionType: "captcha", threat: true }),
      request({ ip: "6.6.6.6", banned: true, decisionType: "throttle", threat: true }),
      request({ ip: "8.8.8.8", threat: true }),
    ])

    expect(summary.threats).toBe(5)
    expect(summary.decisions).toEqual({ ban: 1, captcha: 1, other: 1 })
  })

  it("counts an IP under the type on its most recent request, whatever the buffer order", () => {
    // The store keeps requests newest first; the rule must not depend on that.
    const newerBan = request({ ip: "9.9.9.9", banned: true, decisionType: "ban", threat: true, receivedAt: 2000 })
    const olderCaptcha = request({ ip: "9.9.9.9", banned: true, decisionType: "captcha", threat: true, receivedAt: 1000 })

    expect(summarize([newerBan, olderCaptcha]).decisions).toEqual({ ban: 1, captcha: 0, other: 0 })
    expect(summarize([olderCaptcha, newerBan]).decisions).toEqual({ ban: 1, captcha: 0, other: 0 })
  })
})

describe("describeDecisions", () => {
  it("lists the non-zero types in order and returns null for none", () => {
    expect(describeDecisions({ ban: 3, captcha: 1, other: 0 })).toBe("Banned 3 IPs · Captcha 1 IP")
    expect(describeDecisions({ ban: 0, captcha: 0, other: 2 })).toBe("Other decisions 2 IPs")
    expect(describeDecisions({ ban: 0, captcha: 0, other: 0 })).toBeNull()
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
