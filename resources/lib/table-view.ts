/**
 * How a table looks, chosen from its View menu. Row density and the column
 * layout are kept per table; the time format is one choice for every table,
 * so two pages never show the same moment two ways. All of it lives in this
 * browser's localStorage, and every mounted table follows a change at once.
 */
import { useCallback, useSyncExternalStore } from "react"

export type RowDensity = "comfortable" | "compact"
export type ColumnLayout = "combined" | "separate"
export type TimeFormat = "short24" | "browser"

export interface TableViewChoice {
  density?: RowDensity
  layout?: ColumnLayout
}

const TABLE_KEY_PREFIX = "geometrikks-table-view-"
const TIME_FORMAT_KEY = "geometrikks-time-format"

const listeners = new Set<() => void>()
const cache = new Map<string, string | null>()

function read(key: string): string | null {
  if (!cache.has(key)) {
    let value: string | null = null
    try {
      value = localStorage.getItem(key)
    } catch {
      // Blocked storage: the defaults apply.
    }
    cache.set(key, value)
  }
  return cache.get(key) ?? null
}

function write(key: string, value: string | null): void {
  cache.set(key, value)
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Keep the in-memory choice for this session.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === TIME_FORMAT_KEY ||
      event.key.startsWith(TABLE_KEY_PREFIX)
    ) {
      if (event.key === null) cache.clear()
      else cache.delete(event.key)
      listener()
    }
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

/** Drops anything a hand-edited or older value holds that isn't a choice. */
export function parseTableView(raw: string | null): TableViewChoice {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    const { density, layout } = parsed as Record<string, unknown>
    return {
      ...(density === "comfortable" || density === "compact" ? { density } : {}),
      ...(layout === "combined" || layout === "separate" ? { layout } : {}),
    }
  } catch {
    return {}
  }
}

/** Compact suits a mouse; a finger needs the taller comfortable rows. */
export function defaultDensity(): RowDensity {
  return typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches
    ? "comfortable"
    : "compact"
}

export function useTableView(tableId: string) {
  const key = TABLE_KEY_PREFIX + tableId
  const raw = useSyncExternalStore(subscribe, () => read(key))
  const choice = parseTableView(raw)
  const update = useCallback(
    (patch: TableViewChoice) => {
      const next = { ...parseTableView(read(key)), ...patch }
      write(key, Object.keys(next).length ? JSON.stringify(next) : null)
    },
    [key],
  )
  const setDensity = useCallback((density: RowDensity) => update({ density }), [update])
  const setLayout = useCallback((layout: ColumnLayout) => update({ layout }), [update])
  const resetView = useCallback(() => write(key, null), [key])
  return {
    density: choice.density ?? defaultDensity(),
    layout: choice.layout ?? "combined",
    hasViewOverrides: raw !== null,
    setDensity,
    setLayout,
    resetView,
  }
}

export function useTimeFormat(): [TimeFormat, (format: TimeFormat) => void] {
  const raw = useSyncExternalStore(subscribe, () => read(TIME_FORMAT_KEY))
  const format: TimeFormat = raw === "browser" ? "browser" : "short24"
  const setFormat = useCallback(
    (next: TimeFormat) => write(TIME_FORMAT_KEY, next === "short24" ? null : next),
    [],
  )
  return [format, setFormat]
}

/** Compact rows fill a laptop screen at 50; comfortable rows keep 20. */
export function defaultPageSize(density: RowDensity): number {
  return density === "compact" ? 50 : 20
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const pad = (value: number) => String(value).padStart(2, "0")

function clock(date: Date, seconds = true): string {
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return seconds ? `${time}:${pad(date.getSeconds())}` : time
}

function day(date: Date, now: Date): string {
  const base = `${MONTHS[date.getMonth()]} ${date.getDate()}`
  return date.getFullYear() === now.getFullYear() ? base : `${base} ${date.getFullYear()}`
}

/**
 * A table cell's timestamp. 24-hour reads "Nov 14 16:41:40", with the year
 * only outside the current one. The browser format is toLocaleString. The full stamp belongs in the cell's tooltip.
 */
export function formatTableTime(
  value: string | number | Date,
  format: TimeFormat,
  now: Date = new Date(),
): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  if (format === "browser") return date.toLocaleString()
  return `${day(date, now)} ${clock(date)}`
}

/** A time of day alone, as in a live tail. */
export function formatClockTime(value: string | number | Date, format: TimeFormat): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  return format === "browser" ? date.toLocaleTimeString() : clock(date)
}

/** The full stamp for a tooltip: the browser's own long form, with the year. */
export function fullTimestamp(value: string | number | Date): string | undefined {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString()
}

export { clock as formatClock24, day as formatDay }
