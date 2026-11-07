import { useEffect } from "react"
import { useRouter } from "@tanstack/react-router"

const RESTORE_TIMEOUT_MS = 1000
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const

const MAX_SAVED_SCROLL_TOPS = 100

const savedScrollTops = new Map<string, number>()

function saveScrollTop(key: string, top: number) {
  savedScrollTops.delete(key)
  if (!top) return
  savedScrollTops.set(key, top)
  if (savedScrollTops.size > MAX_SAVED_SCROLL_TOPS) {
    savedScrollTops.delete(savedScrollTops.keys().next().value!)
  }
}

/** Sets `main` to `top` once its content is tall enough to reach it. A page
 *  that loads its rows grows after the commit, so this waits up to a second
 *  and stops as soon as the user scrolls. Returns a function that stops it
 *  early. */
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
    // Not the navigation's fromLocation: the router sets that only after the
    // commit, so a page that navigates as it mounts would save the entry just
    // left at the reset scroll of 0.
    let shownKey = router.state.location.state.__TSR_key
    const unsubscribers = [
      router.subscribe("onBeforeNavigate", () => {
        stopRestore()
        pendingRestore = undefined
        if (shownKey) saveScrollTop(shownKey, main.scrollTop)
      }),
      // This runs before the new route renders, not in a layout effect. A
      // page's own layout effects run before the root's and may scroll on
      // mount, as the Agents deep link does, and a later reset would undo that.
      router.subscribe("onBeforeRouteMount", ({ toLocation, pathChanged }) => {
        const key = toLocation.state.__TSR_key
        shownKey = key
        if (!pathChanged) return
        main.scrollTop = 0
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
