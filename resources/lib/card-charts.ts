import { useSyncExternalStore } from "react"

/** The pages whose stat cards draw charts. Each keeps its own choice. */
export type CardChartsPage = "overview" | "geo-logs"

/** Whether a page's cards draw their charts. On unless switched off. */
export const CARD_CHARTS_STORAGE_KEYS: Record<CardChartsPage, string> = {
  overview: "geometrikks-overview-charts",
  "geo-logs": "geometrikks-geo-logs-charts",
}

export function loadCardChartsPreference(page: CardChartsPage): boolean {
  try {
    return localStorage.getItem(CARD_CHARTS_STORAGE_KEYS[page]) !== "false"
  } catch {
    return true
  }
}

export function saveCardChartsPreference(page: CardChartsPage, enabled: boolean): void {
  try {
    localStorage.setItem(CARD_CHARTS_STORAGE_KEYS[page], String(enabled))
  } catch {
    // Storage may be blocked; keep the in-memory preference for this session.
  }
}

// The page header switch and the phone range drawer both set this, so it
// lives outside React and both read the same value.
const listeners = new Set<() => void>()
const current = new Map<CardChartsPage, boolean>()

function readCurrent(page: CardChartsPage): boolean {
  let enabled = current.get(page)
  if (enabled === undefined) {
    enabled = loadCardChartsPreference(page)
    current.set(page, enabled)
  }
  return enabled
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setCardCharts(page: CardChartsPage, enabled: boolean): void {
  current.set(page, enabled)
  saveCardChartsPreference(page, enabled)
  listeners.forEach((listener) => listener())
}

export function useCardCharts(page: CardChartsPage): [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, () => readCurrent(page), () => true)
  return [enabled, (next: boolean) => setCardCharts(page, next)]
}
