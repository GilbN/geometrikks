import { createContext, useContext, useState, useCallback, useEffect } from "react"
import type { TimeRangeValue, StatsTimeRangeValue } from "./api"

const STORAGE_KEY = "geometrikks-time-range"
const DEFAULT_RANGE: TimeRangeValue = "7d"
const DEFAULT_STATS_RANGE: StatsTimeRangeValue = "24h"
const DEFAULT_POLL_INTERVAL = 30000 // 30 seconds

interface TimeRangeState {
  range: TimeRangeValue
  statsRange: StatsTimeRangeValue
  pollInterval: number
  lastRefresh: number
}

interface TimeRangeContextValue extends TimeRangeState {
  setRange: (range: TimeRangeValue) => void
  setStatsRange: (range: StatsTimeRangeValue) => void
  setPollInterval: (interval: number) => void
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
    return {
      range: stored.range ?? DEFAULT_RANGE,
      statsRange: (stored as Partial<TimeRangeState>).statsRange ?? DEFAULT_STATS_RANGE,
      pollInterval: stored.pollInterval ?? DEFAULT_POLL_INTERVAL,
      lastRefresh: Date.now(),
    }
  })

  // Persist to localStorage when range, statsRange, or pollInterval changes
  useEffect(() => {
    saveToStorage({
      range: state.range,
      statsRange: state.statsRange,
      pollInterval: state.pollInterval,
    })
  }, [state.range, state.statsRange, state.pollInterval])

  const setRange = useCallback((range: TimeRangeValue) => {
    setState((prev) => ({ ...prev, range, lastRefresh: Date.now() }))
  }, [])

  const setStatsRange = useCallback((statsRange: StatsTimeRangeValue) => {
    setState((prev) => ({ ...prev, statsRange, lastRefresh: Date.now() }))
  }, [])

  const setPollInterval = useCallback((pollInterval: number) => {
    setState((prev) => ({ ...prev, pollInterval }))
  }, [])

  const refresh = useCallback(() => {
    setState((prev) => ({ ...prev, lastRefresh: Date.now() }))
  }, [])

  return (
    <TimeRangeContext.Provider
      value={{
        ...state,
        setRange,
        setStatsRange,
        setPollInterval,
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
