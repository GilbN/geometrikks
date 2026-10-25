import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getReloadNoticeState, resetReloadNoticeForTests } from "./reload-notice"
import { swRegisterOptions } from "./sw-register"

beforeEach(() => {
  resetReloadNoticeForTests()
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

  it("marks the update pending instead of reloading", () => {
    swRegisterOptions().onNeedReload?.()
    expect(getReloadNoticeState()).toMatchObject({ pending: true, version: null })
    expect(window.location.reload).not.toHaveBeenCalled()
  })
})
