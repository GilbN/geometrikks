/**
 * Asks Access Logs to open on its Live tail tab. The tab is page state, not
 * part of the URL, so a request made before the page mounts waits here until
 * the page takes it.
 */
import { useEffect } from "react"

const EVENT = "geometrikks:live-tail"
/** A request the page has not taken lapses, so a navigation that never
 *  arrived can't open the tab on some later visit. */
const LAPSE_MS = 5000
let requestedAt: number | null = null

export function requestLiveTail(): void {
  requestedAt = Date.now()
  window.dispatchEvent(new Event(EVENT))
}

/** Calls `start` for a request made before or while the page is mounted. */
export function useLiveTailRequest(start: () => void): void {
  useEffect(() => {
    const take = () => {
      const fresh = requestedAt !== null && Date.now() - requestedAt < LAPSE_MS
      requestedAt = null
      if (fresh) start()
    }
    take()
    window.addEventListener(EVENT, take)
    return () => window.removeEventListener(EVENT, take)
  }, [start])
}
