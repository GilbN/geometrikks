import { createContext, useContext, useState, useCallback, useEffect } from "react"
import { focusManager } from "@tanstack/react-query"
import type { ChartGranularity, CustomTimeRange, TimeRangeValue } from "./api"

const STORAGE_KEY = "geometrikks-time-range"
const DEFAULT_RANGE: TimeRangeValue = "7d"
const DEFAULT_POLL_INTERVAL = 30000 // 30 seconds
const DEFAULT_GRANULARITY: ChartGranularity = "auto"
const DEFAULT_CUSTOM_RANGE: CustomTimeRange | null = null

interface TimeRangeState {
  range: TimeRangeValue
  pollInterval: number
  lastRefresh: number
  granularity: ChartGranularity
  customRange: CustomTimeRange | null
}

interface TimeRangeContextValue extends TimeRangeState {
  /** What queries poll with: the auto refresh setting, or false while it is
   *  off or held. The pollInterval field stays the setting, for the controls. */
  refetchInterval: number | false
  /** Pauses auto refresh until the returned release runs. See usePollingHold. */
  holdPolling: () => () => void
  setRange: (range: TimeRangeValue) => void
  setPollInterval: (interval: number) => void
  setGranularity: (granularity: ChartGranularity) => void
  setCustomRange: (customRange: CustomTimeRange) => void
  refresh: () => void
}

const TimeRangeContext = createContext<TimeRangeContextValue | null>(null)

function loadFromStorage(): Partial<TimeRangeState> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      return JSON.parse(stored)
    }
  } catch {
    // Ignore parse errors
  }
  return {}
}

function saveToStorage(state: Partial<TimeRangeState>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Ignore storage errors
  }
}

export function TimeRangeProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<TimeRangeState>(() => {
    const stored = loadFromStorage()
    const initial = {
      range: stored.range ?? DEFAULT_RANGE,
      pollInterval: stored.pollInterval ?? DEFAULT_POLL_INTERVAL,
      lastRefresh: Date.now(),
      granularity: stored.granularity ?? DEFAULT_GRANULARITY,
      customRange: stored.customRange ?? DEFAULT_CUSTOM_RANGE,
    }
    return initial
  })

  // Persist to localStorage when range, statsRange, pollInterval, granularity, or customRange changes
  useEffect(() => {
    saveToStorage({
      range: state.range,
      pollInterval: state.pollInterval,
      granularity: state.granularity,
      customRange: state.customRange,
    })
  }, [state.range, state.pollInterval, state.granularity, state.customRange])

  const setRange = useCallback((range: TimeRangeValue) => {
    setState((prev) => ({ ...prev, range, lastRefresh: Date.now() }))
  }, [])

  const setPollInterval = useCallback((pollInterval: number) => {
    setState((prev) => ({ ...prev, pollInterval }))
  }, [])

  const setGranularity = useCallback((granularity: ChartGranularity) => {
    setState((prev) => ({ ...prev, granularity }))
  }, [])

  const setCustomRange = useCallback((customRange: CustomTimeRange) => {
    setState((prev) => ({ ...prev, range: "custom", customRange, lastRefresh: Date.now() }))
  }, [])

  const refresh = useCallback(() => {
    setState((prev) => ({ ...prev, lastRefresh: Date.now() }))
  }, [])

  const [holds, setHolds] = useState(0)
  const holdPolling = useCallback(() => {
    setHolds((count) => count + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      setHolds((count) => count - 1)
    }
  }, [])
  const refetchInterval = holds === 0 && state.pollInterval > 0 ? state.pollInterval : false
  // A held page also skips the refetch on returning to the tab. Reporting the
  // window as unfocused stops it; on release TanStack checks focus again and
  // refreshes what went stale.
  const held = holds > 0
  useEffect(() => {
    if (!held) return
    focusManager.setFocused(false)
    return () => focusManager.setFocused(undefined)
  }, [held])

  return (
    <TimeRangeContext.Provider
      value={{
        ...state,
        refetchInterval,
        holdPolling,
        setRange,
        setPollInterval,
        setGranularity,
        setCustomRange,
        refresh,
      }}
    >
      {children}
    </TimeRangeContext.Provider>
  )
}

export function useTimeRange() {
  const context = useContext(TimeRangeContext)
  if (!context) {
    throw new Error("useTimeRange must be used within a TimeRangeProvider")
  }
  return context
}

/**
 * Holds auto refresh while `active`. For menus and dialogs that belong to
 * a row: a refresh can push that row off the page (newer requests fill
 * page 1 of Access Logs from the top), and the row takes its open menu
 * with it.
 */
export function usePollingHold(active: boolean) {
  const { holdPolling } = useTimeRange()
  useEffect(() => (active ? holdPolling() : undefined), [active, holdPolling])
}
