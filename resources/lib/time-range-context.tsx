import { createContext, useContext, useState, useCallback, useEffect } from "react"
import type { TimeRangeValue } from "./api"

const STORAGE_KEY = "geometrikks-time-range"
const DEFAULT_RANGE: TimeRangeValue = "7d"
const DEFAULT_POLL_INTERVAL = 30000 // 30 seconds

interface TimeRangeState {
  range: TimeRangeValue
  pollInterval: number
  lastRefresh: number
}

interface TimeRangeContextValue extends TimeRangeState {
  setRange: (range: TimeRangeValue) => void
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
    const initial = {
      range: stored.range ?? DEFAULT_RANGE,
      pollInterval: stored.pollInterval ?? DEFAULT_POLL_INTERVAL,
      lastRefresh: Date.now(),
    }
    return initial
  })

  // Persist to localStorage when range, statsRange, or pollInterval changes
  useEffect(() => {
    saveToStorage({
      range: state.range,
      pollInterval: state.pollInterval,
    })
  }, [state.range, state.pollInterval])

  const setRange = useCallback((range: TimeRangeValue) => {
    setState((prev) => ({ ...prev, range, lastRefresh: Date.now() }))
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
