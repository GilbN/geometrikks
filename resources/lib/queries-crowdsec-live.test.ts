import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CLOSE_TRY_AGAIN_LATER } from "./websocket"

const mocks = vi.hoisted(() => ({
  cleanup: undefined as (() => void) | undefined,
  queryClient: {
    getQueryData: vi.fn(),
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
  },
}))

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => {
    mocks.cleanup = effect() ?? undefined
  },
}))

vi.mock("@tanstack/react-query", () => ({
  useMutation: vi.fn(),
  useQuery: () => ({ data: { enabled: true } }),
  useQueryClient: () => mocks.queryClient,
}))

import { useCrowdsecLiveUpdates } from "./queries"

class FakeSocket {
  static instances: FakeSocket[] = []
  onmessage: ((msg: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null

  constructor(public url: string) {
    FakeSocket.instances.push(this)
  }

  close(): void {
    this.onclose?.({ code: 1000 })
  }
}

describe("useCrowdsecLiveUpdates close handling", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    FakeSocket.instances = []
    mocks.cleanup = undefined
    vi.stubGlobal("WebSocket", FakeSocket)
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "localhost" },
    })
  })

  afterEach(() => {
    mocks.cleanup?.()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("retries a 1013 close at the 30s cap", () => {
    useCrowdsecLiveUpdates()

    FakeSocket.instances[0].onclose?.({ code: CLOSE_TRY_AGAIN_LATER })
    vi.advanceTimersByTime(29_000)
    expect(FakeSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1_000)
    expect(FakeSocket.instances).toHaveLength(2)
  })
  it("coalesces decision bursts into authoritative map and popup refreshes", () => {
    useCrowdsecLiveUpdates()
    const socket = FakeSocket.instances[0]
    const frame = JSON.stringify({ type: "crowdsec_decisions", added: [], deleted: [{ ip: "192.0.2.1", origin: "cscli" }] })
    socket.onmessage?.({ data: frame })
    socket.onmessage?.({ data: frame })
    expect(mocks.queryClient.invalidateQueries).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledTimes(2)
    expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["crowdsec", "banned-locations"] })
    expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["crowdsec", "lookup"] })
  })

  it("cancels a pending refresh on unmount", () => {
    useCrowdsecLiveUpdates()
    FakeSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: "crowdsec_decisions", added: [], deleted: [] }) })
    mocks.cleanup?.()
    vi.advanceTimersByTime(500)
    expect(mocks.queryClient.invalidateQueries).not.toHaveBeenCalled()
  })

})
