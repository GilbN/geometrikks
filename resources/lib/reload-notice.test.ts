import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  claimReloadToast,
  closeReloadToast,
  getReloadNoticeState,
  markUpdatePending,
  nameUpdateVersion,
  reloadNoticeTitle,
  reloadNoticeTooltip,
  reloadToastMessage,
  resetReloadNoticeForTests,
  subscribeReloadNotice,
} from "./reload-notice"

beforeEach(() => {
  resetReloadNoticeForTests()
})

describe("markUpdatePending", () => {
  it("returns true only on the call that turned it pending, and never erases a known version", () => {
    expect(markUpdatePending(null)).toBe(true)
    expect(getReloadNoticeState()).toMatchObject({ pending: true, version: null })

    expect(markUpdatePending("0.23.0")).toBe(false)
    expect(getReloadNoticeState().version).toBe("0.23.0")

    expect(markUpdatePending(null)).toBe(false)
    expect(getReloadNoticeState().version).toBe("0.23.0")
  })
})

describe("nameUpdateVersion", () => {
  it("is ignored before an update is pending", () => {
    nameUpdateVersion("0.23.0")
    expect(getReloadNoticeState().version).toBeNull()
  })

  it("names the version while pending", () => {
    markUpdatePending(null)
    nameUpdateVersion("0.23.0")
    expect(getReloadNoticeState().version).toBe("0.23.0")
  })
})

describe("claimReloadToast", () => {
  it("claims once per page life and only while pending", () => {
    expect(claimReloadToast()).toBe(false)
    markUpdatePending(null)
    expect(claimReloadToast()).toBe(true)
    expect(getReloadNoticeState().toastOpen).toBe(true)
    expect(claimReloadToast()).toBe(false)
    closeReloadToast()
    expect(getReloadNoticeState().toastOpen).toBe(false)
    expect(claimReloadToast()).toBe(false)
  })
})

describe("subscribeReloadNotice", () => {
  it("notifies on each change and stops after unsubscribing", () => {
    const listener = vi.fn()
    const unsubscribe = subscribeReloadNotice(listener)
    markUpdatePending(null)
    nameUpdateVersion("0.23.0")
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    closeReloadToast()
    markUpdatePending("0.24.0")
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe("copy", () => {
  it("names the version when it is known", () => {
    expect(reloadNoticeTitle("0.23.0")).toBe("v0.23.0 ready")
    expect(reloadNoticeTitle("0.23.0.dev2")).toBe("v0.23.0-dev.2 ready")
    expect(reloadNoticeTooltip("0.23.0")).toBe("v0.23.0 ready, click to reload")
    expect(reloadToastMessage("0.23.0")).toBe("Updated to v0.23.0. Reload to use it.")
  })

  it("stays generic before a version is known", () => {
    expect(reloadNoticeTitle(null)).toBe("A new version is ready")
    expect(reloadNoticeTooltip(null)).toBe("A new version is ready, click to reload")
    expect(reloadToastMessage(null)).toBe("A new version is ready. Reload to use it.")
  })
})
