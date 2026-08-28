import { describe, expect, it } from "vitest"
import type { IpProfileResponse } from "@/generated/api/types.gen"
import { bucketFloor, computeSignals, requestsAfter, SIGNAL_THRESHOLDS } from "./signals"

function profile(overrides: Partial<IpProfileResponse> = {}): IpProfileResponse {
  return {
    ipAddress: "1.2.3.4",
    startDate: "2026-08-28T00:00:00Z",
    endDate: "2026-08-28T12:00:00Z",
    totalRequests: 0,
    status2xx: 0,
    status3xx: 0,
    status4xx: 0,
    status5xx: 0,
    errorRate: 0,
    totalBytes: 0,
    timedRequests: 0,
    avgRequestTime: null,
    p95RequestTime: null,
    firstSeen: null,
    lastSeen: null,
    distinctPaths: 0,
    malformedRequests: 0,
    asn: null,
    asnOrganization: null,
    asnCategory: null,
    granularity: "hourly",
    series: [],
    peak: null,
    hosts: [],
    paths: [],
    userAgents: [],
    ...overrides,
  }
}

const keys = (signals: ReturnType<typeof computeSignals>) => signals.map((s) => s.key)

describe("computeSignals", () => {
  it("is empty for a quiet IP", () => {
    expect(computeSignals({ profile: profile(), banned: false, banCreatedAt: null })).toEqual([])
  })

  it("flags 4xx share only above the request floor", () => {
    const low = profile({ totalRequests: 19, status4xx: 19 })
    expect(keys(computeSignals({ profile: low, banned: false, banCreatedAt: null }))).not.toContain("errors")
    const high = profile({ totalRequests: 20, status4xx: 12 })
    const signal = computeSignals({ profile: high, banned: false, banCreatedAt: null }).find((s) => s.key === "errors")
    expect(signal).toMatchObject({ tone: "amber", label: "60% 4xx" })
    const red = profile({ totalRequests: 100, status4xx: 70 })
    expect(computeSignals({ profile: red, banned: false, banCreatedAt: null })[0]).toMatchObject({ tone: "red" })
  })

  it("flags hosting, path spread and malformed lines", () => {
    const p = profile({ asnCategory: "hosting", distinctPaths: SIGNAL_THRESHOLDS.distinctPathsMin, malformedRequests: 2 })
    expect(keys(computeSignals({ profile: p, banned: false, banCreatedAt: null }))).toEqual(["hosting", "paths", "malformed"])
  })

  it("flags a burst when one bucket holds half the traffic", () => {
    const p = profile({
      totalRequests: 100,
      peak: { timestamp: "2026-08-28T03:00:00Z", hits: 50, errorHits: 0 },
    })
    expect(keys(computeSignals({ profile: p, banned: false, banCreatedAt: null }))).toContain("burst")
    const small = profile({ totalRequests: 99, peak: { timestamp: "2026-08-28T03:00:00Z", hits: 99, errorHits: 0 } })
    expect(keys(computeSignals({ profile: small, banned: false, banCreatedAt: null }))).not.toContain("burst")
  })

  it("flags traffic after the ban only when banned with a known start", () => {
    const p = profile({
      totalRequests: 5,
      lastSeen: "2026-08-28T21:48:00Z",
      series: [
        { timestamp: "2026-08-28T13:00:00Z", hits: 3, errorHits: 0 },
        { timestamp: "2026-08-28T21:00:00Z", hits: 2, errorHits: 0 },
      ],
    })
    const after = computeSignals({ profile: p, banned: true, banCreatedAt: "2026-08-28T14:02:00Z" })
    expect(after.find((s) => s.key === "after-ban")).toMatchObject({ tone: "red", label: "Still seen 7h after ban (2 requests)" })
    expect(keys(computeSignals({ profile: p, banned: false, banCreatedAt: "2026-08-28T14:02:00Z" }))).not.toContain("after-ban")
    expect(keys(computeSignals({ profile: p, banned: true, banCreatedAt: null }))).not.toContain("after-ban")
  })

  it("drops the request count when the ban lands inside the last bucket (daily)", () => {
    const p = profile({
      granularity: "daily",
      totalRequests: 5,
      lastSeen: "2026-08-28T22:00:00Z",
      series: [{ timestamp: "2026-08-28T00:00:00Z", hits: 5, errorHits: 0 }],
    })
    const after = computeSignals({ profile: p, banned: true, banCreatedAt: "2026-08-28T10:00:00Z" })
    expect(after.find((s) => s.key === "after-ban")).toMatchObject({
      tone: "red",
      label: "Still seen 12h after ban",
    })
  })

  it("says 'under an hour' instead of 0h when the ban lands minutes before the last request", () => {
    const p = profile({
      totalRequests: 3,
      lastSeen: "2026-08-28T15:00:00Z",
      series: [{ timestamp: "2026-08-28T14:00:00Z", hits: 3, errorHits: 0 }],
    })
    const after = computeSignals({ profile: p, banned: true, banCreatedAt: "2026-08-28T14:40:00Z" })
    expect(after.find((s) => s.key === "after-ban")).toMatchObject({
      tone: "red",
      label: "Still seen under an hour after ban",
    })
  })
})

describe("requestsAfter", () => {
  it("sums buckets that start after the instant", () => {
    const series = [
      { timestamp: "2026-08-28T13:00:00Z", hits: 3, errorHits: 0 },
      { timestamp: "2026-08-28T14:00:00Z", hits: 4, errorHits: 0 },
      { timestamp: "2026-08-28T15:00:00Z", hits: 5, errorHits: 0 },
    ]
    expect(requestsAfter(series, "2026-08-28T14:02:00Z")).toBe(5)
    expect(requestsAfter(series, "2026-08-28T12:00:00Z")).toBe(12)
  })
})

describe("bucketFloor", () => {
  it("floors to the hour or the UTC day", () => {
    expect(bucketFloor("2026-08-28T14:02:33Z", "hourly")).toBe("2026-08-28T14:00:00.000Z")
    expect(bucketFloor("2026-08-28T14:02:33Z", "daily")).toBe("2026-08-28T00:00:00.000Z")
  })
})
