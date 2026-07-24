/**
 * Reconnecting WebSocket client for /ws/logs.
 * Same lazy-connect/backoff contract as LiveFeedClient (see websocket.ts).
 */

export interface LogRecord {
  timestamp?: string
  level?: string
  logger?: string
  event?: string
  exception?: string
  [key: string]: unknown
}

interface LogBatchFrame {
  type: "log_batch"
  records: LogRecord[]
  dropped: number
}

export type LogStreamStatus = "connecting" | "connected" | "disconnected"

type RecordsListener = (records: LogRecord[], dropped: number) => void
type StatusListener = (status: LogStreamStatus) => void

export class LogStreamClient {
  private ws: WebSocket | null = null
  private recordsListeners = new Set<RecordsListener>()
  private statusListeners = new Set<StatusListener>()
  private status: LogStreamStatus = "disconnected"
  private backoffMs = 1000
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private shouldRun = false

  private url(): string {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
    return `${proto}//${window.location.host}/ws/logs`
  }

  onRecords(cb: RecordsListener): () => void {
    this.recordsListeners.add(cb)
    if (this.recordsListeners.size === 1) this.connect()
    return () => {
      this.recordsListeners.delete(cb)
      if (this.recordsListeners.size === 0) this.disconnect()
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
    // Every callback checks `this.ws === ws` so a superseded socket (closed
    // by disconnect() while its close handshake was still in flight) can
    // neither deliver frames nor schedule a reconnect. Without the guard, a
    // quick disconnect/connect cycle (StrictMode remount, page revisit)
    // leaks a second live socket and every record is delivered twice.
    const ws = new WebSocket(this.url())
    this.ws = ws
    ws.onopen = () => {
      if (this.ws === ws) this.setStatus("connected")
    }
    ws.onmessage = (msg) => {
      if (this.ws !== ws) return
      if (typeof msg.data !== "string") return
      let frame: LogBatchFrame
      try {
        frame = JSON.parse(msg.data) as LogBatchFrame
      } catch {
        return
      }
      if (frame.type === "log_batch") {
        this.backoffMs = 1000
        if (frame.records.length || frame.dropped) {
          this.recordsListeners.forEach((cb) => cb(frame.records, frame.dropped))
        }
      }
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.setStatus("disconnected")
      if (this.shouldRun) {
        this.reconnectTimer = setTimeout(() => this.open(), this.backoffMs)
        this.backoffMs = Math.min(this.backoffMs * 2, 30000)
      }
    }
    ws.onerror = () => ws.close()
  }

  private setStatus(status: LogStreamStatus): void {
    this.status = status
    this.statusListeners.forEach((cb) => cb(status))
  }
}

export const logStream = new LogStreamClient()
