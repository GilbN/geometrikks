import { createContext, useContext, useEffect, useRef, useState } from "react"
import { liveFeed, type LiveEvent, type LiveFeedStatus } from "./websocket"

const StatusContext = createContext<LiveFeedStatus>("disconnected")

export function LiveFeedProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<LiveFeedStatus>("disconnected")
  useEffect(() => liveFeed.onStatus(setStatus), [])
  return <StatusContext.Provider value={status}>{children}</StatusContext.Provider>
}

export function useLiveFeedStatus(): LiveFeedStatus {
  return useContext(StatusContext)
}

/** Subscribe to live events while enabled; cb identity may change freely. */
export function useLiveEvents(
  cb: (events: LiveEvent[], dropped: number) => void,
  enabled: boolean,
): void {
  const cbRef = useRef(cb)
  cbRef.current = cb
  useEffect(() => {
    if (!enabled) return
    return liveFeed.onEvents((events, dropped) => cbRef.current(events, dropped))
  }, [enabled])
}
