import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IDLE_RELOAD_MS, createIdleReloader } from "./auto-reload"
import { getReloadNoticeState, resetReloadNoticeForTests } from "./reload-notice"
import type { BuildIdentity } from "./update-detector"
import { createUpdateWiring } from "./update-wiring"

function build(version: string): BuildIdentity {
  return { version, changelogDigest: null }
}

function setup(serverBuilds: BuildIdentity[], { visibility = "visible" as DocumentVisibilityState } = {}) {
  const remainingBuilds = [...serverBuilds]
  const readServerBuild = vi.fn(async () => {
    const serverBuild = remainingBuilds.length > 1 ? remainingBuilds.shift() : remainingBuilds[0]
    if (serverBuild === undefined) throw new Error("no server build")
    return serverBuild
  })
  const reportError = vi.fn()
  const wiring = createUpdateWiring({ readServerBuild, now: () => Date.now(), reportError })
  const events = new EventTarget()
  const state = { visibility }
  const reload = vi.fn(() => true)
  const idleReloader = createIdleReloader({
    events,
    visibilityState: () => state.visibility,
    textEntryFocused: () => false,
    canAutoReload: wiring.canAutoReload,
    reload,
  })
  const detach = wiring.attachIdleReloader(idleReloader)
  return { wiring, readServerBuild, reportError, events, state, reload, idleReloader, detach }
}

beforeEach(() => {
  vi.useFakeTimers()
  resetReloadNoticeForTests()
  const store = new Map<string, string>()
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("a service worker update", () => {
  it("shows no notice and never reloads a page already on the server's build", async () => {
    const { wiring, reload } = setup([build("0.23.0")])
    await wiring.start()
    await wiring.serviceWorkerUpdated()
    expect(getReloadNoticeState().pending).toBe(false)
    vi.advanceTimersByTime(IDLE_RELOAD_MS * 2)
    expect(reload).not.toHaveBeenCalled()
  })

  it("shows no notice when it arrives before the page build was read", async () => {
    const { wiring, readServerBuild, reload } = setup([build("0.23.0")])
    await wiring.serviceWorkerUpdated()
    await wiring.start()
    expect(getReloadNoticeState().pending).toBe(false)
    expect(readServerBuild).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(IDLE_RELOAD_MS * 2)
    expect(reload).not.toHaveBeenCalled()
  })

  it("shows the notice when the server now runs a different build", async () => {
    const { wiring, reload } = setup([build("0.22.0"), build("0.23.0")])
    await wiring.start()
    await wiring.serviceWorkerUpdated()
    expect(getReloadNoticeState()).toMatchObject({ pending: true, version: "0.23.0" })
    vi.advanceTimersByTime(IDLE_RELOAD_MS)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("never marks an update when the build read fails", async () => {
    const { wiring, readServerBuild, reportError } = setup([build("0.22.0")])
    await wiring.start()
    readServerBuild.mockRejectedValueOnce(new Error("offline"))
    await wiring.serviceWorkerUpdated()
    expect(getReloadNoticeState().pending).toBe(false)
    expect(reportError).not.toHaveBeenCalled()
  })
})

describe("a health poll", () => {
  it("marks the update once a new startedAt comes with a new build", async () => {
    const { wiring } = setup([build("0.22.0"), build("0.23.0")])
    await wiring.start()
    await wiring.pollSucceeded("t1")
    expect(getReloadNoticeState().pending).toBe(false)
    await wiring.pollSucceeded("t2")
    expect(getReloadNoticeState()).toMatchObject({ pending: true, version: "0.23.0" })
  })

  it("keeps a restart on the same build quiet", async () => {
    const { wiring, reload } = setup([build("0.22.0")])
    await wiring.start()
    await wiring.pollSucceeded("t1")
    await wiring.pollSucceeded("t2")
    expect(getReloadNoticeState().pending).toBe(false)
    vi.advanceTimersByTime(IDLE_RELOAD_MS * 2)
    expect(reload).not.toHaveBeenCalled()
  })
})
