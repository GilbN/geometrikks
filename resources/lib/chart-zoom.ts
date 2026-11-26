/**
 * Zooming the Analytics page to the hours dragged across a chart. Each zoom
 * sets a custom range and remembers the range it came from, so Zoom out can
 * go back. The stack lives in session storage, so a reload keeps it, and it
 * only counts while the page still shows the range the last zoom set: any
 * other range change forgets it.
 */
import { useCallback, useSyncExternalStore } from "react"
import type { CustomTimeRange, TimeRangeValue } from "@/lib/api"
import { useTimeRange } from "@/lib/time-range-context"

export type ZoomStep = {
  /** The range the page showed before this zoom. */
  from: { range: TimeRangeValue; customRange: CustomTimeRange | null }
  /** The custom range this zoom set. */
  to: CustomTimeRange
}

const STORAGE_KEY = "geometrikks-chart-zoom"

function read(): ZoomStep[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]")
    return Array.isArray(parsed) ? (parsed as ZoomStep[]) : []
  } catch {
    return []
  }
}

let steps: ZoomStep[] = read()
const listeners = new Set<() => void>()

function write(next: ZoomStep[]) {
  steps = next
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Blocked storage: the stack lasts until the page reloads.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const sameRange = (a: CustomTimeRange | null, b: CustomTimeRange | null) =>
  a != null && b != null && a.from === b.from && a.to === b.to

/** The zoom steps that still apply to the range on screen. */
export function liveSteps(
  stack: readonly ZoomStep[],
  range: TimeRangeValue,
  customRange: CustomTimeRange | null,
): readonly ZoomStep[] {
  const top = stack[stack.length - 1]
  return top && range === "custom" && sameRange(top.to, customRange) ? stack : []
}

export function useChartZoomStack() {
  const { range, customRange, setRange, setCustomRange } = useTimeRange()
  const stack = useSyncExternalStore(
    subscribe,
    () => steps,
    () => steps,
  )
  const live = liveSteps(stack, range, customRange)

  const zoomTo = useCallback(
    (fromMs: number, toMs: number) => {
      const to = { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() }
      write([...liveSteps(steps, range, customRange), { from: { range, customRange }, to }])
      setCustomRange(to)
    },
    [range, customRange, setCustomRange],
  )

  const zoomOut = useCallback(() => {
    const last = live[live.length - 1]
    if (!last) return
    write(live.slice(0, -1))
    if (last.from.range === "custom" && last.from.customRange) setCustomRange(last.from.customRange)
    else setRange(last.from.range)
  }, [live, setRange, setCustomRange])

  return { zoomTo, zoomOut, back: live[live.length - 1]?.from ?? null }
}
