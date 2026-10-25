export const IDLE_RELOAD_MS = 300_000
export const CHUNK_ERROR_WINDOW_MS = 600_000
export const RELOAD_GUARD_STORAGE_KEY = "geometrikks-reload-guard"
export const INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const

const TEXT_ENTRY_TAG_NAMES = new Set(["INPUT", "TEXTAREA", "SELECT"])

export interface TextEntryCandidate {
  tagName: string
  isContentEditable: boolean
}

export function isTextEntryElement(element: TextEntryCandidate | null): boolean {
  if (element === null) return false
  return TEXT_ENTRY_TAG_NAMES.has(element.tagName) || element.isContentEditable
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

export function reloadPage(pageBuildKey: string | null): void {
  if (pageBuildKey !== null) {
    try {
      sessionStorage.setItem(RELOAD_GUARD_STORAGE_KEY, pageBuildKey)
    } catch {
    }
  }
  window.location.reload()
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
  reload: () => void
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

  function stopTimer() {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function reloadIfAllowed(): boolean {
    if (!deps.canAutoReload()) return false
    stopTimer()
    armed = false
    deps.reload()
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
    if (armed && waitingOnTextField && !deps.textEntryFocused()) {
      waitingOnTextField = false
      reloadIfAllowed()
    }
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

  const inputListenerOptions = { capture: true }
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
  reload: () => void
}

export function createPreloadErrorHandler(
  deps: PreloadErrorHandlerDeps,
): (preloadEvent: Event) => void {
  return (preloadEvent) => {
    if (!shouldReloadOnChunkError(deps.isPending(), deps.lastStartedAtChangeAt(), deps.now())) return
    if (!deps.canAutoReload()) return
    preloadEvent.preventDefault()
    deps.reload()
  }
}
