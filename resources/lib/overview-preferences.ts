import { useSyncExternalStore } from "react"

/** Whether the Overview cards draw their charts. On unless switched off. */
export const OVERVIEW_CHARTS_STORAGE_KEY = "geometrikks-overview-charts"

export function loadOverviewChartsPreference(): boolean {
  try {
    return localStorage.getItem(OVERVIEW_CHARTS_STORAGE_KEY) !== "false"
  } catch {
    return true
  }
}

export function saveOverviewChartsPreference(enabled: boolean): void {
  try {
    localStorage.setItem(OVERVIEW_CHARTS_STORAGE_KEY, String(enabled))
  } catch {
    // Storage may be blocked; keep the in-memory preference for this session.
  }
}

// The page header switch and the phone range drawer both set this, so it
// lives outside React and both read the same value.
const listeners = new Set<() => void>()
let current: boolean | undefined

function readCurrent(): boolean {
  current ??= loadOverviewChartsPreference()
  return current
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setOverviewCharts(enabled: boolean): void {
  current = enabled
  saveOverviewChartsPreference(enabled)
  listeners.forEach((listener) => listener())
}

export function useOverviewCharts(): [boolean, (enabled: boolean) => void] {
  return [useSyncExternalStore(subscribe, readCurrent, () => true), setOverviewCharts]
}
