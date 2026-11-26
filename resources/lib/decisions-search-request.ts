/**
 * Asks the Security decisions table to search for an IP or range, from the
 * command palette. The search box is table state, so a request made before
 * the table mounts waits here until the table takes it.
 */
import { useEffect } from "react"

const EVENT = "geometrikks:decisions-search"
/** A request the table has not taken lapses, so it can't fill the box on a later visit. */
const LAPSE_MS = 5000
let request: { query: string; at: number } | null = null

export function requestDecisionsSearch(query: string): void {
  request = { query, at: Date.now() }
  window.dispatchEvent(new Event(EVENT))
}

/** Calls `search` for a request made before or while the table is mounted. */
export function useDecisionsSearchRequest(search: (query: string) => void): void {
  useEffect(() => {
    const take = () => {
      const pending = request
      request = null
      if (pending && Date.now() - pending.at < LAPSE_MS) search(pending.query)
    }
    take()
    window.addEventListener(EVENT, take)
    return () => window.removeEventListener(EVENT, take)
  }, [search])
}
