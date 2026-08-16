/**
 * The single live-traffic subscription on the map page.
 *
 * Everything downstream reads the store rather than the socket, and each
 * consumer gets its own clock: the map's rAF loop is called imperatively per
 * batch, while the reading surfaces snapshot at 1Hz. A naive setState here
 * would re-render the map subtree seven times a second.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react"
import { useLiveEvents, useLiveFeedStatus } from "@/lib/live-feed-context"
import { useBannedIps } from "@/lib/queries"
import { getDemoTrafficMode, makeDemoRequests } from "@/lib/demo-traffic"
import { matchesSources, pairLiveEvents } from "./pairing"
import { LiveTrafficStore } from "./store"
import { EMPTY_SUMMARY, summarize, type LiveSummary } from "./summary"
import type { LiveRequest, Vitals } from "./types"

/**
 * What is actually feeding the store, as far as the UI should care.
 * Demo mode never opens the socket, so "connected" here means "something is
 * feeding this" rather than "the socket is open" - the distinction the
 * disconnected states downstream (the rail and the pill) depend on.
 */
export type LiveFeedState = "connected" | "reconnecting"

const EMPTY_VITALS: Vitals = {
  rpm: 0,
  errorRate: 0,
  threatCount: 0,
  uniqueIps: 0,
  countries: 0,
  dropped: 0,
  droppedRecently: false,
  sparkline: [],
}

const StoreContext = createContext<LiveTrafficStore | null>(null)
const FeedStateContext = createContext<LiveFeedState>("reconnecting")

const SNAPSHOT_INTERVAL_MS = 1000

export function LiveTrafficProvider({
  enabled,
  sources = [],
  children,
}: {
  enabled: boolean
  sources?: string[]
  children: React.ReactNode
}) {
  const store = useMemo(() => new LiveTrafficStore(), [])
  const { data: bannedIps } = useBannedIps()
  // Read through a ref so a refetched ban list does not resubscribe the socket.
  const bannedRef = useRef<ReadonlySet<string>>(new Set())
  bannedRef.current = bannedIps ?? new Set()
  const demoMode = getDemoTrafficMode()
  const socketStatus = useLiveFeedStatus()
  // Demo mode is a feed in its own right: it never opens the socket, so the
  // socket's status alone would read as permanently disconnected.
  const feedState: LiveFeedState =
    demoMode !== "off" || socketStatus === "connected" ? "connected" : "reconnecting"

  // Read through a ref so a changed selection does not resubscribe the socket;
  // the reset effect below is what actually applies a new filter to the window.
  const sourcesRef = useRef<string[]>(sources)
  sourcesRef.current = sources
  // JSON.stringify (not join(" ")) so a hostname containing a space can't
  // alias a distinct selection into the same dependency identity.
  const sourcesKey = JSON.stringify(sources)

  useLiveEvents(
    (events, dropped) => {
      const now = Date.now()
      const paired = pairLiveEvents(events, bannedRef.current, now).filter((request) =>
        matchesSources(request, sourcesRef.current),
      )
      store.ingest(paired, dropped, now)
    },
    enabled && demoMode === "off",
  )

  useEffect(() => {
    if (!enabled || demoMode === "off") return
    let cursor = 0
    const emit = () => {
      const now = Date.now()
      const count = demoMode === "burst" ? 4 : 1
      const requests = makeDemoRequests(cursor, count, now).filter((request) =>
        matchesSources(request, sourcesRef.current),
      )
      store.ingest(requests, 0, now)
      cursor += count
    }
    const kickoff = window.setTimeout(emit, 250)
    const interval = window.setInterval(emit, demoMode === "burst" ? 2800 : 1100)
    return () => {
      window.clearTimeout(kickoff)
      window.clearInterval(interval)
    }
  }, [demoMode, enabled, store])

  useEffect(() => {
    if (!enabled) store.clear()
  }, [enabled, store])

  // Drop the window whenever the selection changes so stale unfiltered
  // requests do not linger next to newly-filtered ones.
  useEffect(() => {
    store.reset()
    // sourcesKey is the stable identity for the sources array; see above.
  }, [sourcesKey, store])

  return (
    <StoreContext.Provider value={store}>
      <FeedStateContext.Provider value={feedState}>{children}</FeedStateContext.Provider>
    </StoreContext.Provider>
  )
}

export function useLiveTrafficStore(): LiveTrafficStore {
  const store = useContext(StoreContext)
  if (!store) throw new Error("useLiveTrafficStore must be used inside LiveTrafficProvider")
  return store
}

/** "connected" when something is feeding the store, demo mode included. */
export function useLiveFeedState(): LiveFeedState {
  return useContext(FeedStateContext)
}

/**
 * The whole window plus its aggregates, refreshed once a second. Pass
 * `active: false` for a surface that is closed - a hidden sheet should not
 * pay for a snapshot it will not render.
 */
export function useLiveWindow(active = true): {
  requests: readonly LiveRequest[]
  summary: LiveSummary
} {
  const store = useLiveTrafficStore()
  const [requests, setRequests] = useState<readonly LiveRequest[]>(() =>
    active ? store.getRequests() : [],
  )

  useEffect(() => {
    if (!active) {
      // Drop the snapshot so a reopened surface never flashes stale rows.
      setRequests([])
      return
    }
    const tick = () => setRequests(store.getRequests())
    tick()
    const interval = window.setInterval(tick, SNAPSHOT_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [active, store])

  const summary = useMemo(
    () => (requests.length === 0 ? EMPTY_SUMMARY : summarize(requests)),
    [requests],
  )

  return { requests, summary }
}

export function useLiveVitals(): Vitals {
  const store = useLiveTrafficStore()
  const [vitals, setVitals] = useState<Vitals>(EMPTY_VITALS)

  useEffect(() => {
    const tick = () => setVitals(store.getVitals(Date.now()))
    tick()
    const interval = window.setInterval(tick, SNAPSHOT_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [store])

  return vitals
}
