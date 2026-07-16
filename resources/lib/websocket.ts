/**
 * Reconnecting WebSocket client for /ws/live.
 * Exponential backoff (1s -> 30s cap, reset on successful open).
 * The connection is lazy: first onEvents subscriber connects, last one disconnects.
 */

export type LiveEvent =
  | { type: "geo_event"; data: { timestamp: string; ip_address: string; latitude: number; longitude: number; city: string | null; country_code: string | null } }
  | {
      type: "access_log"
      data: {
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
        request_time: number
        upstream_response_time: number | null
        host: string | null
        country_code: string | null
        country_name: string | null
        city: string | null
      }
    }

interface BatchFrame {
  type: "batch"
  events: LiveEvent[]
  dropped: number
}

export type LiveFeedStatus = "connecting" | "connected" | "disconnected"

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
    this.setStatus("disconnected")
  }

  private open(): void {
    this.setStatus("connecting")
    this.ws = new WebSocket(this.url())
    this.ws.onopen = () => {
      this.backoffMs = 1000
      this.setStatus("connected")
    }
    this.ws.onmessage = (msg) => {
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
        this.eventsListeners.forEach((cb) => cb(frame.events, frame.dropped))
      }
    }
    this.ws.onclose = () => {
      this.setStatus("disconnected")
      if (this.shouldRun) {
        this.reconnectTimer = setTimeout(() => this.open(), this.backoffMs)
        this.backoffMs = Math.min(this.backoffMs * 2, 30000)
      }
    }
    this.ws.onerror = () => this.ws?.close()
  }

  private setStatus(status: LiveFeedStatus): void {
    this.status = status
    this.statusListeners.forEach((cb) => cb(status))
  }
}

export const liveFeed = new LiveFeedClient()
