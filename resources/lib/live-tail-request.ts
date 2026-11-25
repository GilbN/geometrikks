/**
 * Asks Access Logs to open on its Live tail tab. The tab is page state, not
 * part of the URL, so a request made before the page mounts waits here until
 * the page takes it.
 */
import { useEffect } from "react"

const EVENT = "geometrikks:live-tail"
let pending = false

export function requestLiveTail(): void {
  pending = true
  window.dispatchEvent(new Event(EVENT))
}

/** Calls `start` for a request made before or while the page is mounted. */
export function useLiveTailRequest(start: () => void): void {
  useEffect(() => {
    const take = () => {
      if (!pending) return
      pending = false
      start()
    }
    take()
    window.addEventListener(EVENT, take)
    return () => window.removeEventListener(EVENT, take)
  }, [start])
}
