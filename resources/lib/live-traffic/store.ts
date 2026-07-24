/**
 * In-memory store for the live traffic stream.
 *
 * Deliberately framework-free: every hot-path consumer (the map's rAF loop)
 * reads it imperatively, and React sees only throttled snapshots. Buckets and
 * vitals are derived on read, at 1 Hz over at most MAX_REQUESTS records.
 */
import { worseStatus } from "./classify"
import type { LiveRequest, SecondBucket, StatusClass, Vitals } from "./types"

export const WINDOW_SECONDS = 300
export const MAX_REQUESTS = 2000
export const SPARKLINE_SECONDS = 60

type RequestsListener = (requests: LiveRequest[]) => void

export class LiveTrafficStore {
  /** Newest first. */
  private requests: LiveRequest[] = []
  private byId = new Map<string, LiveRequest>()
  private listeners = new Set<RequestsListener>()
  private droppedTotal = 0
  private readonly maxRequests: number
  private readonly windowSeconds: number

  constructor(options: { maxRequests?: number; windowSeconds?: number } = {}) {
    this.maxRequests = options.maxRequests ?? MAX_REQUESTS
    this.windowSeconds = options.windowSeconds ?? WINDOW_SECONDS
  }

  ingest(requests: LiveRequest[], dropped: number, now: number): void {
    this.droppedTotal += dropped
    if (requests.length > 0) {
      // Newest first, so a batch is reversed before it is prepended.
      this.requests = [...[...requests].reverse(), ...this.requests]
      for (const request of requests) this.byId.set(request.id, request)
    }
    this.evict(now)
    if (requests.length > 0) {
      this.listeners.forEach((listener) => listener(requests))
    }
  }

  private evict(now: number): void {
    const cutoff = now - this.windowSeconds * 1000
    let end = this.requests.length
    while (end > 0 && this.requests[end - 1].receivedAt < cutoff) end -= 1
    if (end > this.maxRequests) end = this.maxRequests
    if (end === this.requests.length) return

    for (const request of this.requests.slice(end)) this.byId.delete(request.id)
    this.requests = this.requests.slice(0, end)
  }

  /**
   * Push a request at the subscribers again without storing it. The timeline
   * replays an arc this way; re-ingesting would double-count it in the vitals
   * and buckets, so the same second would grow every time you clicked it.
   */
  replay(request: LiveRequest): void {
    this.listeners.forEach((listener) => listener([request]))
  }

  getRequests(): readonly LiveRequest[] {
    return this.requests
  }

  getRequest(id: string): LiveRequest | undefined {
    return this.byId.get(id)
  }

  onRequests(callback: RequestsListener): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  getBuckets(now: number): SecondBucket[] {
    this.evict(now)
    const newest = Math.floor(now / 1000)
    const oldest = newest - (this.windowSeconds - 1)
    const buckets: SecondBucket[] = []
    for (let second = oldest; second <= newest; second += 1) {
      buckets.push({ second, total: 0, threats: 0, banned: 0, worstStatus: "unknown", requestIds: [] })
    }

    for (const request of this.requests) {
      const index = Math.floor(request.receivedAt / 1000) - oldest
      if (index < 0 || index >= buckets.length) continue
      const bucket = buckets[index]
      bucket.total += 1
      if (request.threat) bucket.threats += 1
      if (request.banned) bucket.banned += 1
      bucket.worstStatus = worseStatus(bucket.worstStatus, request.statusClass)
      bucket.requestIds.push(request.id)
    }

    return buckets
  }

  getVitals(now: number): Vitals {
    this.evict(now)
    const ips = new Set<string>()
    const countries = new Set<string>()
    let threatCount = 0
    let serverErrors = 0
    let rpm = 0
    const rpmCutoff = now - 60_000

    for (const request of this.requests) {
      if (request.ip) ips.add(request.ip)
      if (request.countryCode) countries.add(request.countryCode)
      if (request.threat) threatCount += 1
      if (request.statusClass === "5xx") serverErrors += 1
      if (request.receivedAt >= rpmCutoff) rpm += 1
    }

    const buckets = this.getBuckets(now)
    return {
      rpm,
      errorRate: this.requests.length === 0 ? 0 : serverErrors / this.requests.length,
      threatCount,
      uniqueIps: ips.size,
      countries: countries.size,
      dropped: this.droppedTotal,
      sparkline: buckets.slice(-SPARKLINE_SECONDS).map((bucket) => bucket.total),
    }
  }

  clear(): void {
    this.requests = []
    this.byId.clear()
    this.droppedTotal = 0
  }
}

export type { StatusClass }
