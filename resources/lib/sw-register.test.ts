import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getReloadNoticeState, resetReloadNoticeForTests } from "./reload-notice"
import { onServiceWorkerUpdate, resetServiceWorkerUpdateForTests, swRegisterOptions } from "./sw-register"

beforeEach(() => {
  resetReloadNoticeForTests()
  resetServiceWorkerUpdateForTests()
  vi.stubGlobal("window", { location: { reload: vi.fn() } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("swRegisterOptions", () => {
  it("registers at once and takes over the plugin's reload", () => {
    const registerOptions = swRegisterOptions()
    expect(registerOptions.immediate).toBe(true)
    expect(typeof registerOptions.onNeedReload).toBe("function")
  })

  it("asks for a build comparison instead of reloading or marking an update", () => {
    const updateListener = vi.fn()
    onServiceWorkerUpdate(updateListener)
    swRegisterOptions().onNeedReload?.()
    expect(updateListener).toHaveBeenCalledTimes(1)
    expect(getReloadNoticeState().pending).toBe(false)
    expect(window.location.reload).not.toHaveBeenCalled()
  })

  it("hands an update seen before anyone listened to the first listener, once", () => {
    swRegisterOptions().onNeedReload?.()
    const firstListener = vi.fn()
    onServiceWorkerUpdate(firstListener)
    expect(firstListener).toHaveBeenCalledTimes(1)

    const secondListener = vi.fn()
    onServiceWorkerUpdate(secondListener)
    expect(secondListener).not.toHaveBeenCalled()
  })

  it("stops calling a listener once it unsubscribes", () => {
    const updateListener = vi.fn()
    const unsubscribe = onServiceWorkerUpdate(updateListener)
    unsubscribe()
    swRegisterOptions().onNeedReload?.()
    expect(updateListener).not.toHaveBeenCalled()

    const laterListener = vi.fn()
    onServiceWorkerUpdate(laterListener)
    expect(laterListener).toHaveBeenCalledTimes(1)
  })
})
