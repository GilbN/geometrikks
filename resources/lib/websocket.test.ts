import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CLOSE_TRY_AGAIN_LATER, LiveFeedClient, type LiveFeedStatus } from "./websocket"

class FakeSocket {
  static instances: FakeSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((msg: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(public url: string) {
    FakeSocket.instances.push(this)
  }

  close(): void {
    this.onclose?.({ code: 1000 })
  }
}

describe("LiveFeedClient close handling", () => {
  let clients: LiveFeedClient[]
  let statuses: LiveFeedStatus[]

  beforeEach(() => {
    vi.useFakeTimers()
    FakeSocket.instances = []
    vi.stubGlobal("WebSocket", FakeSocket)
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "localhost" },
    })
    clients = []
    statuses = []
  })

  afterEach(() => {
    clients.forEach((client) => client.disconnect())
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function makeClient(): LiveFeedClient {
    const client = new LiveFeedClient()
    clients.push(client)
    client.onStatus((status) => statuses.push(status))
    client.onEvents(() => {})
    return client
  }

  it("reads a 1013 close as unavailable and retries at the 30s cap", () => {
    makeClient()

    const first = FakeSocket.instances[0]
    first.onopen?.()
    first.onclose?.({ code: CLOSE_TRY_AGAIN_LATER })
    expect(statuses.at(-1)).toBe("unavailable")

    vi.advanceTimersByTime(29_000)
    expect(FakeSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1_000)
    expect(FakeSocket.instances).toHaveLength(2)
    FakeSocket.instances[1].onopen?.()
    expect(statuses.at(-1)).toBe("unavailable")
  })

  it("returns to connected on the first valid frame after a pause", () => {
    makeClient()

    const first = FakeSocket.instances[0]
    first.onclose?.({ code: CLOSE_TRY_AGAIN_LATER })
    vi.advanceTimersByTime(30_000)
    const second = FakeSocket.instances[1]
    second.onopen?.()
    second.onmessage?.({
      data: JSON.stringify({ type: "batch", events: [], dropped: 0 }),
    })

    expect(statuses.at(-1)).toBe("connected")
  })

  it("keeps exponential backoff for ordinary closes", () => {
    makeClient()

    FakeSocket.instances[0].onclose?.({ code: 1006 })
    expect(statuses.at(-1)).toBe("disconnected")
    vi.advanceTimersByTime(999)
    expect(FakeSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it("ignores a superseded socket close", () => {
    const client = makeClient()
    const first = FakeSocket.instances[0]

    client.disconnect()
    client.connect()
    first.onclose?.({ code: CLOSE_TRY_AGAIN_LATER })

    expect(statuses.at(-1)).toBe("connecting")
    vi.advanceTimersByTime(30_000)
    expect(FakeSocket.instances).toHaveLength(2)
  })
})
