/**
 * Reconnecting WebSocket client for /ws/live.
 * Exponential backoff (1s -> 30s cap, reset on first valid frame).
 * The connection is lazy: first onEvents subscriber connects, last one disconnects.
 */

export interface GeoEventData {
  timestamp: string
  ip_address: string
  latitude: number
  longitude: number
  city: string | null
  country_code: string | null
  hostname: string
}

export interface AccessLogData {
  timestamp: string
  ip_address: string
  remote_user: string | null
  method: string | null
  url: string | null
  http_version: string | null
  status_code: number
  bytes_sent: number
  referrer: string | null
  user_agent: string | null
  request_time: number | null
  upstream_response_time: number | null
  host: string | null
  country_code: string | null
  country_name: string | null
  city: string | null
  autonomous_system_number: number | null
  autonomous_system_organization: string | null
  hostname: string
}

/**
 * One committed record: its geo view and access-log view travel in a single
 * envelope. Concurrent agent publishers interleave their NOTIFYs, so halves
 * shipped as separate events could not be re-paired on this side.
 */
export interface LiveEvent {
  type: "request"
  geo: GeoEventData | null
  log: AccessLogData | null
}

interface BatchFrame {
  type: "batch"
  events: LiveEvent[]
  dropped: number
}

export type LiveFeedStatus = "connecting" | "connected" | "disconnected" | "unavailable"

/** RFC 6455 "try again later": the server accepted the socket and closed it
 * because the service behind it is paused. */
export const CLOSE_TRY_AGAIN_LATER = 1013
const MAX_BACKOFF_MS = 30_000

type EventsListener = (events: LiveEvent[], dropped: number) => void
type StatusListener = (status: LiveFeedStatus) => void

export class LiveFeedClient {
  private ws: WebSocket | null = null
  private eventsListeners = new Set<EventsListener>()
  private statusListeners = new Set<StatusListener>()
  private status: LiveFeedStatus = "disconnected"
  private backoffMs = 1000
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private shouldRun = false
  private paused = false

  private url(): string {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
    return `${proto}//${window.location.host}/ws/live`
  }

  onEvents(cb: EventsListener): () => void {
    this.eventsListeners.add(cb)
    if (this.eventsListeners.size === 1) this.connect()
    return () => {
      this.eventsListeners.delete(cb)
      if (this.eventsListeners.size === 0) this.disconnect()
    }
  }

  onStatus(cb: StatusListener): () => void {
    this.statusListeners.add(cb)
    cb(this.status)
    return () => this.statusListeners.delete(cb)
  }

  connect(): void {
    if (this.shouldRun) return
    this.shouldRun = true
    this.open()
  }

  disconnect(): void {
    this.shouldRun = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = null
    this.paused = false
    this.setStatus("disconnected")
  }

  private open(): void {
    if (!this.paused) this.setStatus("connecting")
    // Every callback checks `this.ws === ws` so a superseded socket (closed
    // by disconnect() while its close handshake was still in flight) can
    // neither deliver frames nor schedule a reconnect. Without the guard, a
    // quick disconnect/connect cycle (StrictMode remount, page revisit)
    // leaks a second live socket and every event is delivered twice.
    const ws = new WebSocket(this.url())
    this.ws = ws
    ws.onopen = () => {
      if (this.ws === ws && !this.paused) this.setStatus("connected")
    }
    ws.onmessage = (msg) => {
      if (this.ws !== ws) return
      // The server only ever sends JSON text frames; ignore anything else
      // (a Blob/ArrayBuffer or malformed payload) rather than throwing and
      // tearing down live updates.
      if (typeof msg.data !== "string") return
      let frame: BatchFrame
      try {
        frame = JSON.parse(msg.data) as BatchFrame
      } catch {
        return
      }
      if (frame.type === "batch") {
        // Reset backoff only on a valid frame, not onopen: the server accepts
        // and immediately closes 1013 while streaming is paused, so an onopen
        // reset would pin the reconnect loop at the 1s floor.
        this.backoffMs = 1000
        if (this.paused) {
          this.paused = false
          this.setStatus("connected")
        }
        this.eventsListeners.forEach((cb) => cb(frame.events, frame.dropped))
      }
    }
    ws.onclose = (event) => {
      if (this.ws !== ws) return
      this.paused = event.code === CLOSE_TRY_AGAIN_LATER
      this.setStatus(this.paused ? "unavailable" : "disconnected")
      if (this.shouldRun) {
        if (this.paused) this.backoffMs = MAX_BACKOFF_MS
        this.reconnectTimer = setTimeout(() => this.open(), this.backoffMs)
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
      }
    }
    ws.onerror = () => ws.close()
  }

  private setStatus(status: LiveFeedStatus): void {
    this.status = status
    this.statusListeners.forEach((cb) => cb(status))
  }
}

export const liveFeed = new LiveFeedClient()
