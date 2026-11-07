/**
 * On a phone, Back closes the top overlay before it leaves the page. Each
 * overlay that opens pushes the same href with `state.overlay` set to its id,
 * so a pop off that entry closes it. The IP inspector already has an entry of
 * its own (`?inspect=`), which the manager adopts instead of pushing another.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { useRouter, type RouterHistory } from "@tanstack/react-router"
import { usePhoneLayout } from "@/hooks/use-phone-map"

declare module "@tanstack/history" {
  interface HistoryState {
    overlay?: string
  }
}

export function overlayCloseAction(top: string | undefined, id: string): "back" | "none" {
  return top === id ? "back" : "none"
}

export type OverlayStep = { type: "back" } | { type: "replace" | "push"; overlay: string }

/** The history steps for one commit's worth of in-app opens and closes, given
 *  the overlay that owns the current entry. */
export function planOverlaySteps(top: string | undefined, closed: string[], opened: string[]): OverlayStep[] {
  const closingTop = closed.some((id) => overlayCloseAction(top, id) === "back")
  if (!closingTop) return opened.map((overlay) => ({ type: "push", overlay }))
  if (opened.length === 0) return [{ type: "back" }]
  const [first, ...rest] = opened
  return [{ type: "replace", overlay: first }, ...rest.map((overlay) => ({ type: "push" as const, overlay }))]
}

/** The open overlays a pop onto `entry`'s entry closes: those opened after it,
 *  or all of them when no open overlay owns the entry. */
export function overlaysAbove(stack: readonly string[], entry: string | undefined): string[] {
  const index = entry === undefined ? -1 : stack.indexOf(entry)
  return stack.slice(index + 1)
}

type HistoryLocation = RouterHistory["location"]

function plainState(state: HistoryLocation["state"]) {
  const { overlay: _overlay, ...rest } = state
  return rest
}

type OpenOverlay = { id: string; adopt: boolean }

export function createOverlayHistory(history: RouterHistory) {
  const registered = new Map<string, { adopt: boolean; close: () => void }>()
  let stack: OpenOverlay[] = []
  const pendingOpen = new Set<string>()
  const pendingClose = new Set<string>()
  let flushQueued = false
  let active = false
  // history.back() lands a tick later; a second close before then must not pop twice.
  let backingFromKey: string | undefined
  // An overlay entry whose URL changed while it was open (a filter set in the
  // Layers drawer) hands that URL to the entry below when Back pops it. Only
  // the entries re-stamped after such a change count: other same-path entries
  // (a GO across several) differ for their own reasons.
  let carriedHref: string | undefined
  const restampedKeys = new Set<string>()
  let last = history.location

  const isStale = (id: string) => !registered.get(id)?.adopt && !stack.some((open) => open.id === id)

  function back() {
    const key = history.location.state.__TSR_key
    if (key !== undefined && key === backingFromKey) return
    backingFromKey = key
    history.back()
  }

  function flush() {
    flushQueued = false
    const steps = planOverlaySteps(history.location.state.overlay, [...pendingClose], [...pendingOpen])
    pendingClose.clear()
    pendingOpen.clear()
    for (const step of steps) {
      if (step.type === "back") {
        back()
        continue
      }
      const { href, state } = history.location
      history[step.type](href, { ...state, overlay: step.overlay })
    }
  }

  function queueFlush() {
    if (flushQueued) return
    flushQueued = true
    queueMicrotask(flush)
  }

  function keepOverlayOnReplace(previous: HistoryLocation, location: HistoryLocation) {
    const id = previous.state.overlay
    if (!id || location.state.overlay || previous.pathname !== location.pathname) return
    // At once, not in a microtask: an action that filters and then closes its
    // drawer in one click renders the close before a microtask would run.
    if (isStale(id)) return
    history.replace(location.href, { ...location.state, overlay: id })
    const key = history.location.state.__TSR_key
    if (key) restampedKeys.add(key)
  }

  function onPop(previous: HistoryLocation, location: HistoryLocation, backwards: boolean) {
    backingFromKey = undefined
    const previousId = previous.state.overlay
    const previousKey = previous.state.__TSR_key
    if (
      backwards &&
      previousId &&
      !registered.get(previousId)?.adopt &&
      previousKey !== undefined &&
      restampedKeys.has(previousKey) &&
      previous.pathname === location.pathname &&
      previous.href !== location.href
    ) {
      carriedHref ??= previous.href
    }

    const entry = location.state.overlay
    const closing = overlaysAbove(stack.map((open) => open.id), entry)
    const toClose = stack.filter((open) => closing.includes(open.id) && !open.adopt)
    stack = stack.filter((open) => !closing.includes(open.id))
    for (const open of toClose) registered.get(open.id)?.close()

    queueMicrotask(() => {
      if (history.location.state.__TSR_key !== location.state.__TSR_key) return
      if (entry && isStale(entry)) {
        if (backwards && history.canGoBack()) return back()
        history.replace(carriedHref ?? location.href, plainState(location.state))
        carriedHref = undefined
        return
      }
      const href = carriedHref
      carriedHref = undefined
      if (href && href !== location.href) history.replace(href, location.state)
    })
  }

  return {
    setActive(next: boolean) {
      active = next
    },
    register(id: string, adopt: boolean, close: () => void) {
      const registration = { adopt, close }
      registered.set(id, registration)
      return () => {
        if (registered.get(id) === registration) registered.delete(id)
      }
    },
    opened(id: string) {
      if (!active || stack.some((open) => open.id === id)) return
      const adopt = registered.get(id)?.adopt ?? false
      stack.push({ id, adopt })
      if (adopt) return
      if (!pendingClose.delete(id)) pendingOpen.add(id)
      queueFlush()
    },
    closed(id: string) {
      const open = stack.find((overlay) => overlay.id === id)
      if (!open) return
      stack = stack.filter((overlay) => overlay !== open)
      if (open.adopt) return
      if (!pendingOpen.delete(id)) pendingClose.add(id)
      queueFlush()
    },
    /** For an adopted overlay closing in the app: goes back when it owns the
     *  current entry and says whether it did. */
    backFrom(id: string): boolean {
      if (!active || overlayCloseAction(history.location.state.overlay, id) !== "back") return false
      back()
      return true
    },
    /** The history state an adopted overlay's own navigation pushes. */
    stateFor(id: string) {
      return active ? { overlay: id } : undefined
    },
    start() {
      const entry = history.location.state.overlay
      if (entry && isStale(entry)) history.replace(history.location.href, plainState(history.location.state))
      last = history.location
      return history.subscribe(({ location, action }) => {
        const previous = last
        last = location
        if (action.type === "PUSH") return
        if (action.type === "REPLACE") return keepOverlayOnReplace(previous, location)
        // A blocker that cancels a pop still reports it, with the location unchanged.
        if (location.state.__TSR_key === previous.state.__TSR_key) {
          backingFromKey = undefined
          carriedHref = undefined
          return
        }
        onPop(previous, location, action.type === "BACK" || (action.type === "GO" && action.index < 0))
      })
    },
  }
}

type OverlayHistory = ReturnType<typeof createOverlayHistory>

const OverlayHistoryContext = createContext<OverlayHistory | null>(null)

export function OverlayHistoryProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const [overlays] = useState(() => createOverlayHistory(router.history))
  const phone = usePhoneLayout()
  // A layout effect, so it is set before the children's open effects run.
  useLayoutEffect(() => overlays.setActive(phone), [overlays, phone])
  useEffect(() => overlays.start(), [overlays])
  return <OverlayHistoryContext.Provider value={overlays}>{children}</OverlayHistoryContext.Provider>
}

export function useOverlayHistory(): OverlayHistory {
  const overlays = useContext(OverlayHistoryContext)
  if (!overlays) throw new Error("useOverlayHistory must be used within an OverlayHistoryProvider")
  return overlays
}

/** Gives an overlay its own history entry on a phone, so Back closes it.
 *  `adopt` is for an overlay that pushes its own entry. */
export function useOverlayEntry(id: string, open: boolean, close: () => void, opts?: { adopt?: boolean }): void {
  const overlays = useOverlayHistory()
  const adopt = opts?.adopt ?? false
  const closeRef = useRef(close)
  useLayoutEffect(() => {
    closeRef.current = close
  })
  useEffect(() => overlays.register(id, adopt, () => closeRef.current()), [overlays, id, adopt])
  useEffect(() => {
    if (!open) return
    overlays.opened(id)
    return () => overlays.closed(id)
  }, [overlays, id, open])
}
