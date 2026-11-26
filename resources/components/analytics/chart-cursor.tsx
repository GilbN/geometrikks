/**
 * Where the traffic charts' cursor sits, kept outside React state so a
 * pointer move re-renders the cursor marks and the header readouts, not the
 * charts. Times are bucket starts in ms, so charts with the same buckets
 * agree. The Analytics page shares one cursor across its charts.
 */
import { createContext, useContext, useState, useSyncExternalStore } from "react"

/** Buckets from `from` to `to`, both starts, picked by a drag on chart `source`. */
export type CursorDrag = { source: string; from: number; to: number }

type CursorState = { bucket: number | null; drag: CursorDrag | null }

export type ChartCursor = {
  get: () => CursorState
  /** The hovered bucket. Ignored while a drag runs. */
  set: (bucket: number | null) => void
  setDrag: (drag: CursorDrag | null) => void
  subscribe: (listener: () => void) => () => void
}

export function createChartCursor(): ChartCursor {
  let state: CursorState = { bucket: null, drag: null }
  const listeners = new Set<() => void>()
  const update = (next: CursorState) => {
    if (next.bucket === state.bucket && next.drag === state.drag) return
    state = next
    for (const listener of listeners) listener()
  }
  return {
    get: () => state,
    set: (bucket) => {
      if (!state.drag) update({ ...state, bucket })
    },
    setDrag: (drag) => update({ bucket: null, drag }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** Zooms the page to the buckets from `fromMs` up to, not including, `toMs`. */
export type ChartZoom = (fromMs: number, toMs: number) => void

const SharedCursor = createContext<{ cursor: ChartCursor; zoom?: ChartZoom } | null>(null)

/** One cursor for every traffic chart inside, and drag to zoom when `zoom` is given. */
export function ChartCursorProvider({
  zoom,
  children,
}: {
  zoom?: ChartZoom
  children: React.ReactNode
}) {
  const [cursor] = useState(createChartCursor)
  return <SharedCursor.Provider value={{ cursor, zoom }}>{children}</SharedCursor.Provider>
}

/** The page's shared cursor, or one of the chart's own outside a provider. */
export function useChartCursor(): ChartCursor {
  const shared = useContext(SharedCursor)
  const [own] = useState(createChartCursor)
  return shared?.cursor ?? own
}

export function useChartZoom(): ChartZoom | undefined {
  return useContext(SharedCursor)?.zoom
}

export function useCursorBucket(cursor: ChartCursor): number | null {
  return useSyncExternalStore(
    cursor.subscribe,
    () => cursor.get().bucket,
    () => cursor.get().bucket,
  )
}

export function useCursorDrag(cursor: ChartCursor): CursorDrag | null {
  return useSyncExternalStore(
    cursor.subscribe,
    () => cursor.get().drag,
    () => cursor.get().drag,
  )
}
