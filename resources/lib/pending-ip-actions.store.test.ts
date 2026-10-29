import type { ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const banIp = vi.fn(async () => {})
const unbanIp = vi.fn(async () => ({ deleted: 1 }))
vi.mock("@/lib/api", () => ({ banIp: (...args: unknown[]) => banIp(...(args as [])), unbanIp: (...args: unknown[]) => unbanIp(...(args as [])) }))
vi.mock("sonner", () => {
  const toast = Object.assign(vi.fn(), { custom: vi.fn(), dismiss: vi.fn(), success: vi.fn(), error: vi.fn() })
  return { toast }
})
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: async () => {}, isFetching: () => 0, getQueryCache: () => ({ findAll: () => [] }) }) }))
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useCallback: <T,>(fn: T) => fn }))

const { toast } = await import("sonner")
const { useIpActions, undoIpAction, flushIpActions, UNDO_WINDOW_MS } = await import("./pending-ip-actions")

type CustomToast = [render: (id: string | number) => ReactElement, options: { id: string; duration: number; dismissible: boolean }]

function lastCustomToast(): CustomToast {
  return vi.mocked(toast.custom).mock.lastCall as unknown as CustomToast
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal("window", { setTimeout, clearTimeout, addEventListener: () => {}, matchMedia: () => ({ matches: false }), location: { pathname: "/" } })
  vi.stubGlobal("document", { addEventListener: () => {}, visibilityState: "visible" })
  banIp.mockClear()
  unbanIp.mockClear()
  vi.mocked(toast.custom).mockClear()
  vi.mocked(toast.dismiss).mockClear()
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

  it("shows the waiting ban in a toast that stays until the store sends or undoes it", async () => {
    useIpActions().ban("192.0.2.5", "4h", "4 hours")
    const [render, options] = lastCustomToast()
    expect(options).toMatchObject({ duration: Number.POSITIVE_INFINITY, dismissible: false })
    const markup = renderToStaticMarkup(render(options.id))
    expect(markup).toContain("192.0.2.5")
    expect(markup).toContain(" for 4 hours")
    expect(markup).toContain("Sent to CrowdSec in 5 seconds.")
    expect(markup).toContain("Undo")
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS)
    expect(toast.dismiss).toHaveBeenCalledWith(options.id)
  })

  it("gives every scheduled action its own toast id", () => {
    const actions = useIpActions()
    actions.unban("192.0.2.6")
    const [, first] = lastCustomToast()
    actions.unban("192.0.2.6")
    const [, second] = lastCustomToast()
    expect(second.id).not.toBe(first.id)
    expect(toast.dismiss).toHaveBeenCalledWith(first.id)
    undoIpAction("192.0.2.6")
    expect(toast.dismiss).toHaveBeenLastCalledWith(second.id)
  })
})
