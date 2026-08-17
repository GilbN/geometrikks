import { describe, expect, it, vi } from "vitest"
import { LiveTrafficStore, RECENT_DROP_MS } from "./store"
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
    hostname: null,
    ...overrides,
  }
}

describe("LiveTrafficStore", () => {
  it("keeps ingested requests newest first", () => {
    const store = new LiveTrafficStore()
    store.ingest([request({ id: "a", receivedAt: 1000 })], 0, 1000)
    store.ingest([request({ id: "b", receivedAt: 2000 })], 0, 2000)

    expect(store.getRequests().map((r) => r.id)).toEqual(["b", "a"])
  })

  it("evicts requests older than the window", () => {
    const store = new LiveTrafficStore()
    store.ingest([request({ id: "old", receivedAt: 0 })], 0, 0)
    store.ingest([request({ id: "new", receivedAt: 400_000 })], 0, 400_000)

    expect(store.getRequests().map((r) => r.id)).toEqual(["new"])
  })

  it("caps the buffer by count", () => {
    const store = new LiveTrafficStore({ maxRequests: 3 })
    for (let i = 0; i < 10; i += 1) {
      store.ingest([request({ id: `r${i}`, receivedAt: 1000 })], 0, 1000)
    }

    expect(store.getRequests()).toHaveLength(3)
    expect(store.getRequests()[0].id).toBe("r9")
  })

  it("looks a request up by id", () => {
    const store = new LiveTrafficStore()
    store.ingest([request({ id: "wanted", receivedAt: 1000 })], 0, 1000)

    expect(store.getRequest("wanted")?.id).toBe("wanted")
    expect(store.getRequest("missing")).toBeUndefined()
  })

  it("notifies subscribers once per ingest and stops after unsubscribe", () => {
    const store = new LiveTrafficStore()
    const seen = vi.fn()
    const unsubscribe = store.onRequests(seen)

    store.ingest([request({ receivedAt: 1000 })], 0, 1000)
    expect(seen).toHaveBeenCalledTimes(1)

    unsubscribe()
    store.ingest([request({ receivedAt: 1100 })], 0, 1100)
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it("does not notify for an empty batch", () => {
    const store = new LiveTrafficStore()
    const seen = vi.fn()
    store.onRequests(seen)

    store.ingest([], 0, 1000)
    expect(seen).not.toHaveBeenCalled()
  })

  it("returns one bucket per second in the window, oldest first", () => {
    const store = new LiveTrafficStore()
    const buckets = store.getBuckets(300_000)

    expect(buckets).toHaveLength(300)
    expect(buckets[0].second).toBe(buckets[299].second - 299)
    expect(buckets[299].total).toBe(0)
  })

  it("buckets requests by the second they arrived", () => {
    const store = new LiveTrafficStore()
    store.ingest(
      [
        request({ receivedAt: 300_000 }),
        request({ receivedAt: 300_500 }),
        request({ receivedAt: 299_000, statusClass: "4xx", threat: true }),
      ],
      0,
      300_500,
    )
    const buckets = store.getBuckets(300_500)

    expect(buckets[299].total).toBe(2)
    expect(buckets[298].total).toBe(1)
    expect(buckets[298].threats).toBe(1)
  })

  it("orders a bucket's requestIds newest first, matching getRequests()", () => {
    const store = new LiveTrafficStore()
    // Three batches landing in the same second, each later than the last.
    // A batch itself arrives oldest-event-first, so within the "third" batch
    // "third-b" is the newer of the two.
    store.ingest([request({ id: "first", receivedAt: 300_000 })], 0, 300_000)
    store.ingest([request({ id: "second", receivedAt: 300_400 })], 0, 300_400)
    store.ingest(
      [request({ id: "third-a", receivedAt: 300_600 }), request({ id: "third-b", receivedAt: 300_600 })],
      0,
      300_600,
    )

    const bucket = store.getBuckets(300_600)[299]

    expect(bucket.requestIds).toEqual(store.getRequests().map((r) => r.id))
    expect(bucket.requestIds).toEqual(["third-b", "third-a", "second", "first"])
  })

  it("colours a bucket by its worst status and counts banned separately", () => {
    const store = new LiveTrafficStore()
    store.ingest(
      [
        request({ receivedAt: 300_000, statusClass: "2xx" }),
        request({ receivedAt: 300_000, statusClass: "5xx" }),
        request({ receivedAt: 300_000, statusClass: "2xx", banned: true, threat: true }),
      ],
      0,
      300_000,
    )
    const bucket = store.getBuckets(300_000)[299]

    expect(bucket.worstStatus).toBe("5xx")
    expect(bucket.banned).toBe(1)
    expect(bucket.threats).toBe(1)
  })

  it("computes vitals over the window", () => {
    const store = new LiveTrafficStore()
    store.ingest(
      [
        request({ receivedAt: 300_000, ip: "1.1.1.1", countryCode: "NO" }),
        request({ receivedAt: 300_000, ip: "2.2.2.2", countryCode: "SE", statusClass: "5xx" }),
        request({
          receivedAt: 300_000,
          ip: "2.2.2.2",
          countryCode: "SE",
          statusClass: "4xx",
          threat: true,
        }),
        request({ receivedAt: 300_000, ip: "3.3.3.3", countryCode: null }),
      ],
      7,
      300_000,
    )
    const vitals = store.getVitals(300_000)

    expect(vitals.rpm).toBe(4)
    expect(vitals.errorRate).toBeCloseTo(0.25)
    expect(vitals.threatCount).toBe(1)
    expect(vitals.uniqueIps).toBe(3)
    expect(vitals.countries).toBe(2)
    expect(vitals.dropped).toBe(7)
    expect(vitals.sparkline).toHaveLength(60)
    expect(vitals.sparkline[59]).toBe(4)
  })

  it("counts rpm over the last 60 seconds only", () => {
    const store = new LiveTrafficStore()
    store.ingest([request({ receivedAt: 200_000 })], 0, 200_000)
    store.ingest([request({ receivedAt: 300_000 })], 0, 300_000)

    expect(store.getVitals(300_000).rpm).toBe(1)
    expect(store.getRequests()).toHaveLength(2)
  })

  it("accumulates dropped counts across batches", () => {
    const store = new LiveTrafficStore()
    store.ingest([], 3, 1000)
    store.ingest([], 4, 2000)

    expect(store.getVitals(2000).dropped).toBe(7)
  })

  it("marks a drop as recent when read immediately after the batch", () => {
    const store = new LiveTrafficStore()
    store.ingest([], 3, 1000)

    expect(store.getVitals(1000).droppedRecently).toBe(true)
  })

  it("stops marking a drop as recent once RECENT_DROP_MS has passed, while dropped keeps the total", () => {
    const store = new LiveTrafficStore()
    store.ingest([], 3, 1000)

    const vitals = store.getVitals(1000 + RECENT_DROP_MS + 1)

    expect(vitals.droppedRecently).toBe(false)
    expect(vitals.dropped).toBe(3)
  })

  it("reports droppedRecently false when nothing has ever been dropped", () => {
    const store = new LiveTrafficStore()
    store.ingest([request({ receivedAt: 1000 })], 0, 1000)

    expect(store.getVitals(1000).droppedRecently).toBe(false)
  })

  it("replays a request to subscribers without counting it as new traffic", () => {
    const store = new LiveTrafficStore()
    const seen = vi.fn()
    store.onRequests(seen)
    const replayed = request({ id: "old", receivedAt: 1000 })
    store.ingest([replayed], 0, 1000)

    store.replay(replayed)

    expect(seen).toHaveBeenCalledTimes(2)
    expect(store.getRequests()).toHaveLength(1)
    expect(store.getVitals(1000).rpm).toBe(1)
  })

  it("clears everything", () => {
    const store = new LiveTrafficStore()
    store.ingest([request({ receivedAt: 1000 })], 5, 1000)
    store.clear()

    expect(store.getRequests()).toHaveLength(0)
    const vitals = store.getVitals(1000)
    expect(vitals.dropped).toBe(0)
    expect(vitals.droppedRecently).toBe(false)
  })

  it("reset clears requests and buckets and notifies subscribers", () => {
    const store = new LiveTrafficStore()
    const seen = vi.fn()
    store.ingest([request({ id: "a", receivedAt: 1000 }), request({ id: "b", receivedAt: 1000 })], 0, 1000)
    store.onRequests(seen)

    store.reset()

    expect(store.getRequests()).toHaveLength(0)
    expect(store.getBuckets(1000).every((bucket) => bucket.total === 0)).toBe(true)
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it("prunes stale requests on read when idle for longer than the window", () => {
    const store = new LiveTrafficStore()
    store.ingest(
      [
        request({ receivedAt: 1000, ip: "1.1.1.1", countryCode: "NO" }),
        request({ receivedAt: 1000, statusClass: "5xx" }),
        request({ receivedAt: 1000, statusClass: "4xx", threat: true }),
      ],
      0,
      1000,
    )

    // Read vitals far in the future with no intervening ingest
    const now = 1000 + 301_000
    const vitals = store.getVitals(now)

    expect(vitals.uniqueIps).toBe(0)
    expect(vitals.countries).toBe(0)
    expect(vitals.threatCount).toBe(0)
    expect(vitals.errorRate).toBe(0)
    expect(vitals.rpm).toBe(0)
  })
})
