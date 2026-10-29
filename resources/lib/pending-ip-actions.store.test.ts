import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const banIp = vi.fn(async () => {})
const unbanIp = vi.fn(async () => ({ deleted: 1 }))
vi.mock("@/lib/api", () => ({ banIp: (...args: unknown[]) => banIp(...(args as [])), unbanIp: (...args: unknown[]) => unbanIp(...(args as [])) }))
vi.mock("sonner", () => {
  const toast = Object.assign(vi.fn(), { dismiss: vi.fn(), success: vi.fn(), error: vi.fn() })
  return { toast }
})
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: async () => {}, isFetching: () => 0, getQueryCache: () => ({ findAll: () => [] }) }) }))
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useCallback: <T,>(fn: T) => fn }))

const { useIpActions, undoIpAction, flushIpActions, UNDO_WINDOW_MS } = await import("./pending-ip-actions")

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal("window", { setTimeout, clearTimeout, addEventListener: () => {}, matchMedia: () => ({ matches: false }), location: { pathname: "/" } })
  vi.stubGlobal("document", { addEventListener: () => {}, visibilityState: "visible" })
  banIp.mockClear()
  unbanIp.mockClear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("pending IP actions", () => {
  it("sends a ban when the undo window ends", async () => {
    useIpActions().ban("192.0.2.1", "4h", "4 hours")
    expect(banIp).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS)
    expect(banIp).toHaveBeenCalledWith({ ip: "192.0.2.1", duration: "4h" })
  })

  it("sends nothing after Undo", async () => {
    useIpActions().unban("192.0.2.2")
    undoIpAction("192.0.2.2")
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS)
    expect(unbanIp).not.toHaveBeenCalled()
  })

  it("replaces a waiting action on the same IP with the newer one", async () => {
    const actions = useIpActions()
    actions.ban("192.0.2.3", "4h", "4 hours")
    actions.unban("192.0.2.3")
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS)
    expect(banIp).not.toHaveBeenCalled()
    expect(unbanIp).toHaveBeenCalledTimes(1)
  })

  it("sends everything waiting at once on flush, and only once", async () => {
    useIpActions().ban("192.0.2.4", "1h", "1 hour")
    await flushIpActions()
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS)
    expect(banIp).toHaveBeenCalledTimes(1)
  })
})
