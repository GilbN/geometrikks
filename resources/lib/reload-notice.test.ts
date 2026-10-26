import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  claimReloadToast,
  closeReloadToast,
  getReloadNoticeState,
  markUpdatePending,
  nameUpdateVersion,
  reloadNoticeTitle,
  reloadNoticeTooltip,
  reloadToastTitle,
  resetReloadNoticeForTests,
  subscribeReloadNotice,
} from "./reload-notice"

beforeEach(() => {
  resetReloadNoticeForTests()
})

describe("markUpdatePending", () => {
  it("returns true only on the call that turned it pending, and keeps the latest version", () => {
    expect(markUpdatePending("0.23.0")).toBe(true)
    expect(getReloadNoticeState()).toMatchObject({ pending: true, version: "0.23.0" })

    expect(markUpdatePending("0.24.0")).toBe(false)
    expect(getReloadNoticeState().version).toBe("0.24.0")
  })
})

describe("nameUpdateVersion", () => {
  it("is ignored before an update is pending", () => {
    nameUpdateVersion("0.23.0")
    expect(getReloadNoticeState().version).toBeNull()
  })

  it("names the newer version while pending", () => {
    markUpdatePending("0.23.0")
    nameUpdateVersion("0.24.0")
    expect(getReloadNoticeState().version).toBe("0.24.0")
  })
})

describe("claimReloadToast", () => {
  it("claims once per page life and only while pending", () => {
    expect(claimReloadToast()).toBe(false)
    markUpdatePending("0.23.0")
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
    markUpdatePending("0.23.0")
    nameUpdateVersion("0.24.0")
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    closeReloadToast()
    markUpdatePending("0.25.0")
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe("copy", () => {
  it("names the version", () => {
    expect(reloadNoticeTitle("0.23.0")).toBe("v0.23.0 ready")
    expect(reloadNoticeTitle("0.23.0.dev2")).toBe("v0.23.0-dev.2 ready")
    expect(reloadNoticeTooltip("0.23.0")).toBe("v0.23.0 ready, click to reload")
    expect(reloadToastTitle("0.23.0")).toBe("Updated to v0.23.0")
  })
})
