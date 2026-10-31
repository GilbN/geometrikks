export const IDLE_RELOAD_MS = 300_000
export const CHUNK_ERROR_WINDOW_MS = 600_000
export const RELOAD_GUARD_STORAGE_KEY = "geometrikks-reload-guard"
export const INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const

const TEXT_ENTRY_TAG_NAMES = new Set(["TEXTAREA", "SELECT"])
const TEXT_ENTRY_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
])

export interface TextEntryCandidate {
  tagName: string
  type?: string
  isContentEditable: boolean
}

export function isTextEntryElement(element: TextEntryCandidate | null): boolean {
  if (element === null) return false
  if (element.isContentEditable || TEXT_ENTRY_TAG_NAMES.has(element.tagName)) return true
  return element.tagName === "INPUT" && TEXT_ENTRY_INPUT_TYPES.has((element.type ?? "text").toLowerCase())
}

export function loadReloadGuard(): string | null {
  try {
    return sessionStorage.getItem(RELOAD_GUARD_STORAGE_KEY)
  } catch {
    return null
  }
}

export function clearReloadGuard(): void {
  try {
    sessionStorage.removeItem(RELOAD_GUARD_STORAGE_KEY)
  } catch {
  }
}

export function autoReloadAllowed(pageBuildKey: string | null, guardKey: string | null): boolean {
  return pageBuildKey !== null && pageBuildKey !== guardKey
}

function storeReloadGuard(pageBuildKey: string | null): boolean {
  if (pageBuildKey === null) return false
  try {
    sessionStorage.setItem(RELOAD_GUARD_STORAGE_KEY, pageBuildKey)
    return true
  } catch {
    return false
  }
}

export function reloadPage(pageBuildKey: string | null): void {
  storeReloadGuard(pageBuildKey)
  window.location.reload()
}

export function loadPage(pageBuildKey: string | null, href: string): void {
  storeReloadGuard(pageBuildKey)
  window.location.assign(href)
}

export function autoReloadPage(pageBuildKey: string | null): boolean {
  if (!storeReloadGuard(pageBuildKey)) return false
  window.location.reload()
  return true
}

/** Once a reload has started, later calls report success without reloading again. */
export function latchFirstReload(reload: () => boolean): () => boolean {
  let reloadStarted = false
  return () => {
    if (!reloadStarted) reloadStarted = reload()
    return reloadStarted
  }
}

export interface ReloadGuard {
  allows(pageBuildKey: string | null): boolean
  pageKeyKnown(pageBuildKey: string): void
  restartObserved(): void
}

/**
 * Reads the stored guard once. It blocks only the reload right after one this
 * tab already made for the same build; a restart seen by this page lifts it.
 */
export function createReloadGuard(): ReloadGuard {
  let guardKey = loadReloadGuard()
  let pageKeySettled = false
  return {
    allows: (pageBuildKey) => autoReloadAllowed(pageBuildKey, guardKey),
    pageKeyKnown(pageBuildKey) {
      if (pageKeySettled) return
      pageKeySettled = true
      if (pageBuildKey !== guardKey) clearReloadGuard()
    },
    restartObserved() {
      guardKey = null
      clearReloadGuard()
    },
  }
}

const PRELOAD_FAILURE_MESSAGES = [
  "Failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "Importing a module script failed",
  "Unable to preload CSS",
]

function isPreloadFetchFailure(preloadEvent: Event): boolean {
  const { payload } = preloadEvent as Event & { payload?: unknown }
  if (typeof payload !== "object" || payload === null || !("message" in payload)) return false
  const { message } = payload
  if (typeof message !== "string") return false
  return PRELOAD_FAILURE_MESSAGES.some((fragment) => message.includes(fragment))
}

export function shouldReloadOnChunkError(
  pending: boolean,
  lastStartedAtChangeAt: number | null,
  now: number,
): boolean {
  if (pending) return true
  return lastStartedAtChangeAt !== null && now - lastStartedAtChangeAt <= CHUNK_ERROR_WINDOW_MS
}

export interface IdleReloaderDeps {
  events: EventTarget
  visibilityState: () => DocumentVisibilityState
  textEntryFocused: () => boolean
  canAutoReload: () => boolean
  reload: () => boolean
}

export interface IdleReloader {
  arm(): void
  checkSettled(): void
  dispose(): void
}

export function createIdleReloader(deps: IdleReloaderDeps): IdleReloader {
  let armed = false
  let foundWhileHidden = false
  let returnWindowOpen = false
  let waitingOnTextField = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let focusSettleTimer: ReturnType<typeof setTimeout> | null = null

  function stopTimer() {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    if (focusSettleTimer !== null) {
      clearTimeout(focusSettleTimer)
      focusSettleTimer = null
    }
  }

  function reloadIfAllowed(): boolean {
    if (!deps.canAutoReload() || !deps.reload()) return false
    stopTimer()
    armed = false
    return true
  }

  function startTimer() {
    stopTimer()
    waitingOnTextField = false
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (deps.textEntryFocused()) {
        waitingOnTextField = true
        return
      }
      reloadIfAllowed()
    }, IDLE_RELOAD_MS)
  }

  function onInput() {
    returnWindowOpen = false
    if (armed && !foundWhileHidden) startTimer()
  }

  function onFocusOut() {
    if (!armed || !waitingOnTextField) return
    if (focusSettleTimer !== null) clearTimeout(focusSettleTimer)
    // document.activeElement is body during focusout, so read it after focus settles.
    focusSettleTimer = setTimeout(() => {
      focusSettleTimer = null
      if (armed && waitingOnTextField && !deps.textEntryFocused()) {
        waitingOnTextField = false
        reloadIfAllowed()
      }
    }, 0)
  }

  function onVisibilityChange() {
    if (deps.visibilityState() !== "visible") {
      returnWindowOpen = false
      return
    }
    if (armed && foundWhileHidden) {
      foundWhileHidden = false
      if (!reloadIfAllowed()) startTimer()
      return
    }
    if (!armed) returnWindowOpen = true
  }

  const inputListenerOptions = { capture: true, passive: true }
  for (const eventName of INPUT_EVENTS) {
    deps.events.addEventListener(eventName, onInput, inputListenerOptions)
  }
  deps.events.addEventListener("focusout", onFocusOut)
  deps.events.addEventListener("visibilitychange", onVisibilityChange)

  return {
    arm() {
      if (armed) return
      armed = true
      const foundAfterReturn = returnWindowOpen
      returnWindowOpen = false
      if (deps.visibilityState() === "hidden") {
        foundWhileHidden = true
        return
      }
      if (foundAfterReturn && reloadIfAllowed()) return
      startTimer()
    },
    checkSettled() {
      returnWindowOpen = false
    },
    dispose() {
      stopTimer()
      armed = false
      for (const eventName of INPUT_EVENTS) {
        deps.events.removeEventListener(eventName, onInput, inputListenerOptions)
      }
      deps.events.removeEventListener("focusout", onFocusOut)
      deps.events.removeEventListener("visibilitychange", onVisibilityChange)
    },
  }
}

export interface PreloadErrorHandlerDeps {
  isPending: () => boolean
  lastStartedAtChangeAt: () => number | null
  now: () => number
  canAutoReload: () => boolean
  reload: () => boolean
}

export function createPreloadErrorHandler(
  deps: PreloadErrorHandlerDeps,
): (preloadEvent: Event) => void {
  return (preloadEvent) => {
    if (!isPreloadFetchFailure(preloadEvent)) return
    if (!shouldReloadOnChunkError(deps.isPending(), deps.lastStartedAtChangeAt(), deps.now())) return
    if (!deps.canAutoReload()) return
    if (deps.reload()) preloadEvent.preventDefault()
  }
}
