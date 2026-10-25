import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  CHUNK_ERROR_WINDOW_MS,
  IDLE_RELOAD_MS,
  INPUT_EVENTS,
  RELOAD_GUARD_STORAGE_KEY,
  autoReloadAllowed,
  clearReloadGuard,
  createIdleReloader,
  createPreloadErrorHandler,
  isTextEntryElement,
  loadReloadGuard,
  reloadPage,
  shouldReloadOnChunkError,
} from "./auto-reload"

const MINUTE = 60_000

function setup({
  visibility = "visible" as DocumentVisibilityState,
  textEntryFocused = false,
  canAutoReload = true,
} = {}) {
  const events = new EventTarget()
  const state = { visibility, textEntryFocused, canAutoReload }
  const reload = vi.fn()
  const reloader = createIdleReloader({
    events,
    visibilityState: () => state.visibility,
    textEntryFocused: () => state.textEntryFocused,
    canAutoReload: () => state.canAutoReload,
    reload,
  })
  return { events, state, reload, reloader }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("createIdleReloader", () => {
  it("reloads after five minutes without input", () => {
    const { reload, reloader } = setup()
    reloader.arm()
    vi.advanceTimersByTime(IDLE_RELOAD_MS - 1)
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it.each(INPUT_EVENTS)("%s restarts the five minutes", (eventName) => {
    const { events, reload, reloader } = setup()
    reloader.arm()
    vi.advanceTimersByTime(4 * MINUTE)
    events.dispatchEvent(new Event(eventName))
    vi.advanceTimersByTime(5 * MINUTE - 1)
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(4 * MINUTE + 1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("pointermove does not restart the timer", () => {
    const { events, reload, reloader } = setup()
    reloader.arm()
    vi.advanceTimersByTime(4 * MINUTE)
    events.dispatchEvent(new Event("pointermove"))
    events.dispatchEvent(new Event("mousemove"))
    vi.advanceTimersByTime(MINUTE)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("listens for input in the capture phase", () => {
    const events = new EventTarget()
    const addEventListener = vi.spyOn(events, "addEventListener")
    createIdleReloader({
      events,
      visibilityState: () => "visible",
      textEntryFocused: () => false,
      canAutoReload: () => true,
      reload: vi.fn(),
    })
    for (const eventName of INPUT_EVENTS) {
      expect(addEventListener).toHaveBeenCalledWith(
        eventName,
        expect.any(Function),
        expect.objectContaining({ capture: true }),
      )
    }
  })

  it("waits while focus is in a text field and reloads when focus leaves", () => {
    const { events, state, reload, reloader } = setup({ textEntryFocused: true })
    reloader.arm()
    vi.advanceTimersByTime(IDLE_RELOAD_MS)
    vi.advanceTimersByTime(10 * MINUTE)
    expect(reload).not.toHaveBeenCalled()
    state.textEntryFocused = false
    events.dispatchEvent(new Event("focusout"))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("keeps waiting when focusout leaves focus in a text field", () => {
    const { events, reload, reloader } = setup({ textEntryFocused: true })
    reloader.arm()
    vi.advanceTimersByTime(IDLE_RELOAD_MS)
    events.dispatchEvent(new Event("focusout"))
    expect(reload).not.toHaveBeenCalled()
  })

  it("input while it waits on a text field restarts the five minutes", () => {
    const { events, state, reload, reloader } = setup({ textEntryFocused: true })
    reloader.arm()
    vi.advanceTimersByTime(IDLE_RELOAD_MS)
    events.dispatchEvent(new Event("keydown"))
    state.textEntryFocused = false
    vi.advanceTimersByTime(IDLE_RELOAD_MS - 1)
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("reloads when a page that was hidden when the update arrived becomes visible", () => {
    const { events, state, reload, reloader } = setup({ visibility: "hidden" })
    reloader.arm()
    expect(reload).not.toHaveBeenCalled()
    state.visibility = "visible"
    events.dispatchEvent(new Event("visibilitychange"))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("reloads at once when the first check after the page comes back finds the update", () => {
    const { events, state, reload, reloader } = setup({ visibility: "hidden" })
    state.visibility = "visible"
    events.dispatchEvent(new Event("visibilitychange"))
    reloader.arm()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("keeps the notice when input came before that first check", () => {
    const { events, state, reload, reloader } = setup({ visibility: "hidden" })
    state.visibility = "visible"
    events.dispatchEvent(new Event("visibilitychange"))
    events.dispatchEvent(new Event("pointerdown"))
    reloader.arm()
    expect(reload).not.toHaveBeenCalled()
  })

  it("keeps the notice once the first check after coming back has settled", () => {
    const { events, state, reload, reloader } = setup({ visibility: "hidden" })
    state.visibility = "visible"
    events.dispatchEvent(new Event("visibilitychange"))
    reloader.checkSettled()
    reloader.arm()
    expect(reload).not.toHaveBeenCalled()
  })

  it("never reloads while canAutoReload is false", () => {
    const idle = setup({ canAutoReload: false })
    idle.reloader.arm()
    vi.advanceTimersByTime(IDLE_RELOAD_MS * 2)
    expect(idle.reload).not.toHaveBeenCalled()

    const hidden = setup({ visibility: "hidden", canAutoReload: false })
    hidden.reloader.arm()
    hidden.state.visibility = "visible"
    hidden.events.dispatchEvent(new Event("visibilitychange"))
    vi.advanceTimersByTime(IDLE_RELOAD_MS * 2)
    expect(hidden.reload).not.toHaveBeenCalled()
  })

  it("dispose removes the listeners and the timer", () => {
    const { events, state, reload, reloader } = setup({ visibility: "hidden" })
    reloader.arm()
    reloader.dispose()
    state.visibility = "visible"
    events.dispatchEvent(new Event("visibilitychange"))
    events.dispatchEvent(new Event("pointerdown"))
    vi.advanceTimersByTime(IDLE_RELOAD_MS * 2)
    expect(reload).not.toHaveBeenCalled()

    const idle = setup()
    idle.reloader.arm()
    idle.reloader.dispose()
    vi.advanceTimersByTime(IDLE_RELOAD_MS * 2)
    expect(idle.reload).not.toHaveBeenCalled()
  })
})

describe("isTextEntryElement", () => {
  it.each(["INPUT", "TEXTAREA", "SELECT"])("is true for %s", (tagName) => {
    expect(isTextEntryElement({ tagName, isContentEditable: false })).toBe(true)
  })

  it("is true for a contenteditable element", () => {
    expect(isTextEntryElement({ tagName: "DIV", isContentEditable: true })).toBe(true)
  })

  it("is false for a button and for null", () => {
    expect(isTextEntryElement({ tagName: "BUTTON", isContentEditable: false })).toBe(false)
    expect(isTextEntryElement(null)).toBe(false)
  })
})

describe("autoReloadAllowed", () => {
  it("refuses the build that already reloaded once", () => {
    expect(autoReloadAllowed("0.22.0", "0.22.0")).toBe(false)
  })

  it("allows a build with no guard or a different one", () => {
    expect(autoReloadAllowed("0.22.0", null)).toBe(true)
    expect(autoReloadAllowed("0.23.0", "0.22.0")).toBe(true)
  })

  it("refuses when the page build is unknown", () => {
    expect(autoReloadAllowed(null, null)).toBe(false)
  })
})

describe("reload guard storage", () => {
  function stubStorage() {
    const store = new Map<string, string>()
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    })
    return store
  }

  it("reloadPage stores the key and reloads", () => {
    const store = stubStorage()
    const reload = vi.fn()
    vi.stubGlobal("window", { location: { reload } })
    reloadPage("0.22.0")
    expect(store.get(RELOAD_GUARD_STORAGE_KEY)).toBe("0.22.0")
    expect(reload).toHaveBeenCalledTimes(1)
    expect(loadReloadGuard()).toBe("0.22.0")
    clearReloadGuard()
    expect(loadReloadGuard()).toBeNull()
  })

  it("reloadPage with an unknown key writes no guard", () => {
    const store = stubStorage()
    const reload = vi.fn()
    vi.stubGlobal("window", { location: { reload } })
    reloadPage(null)
    expect(store.size).toBe(0)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("still reloads when sessionStorage throws", () => {
    const failing = () => {
      throw new Error("storage blocked")
    }
    vi.stubGlobal("sessionStorage", { getItem: failing, setItem: failing, removeItem: failing })
    const reload = vi.fn()
    vi.stubGlobal("window", { location: { reload } })
    reloadPage("0.22.0")
    expect(reload).toHaveBeenCalledTimes(1)
    expect(loadReloadGuard()).toBeNull()
    expect(() => clearReloadGuard()).not.toThrow()
  })
})

describe("shouldReloadOnChunkError", () => {
  const now = 100 * MINUTE

  it("reloads while an update is pending", () => {
    expect(shouldReloadOnChunkError(true, null, now)).toBe(true)
  })

  it("reloads within ten minutes of a restart", () => {
    expect(shouldReloadOnChunkError(false, now - 9 * MINUTE, now)).toBe(true)
  })

  it("does not reload after the window", () => {
    expect(shouldReloadOnChunkError(false, now - 11 * MINUTE, now)).toBe(false)
    expect(CHUNK_ERROR_WINDOW_MS).toBe(10 * MINUTE)
  })

  it("does not reload when no restart was ever seen", () => {
    expect(shouldReloadOnChunkError(false, null, now)).toBe(false)
  })
})

describe("createPreloadErrorHandler", () => {
  function handlerSetup({ pending = false, changeAt = null as number | null, canAutoReload = true } = {}) {
    const reload = vi.fn()
    const handler = createPreloadErrorHandler({
      isPending: () => pending,
      lastStartedAtChangeAt: () => changeAt,
      now: () => 100 * MINUTE,
      canAutoReload: () => canAutoReload,
      reload,
    })
    const preloadEvent = new Event("vite:preloadError", { cancelable: true })
    return { handler, preloadEvent, reload }
  }

  it("prevents the error and reloads while an update is pending", () => {
    const { handler, preloadEvent, reload } = handlerSetup({ pending: true })
    handler(preloadEvent)
    expect(preloadEvent.defaultPrevented).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("leaves the error alone with no update and no recent restart", () => {
    const { handler, preloadEvent, reload } = handlerSetup()
    handler(preloadEvent)
    expect(preloadEvent.defaultPrevented).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it("does nothing when the loop guard refuses", () => {
    const { handler, preloadEvent, reload } = handlerSetup({ pending: true, canAutoReload: false })
    handler(preloadEvent)
    expect(preloadEvent.defaultPrevented).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
})
