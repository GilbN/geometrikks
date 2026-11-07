import { useEffect } from "react"
import { useRouter } from "@tanstack/react-router"

const RESTORE_TIMEOUT_MS = 1000
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const

const savedScrollTops = new Map<string, number>()

/** Sets `main` to `top` once its content is tall enough, which a page that
 *  loads its rows can take a moment to be. Gives up after a second, or as
 *  soon as the user scrolls. Returns a function that stops it early. */
function restoreWhenTall(main: HTMLElement, top: number): () => void {
  const deadline = performance.now() + RESTORE_TIMEOUT_MS
  let frame = 0
  const stop = () => {
    cancelAnimationFrame(frame)
    for (const type of USER_SCROLL_EVENTS) main.removeEventListener(type, stop)
  }
  const attempt = () => {
    if (main.scrollHeight - main.clientHeight >= top) {
      main.scrollTop = top
      stop()
    } else if (performance.now() < deadline) {
      frame = requestAnimationFrame(attempt)
    } else {
      stop()
    }
  }
  for (const type of USER_SCROLL_EVENTS) main.addEventListener(type, stop, { passive: true })
  attempt()
  return stop
}

/**
 * Every page scrolls inside the shell's one <main>. A move to another path
 * starts that page at the top, and Back or Forward onto an entry returns
 * <main> to where it was when that entry was left. A change that keeps the
 * path (filters, the inspector, overlay entries) leaves the scroll alone.
 */
export function usePageScroll(main: HTMLElement | null) {
  const router = useRouter()
  useEffect(() => {
    if (!main) return
    let pendingRestore: { key: string; top: number } | undefined
    let stopRestore = () => {}
    const unsubscribers = [
      router.subscribe("onBeforeNavigate", ({ fromLocation }) => {
        stopRestore()
        pendingRestore = undefined
        const key = fromLocation?.state.__TSR_key
        if (key) savedScrollTops.set(key, main.scrollTop)
      }),
      // Before the new route renders, not in a layout effect: a page's own
      // layout effects run before the root's and may scroll on mount (the
      // Agents deep link does), which a later reset would undo.
      router.subscribe("onBeforeRouteMount", ({ toLocation, pathChanged }) => {
        if (!pathChanged) return
        main.scrollTop = 0
        const key = toLocation.state.__TSR_key
        const top = key ? savedScrollTops.get(key) : undefined
        if (key && top) pendingRestore = { key, top }
      }),
      // After the commit, so the height it waits for is the new page's.
      router.subscribe("onResolved", ({ toLocation }) => {
        if (!pendingRestore || pendingRestore.key !== toLocation.state.__TSR_key) return
        stopRestore = restoreWhenTall(main, pendingRestore.top)
        pendingRestore = undefined
      }),
    ]
    return () => {
      stopRestore()
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [main, router])
}
