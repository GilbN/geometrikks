/**
 * Asks Access Logs to open on its Live tail or History tab. The tab is page
 * state, not part of the URL, so a request made before the page mounts waits
 * here until the page takes it.
 */
import { useEffect } from "react"

export type AccessLogsTab = "history" | "live"

const EVENT = "geometrikks:access-logs-tab"
/** A request the page has not taken lapses, so a navigation that never
 *  arrived can't switch the tab on some later visit. */
const LAPSE_MS = 5000
let request: { tab: AccessLogsTab; at: number } | null = null

export function requestAccessLogsTab(tab: AccessLogsTab): void {
  request = { tab, at: Date.now() }
  window.dispatchEvent(new Event(EVENT))
}

export function requestLiveTail(): void {
  requestAccessLogsTab("live")
}

/** Calls `select` for a request made before or while the page is mounted. */
export function useAccessLogsTabRequest(select: (tab: AccessLogsTab) => void): void {
  useEffect(() => {
    const take = () => {
      const pending = request
      request = null
      if (pending && Date.now() - pending.at < LAPSE_MS) select(pending.tab)
    }
    take()
    window.addEventListener(EVENT, take)
    return () => window.removeEventListener(EVENT, take)
  }, [select])
}
