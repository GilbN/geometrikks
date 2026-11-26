/**
 * The hour a chart's cursor sits on, kept outside React state so a pointer
 * move re-renders the cursor marks and the header readout, not the chart.
 * The value is the bucket's time in ms, so charts with the same buckets agree.
 */
import { useSyncExternalStore } from "react"

export type ChartCursor = {
  get: () => number | null
  set: (bucketMs: number | null) => void
  subscribe: (listener: () => void) => () => void
}

export function createChartCursor(): ChartCursor {
  let value: number | null = null
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return
      value = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function useCursorBucket(cursor: ChartCursor): number | null {
  return useSyncExternalStore(cursor.subscribe, cursor.get, cursor.get)
}
