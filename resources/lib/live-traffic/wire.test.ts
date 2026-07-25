import { describe, expect, it } from "vitest"
import { binBuckets, binSecondsFor, notableRequest, resolveHoveredBin } from "./wire"
import type { LiveRequest, SecondBucket, StatusClass } from "./types"

function bucket(second: number, overrides: Partial<SecondBucket> = {}): SecondBucket {
  return {
    second,
    total: 0,
    threats: 0,
    banned: 0,
    worstStatus: "unknown",
    requestIds: [],
    ...overrides,
  }
}

function request(id: string, overrides: Partial<LiveRequest> = {}): LiveRequest {
  return {
    id,
    timestamp: "2026-07-25T00:00:00Z",
    receivedAt: 0,
    ip: "1.1.1.1",
    coordinates: [10, 59],
    city: null,
    countryCode: null,
    log: null,
    statusClass: "2xx",
    banned: false,
    threat: false,
    ...overrides,
  }
}

describe("binSecondsFor", () => {
  it("keeps one-second bins when the canvas is wide enough", () => {
    // 3000px / 5px columns = 600 columns for 300 seconds.
    expect(binSecondsFor(3000, 300)).toBe(1)
  })

  it("widens bins so every column is at least five pixels", () => {
    // 700px -> 140 columns -> 3 seconds per bin.
    expect(binSecondsFor(700, 300)).toBe(3)
  })

  it("collapses to one full-window bin when there is no room at all", () => {
    expect(binSecondsFor(0, 300)).toBe(300)
    expect(binSecondsFor(3, 300)).toBe(300)
  })
})

describe("binBuckets", () => {
  it("returns nothing for no buckets", () => {
    expect(binBuckets([], 3)).toEqual([])
  })

  it("is the identity at one second per bin", () => {
    const buckets = [bucket(100, { total: 1 }), bucket(101, { total: 2 })]
    const bins = binBuckets(buckets, 1)

    expect(bins).toHaveLength(2)
    expect(bins[0]).toMatchObject({ startSecond: 100, seconds: 1, total: 1 })
    expect(bins[1]).toMatchObject({ startSecond: 101, seconds: 1, total: 2 })
  })

  it("sums counts and folds the worst status across a bin", () => {
    const buckets = [
      bucket(100, { total: 2, threats: 1, worstStatus: "2xx" as StatusClass }),
      bucket(101, { total: 3, banned: 1, worstStatus: "5xx" as StatusClass }),
      bucket(102, { total: 1, worstStatus: "4xx" as StatusClass }),
    ]
    const [bin] = binBuckets(buckets, 3)

    expect(bin).toMatchObject({
      startSecond: 100,
      seconds: 3,
      total: 6,
      threats: 1,
      banned: 1,
      worstStatus: "5xx",
    })
  })

  it("keeps the newest bin full and puts the partial bin at the old edge", () => {
    const buckets = [bucket(100), bucket(101), bucket(102), bucket(103), bucket(104)]
    const bins = binBuckets(buckets, 3)

    expect(bins.map((b) => [b.startSecond, b.seconds])).toEqual([
      [100, 2],
      [102, 3],
    ])
  })

  it("orders a bin's request ids newest first across its seconds", () => {
    const buckets = [
      bucket(100, { total: 1, requestIds: ["old"] }),
      bucket(101, { total: 2, requestIds: ["newer-b", "newer-a"] }),
    ]
    const [bin] = binBuckets(buckets, 2)

    expect(bin.requestIds).toEqual(["newer-b", "newer-a", "old"])
  })
})

describe("resolveHoveredBin", () => {
  it("returns null when nothing is hovered", () => {
    expect(resolveHoveredBin(binBuckets([bucket(100)], 1), null)).toBeNull()
  })

  it("stays on the same stretch of time after the window shifts", () => {
    const before = binBuckets([bucket(100), bucket(101), bucket(102), bucket(103)], 2)
    const hoveredStart = before[1].startSecond // seconds 102-103

    const after = binBuckets([bucket(102), bucket(103), bucket(104), bucket(105)], 2)
    expect(resolveHoveredBin(after, hoveredStart)).toBe(0)
  })

  it("returns null once the hovered bin has scrolled off the left edge", () => {
    const bins = binBuckets([bucket(104), bucket(105)], 2)
    expect(resolveHoveredBin(bins, 100)).toBeNull()
  })

  it("keeps the highlight while bin boundaries shift under the cursor", () => {
    // The window holds a fixed number of seconds, so every tick shifts the
    // bin boundaries by one second. The second under the cursor must resolve
    // by containment or the hover dies within a second of the mouse resting.
    const tick = binBuckets([bucket(100), bucket(101), bucket(102), bucket(103), bucket(104), bucket(105)], 2)
    expect(resolveHoveredBin(tick, 103)).toBe(1)

    const nextTick = binBuckets([bucket(101), bucket(102), bucket(103), bucket(104), bucket(105), bucket(106)], 2)
    expect(resolveHoveredBin(nextTick, 103)).toBe(1)
  })
})

describe("notableRequest", () => {
  const lookup = (requests: LiveRequest[]) => (id: string) =>
    requests.find((r) => r.id === id)

  it("prefers banned over 4xx over 5xx", () => {
    const requests = [
      request("err", { statusClass: "5xx" }),
      request("probe", { statusClass: "4xx", threat: true }),
      request("caged", { banned: true, threat: true }),
    ]
    const bin = { requestIds: ["err", "probe", "caged"] }

    expect(notableRequest(bin, lookup(requests))?.id).toBe("caged")
  })

  it("falls back to the newest request, which is first in the list", () => {
    const requests = [request("newest"), request("oldest")]
    const bin = { requestIds: ["newest", "oldest"] }

    expect(notableRequest(bin, lookup(requests))?.id).toBe("newest")
  })

  it("skips ids already evicted from the buffer", () => {
    const requests = [request("kept")]
    const bin = { requestIds: ["evicted", "kept"] }

    expect(notableRequest(bin, lookup(requests))?.id).toBe("kept")
  })

  it("returns undefined for an empty bin", () => {
    expect(notableRequest({ requestIds: [] }, () => undefined)).toBeUndefined()
  })
})
