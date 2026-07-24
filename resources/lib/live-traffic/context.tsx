/**
 * The single live-traffic subscription on the map page.
 *
 * Everything downstream reads the store rather than the socket, and each
 * consumer gets its own clock: the map's rAF loop is called imperatively per
 * batch, the strips re-render at most every 250ms, vitals and the wire at 1Hz.
 * A naive setState here would re-render the map subtree seven times a second.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react"
import { useLiveEvents } from "@/lib/live-feed-context"
import { useBannedIps } from "@/lib/queries"
import { getDemoTrafficMode, makeDemoRequests } from "@/lib/demo-traffic"
import { pairLiveEvents } from "./pairing"
import { LiveTrafficStore } from "./store"
import type { LiveRequest, SecondBucket, Vitals } from "./types"

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

const STRIP_INTERVAL_MS = 250
const SNAPSHOT_INTERVAL_MS = 1000

export function LiveTrafficProvider({
  enabled,
  children,
}: {
  enabled: boolean
  children: React.ReactNode
}) {
  const store = useMemo(() => new LiveTrafficStore(), [])
  const { data: bannedIps } = useBannedIps()
  // Read through a ref so a refetched ban list does not resubscribe the socket.
  const bannedRef = useRef<ReadonlySet<string>>(new Set())
  bannedRef.current = bannedIps ?? new Set()
  const demoMode = getDemoTrafficMode()

  useLiveEvents(
    (events, dropped) => {
      const now = Date.now()
      store.ingest(pairLiveEvents(events, bannedRef.current, now), dropped, now)
    },
    enabled && demoMode === "off",
  )

  useEffect(() => {
    if (!enabled || demoMode === "off") return
    let cursor = 0
    const emit = () => {
      const now = Date.now()
      const count = demoMode === "burst" ? 4 : 1
      store.ingest(makeDemoRequests(cursor, count, now), 0, now)
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

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

export function useLiveTrafficStore(): LiveTrafficStore {
  const store = useContext(StoreContext)
  if (!store) throw new Error("useLiveTrafficStore must be used inside LiveTrafficProvider")
  return store
}

/** Newest requests, refreshed at most every 250ms. */
export function useLiveStrips(max = 4): LiveRequest[] {
  const store = useLiveTrafficStore()
  const [strips, setStrips] = useState<LiveRequest[]>([])

  useEffect(() => {
    let dirty = false
    const unsubscribe = store.onRequests(() => {
      dirty = true
    })
    const interval = window.setInterval(() => {
      if (!dirty) return
      dirty = false
      setStrips(store.getRequests().slice(0, max))
    }, STRIP_INTERVAL_MS)
    return () => {
      unsubscribe()
      window.clearInterval(interval)
    }
  }, [max, store])

  return strips
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

export function useLiveBuckets(): SecondBucket[] {
  const store = useLiveTrafficStore()
  const [buckets, setBuckets] = useState<SecondBucket[]>([])

  useEffect(() => {
    const tick = () => setBuckets(store.getBuckets(Date.now()))
    tick()
    const interval = window.setInterval(tick, SNAPSHOT_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [store])

  return buckets
}
