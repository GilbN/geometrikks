import { createContext, useContext, useState, useCallback, useEffect } from "react"
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

  return (
    <TimeRangeContext.Provider
      value={{
        ...state,
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
