/**
 * Per-chart view and scale choice, persisted in localStorage. The stored
 * scale is the user's last explicit pick; a view that does not allow it
 * shows its own default instead, and the pick returns with a view that does.
 */
import { useState } from "react"

export type ChartScale = "clip" | "full" | "log"

const SCALES: readonly ChartScale[] = ["clip", "full", "log"]

export const CHART_SCALE_LABELS: Record<ChartScale, string> = {
  clip: "Linear, clip spikes",
  full: "Linear, full range",
  log: "Log",
}

export const CHART_SCALE_CHIPS: Record<ChartScale, string> = {
  clip: "Clip spikes",
  full: "Full range",
  log: "Log",
}

export type ChartViewSpec = {
  id: string
  label: string
  /** Short chip text when this view is active and not the default. */
  chip?: string
  /** First entry is the view's default scale. */
  scales: readonly ChartScale[]
  /** Extra line under a scale item, e.g. "Shows as lines". */
  scaleHints?: Partial<Record<ChartScale, string>>
  /** Replaces the Scale group when the view allows a single scale. */
  fixedScaleNote?: string
}

/** First view is the chart's default view. */
export type ChartOptionsSpec = { views: readonly ChartViewSpec[] }

export type ChartOptions = { view: string; scale: ChartScale }

export type ChartOptionsState = {
  view: ChartViewSpec
  scale: ChartScale
  isDefault: { view: boolean; scale: boolean }
  setView(id: string): void
  setScale(scale: ChartScale): void
}

type StorageLike = Pick<Storage, "getItem" | "setItem">

// Survives remounts when localStorage is blocked, for the rest of the page load.
const memory = new Map<string, unknown>()
// Charts whose last write failed; storage still holds an older choice for them.
const unsaved = new Set<string>()

export function chartOptionsStorageKey(chartId: string): string {
  return `geometrikks-chart-${chartId}`
}

function browserStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export function loadChartOptions(chartId: string, storage: StorageLike | undefined = browserStorage()): unknown {
  if (unsaved.has(chartId)) return memory.get(chartId)
  try {
    const text = storage?.getItem(chartOptionsStorageKey(chartId))
    if (text != null) {
      const parsed: unknown = JSON.parse(text)
      memory.set(chartId, parsed)
      return parsed
    }
  } catch {
    // Blocked storage or unparsable JSON: use this page load's copy, if any.
  }
  return memory.get(chartId)
}

export function saveChartOptions(
  chartId: string,
  options: ChartOptions,
  storage: StorageLike | undefined = browserStorage(),
): void {
  memory.set(chartId, options)
  try {
    storage?.setItem(chartOptionsStorageKey(chartId), JSON.stringify(options))
    unsaved.delete(chartId)
  } catch {
    // Storage may be blocked or full; the in-memory copy keeps the choice.
    unsaved.add(chartId)
  }
}

function findView(spec: ChartOptionsSpec, id: unknown): ChartViewSpec {
  return spec.views.find((view) => view.id === id) ?? spec.views[0]
}

/** Valid view and valid scale; the scale may not be allowed by the view. */
export function parseChartOptions(spec: ChartOptionsSpec, stored: unknown): ChartOptions {
  const record = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {}
  const view = findView(spec, record.view)
  const scale = SCALES.includes(record.scale as ChartScale) ? (record.scale as ChartScale) : view.scales[0]
  return { view: view.id, scale }
}

/** What the chart renders: the scale is always one the view allows. */
export function resolveChartOptions(spec: ChartOptionsSpec, stored: unknown): ChartOptions {
  const parsed = parseChartOptions(spec, stored)
  const view = findView(spec, parsed.view)
  return { view: view.id, scale: view.scales.includes(parsed.scale) ? parsed.scale : view.scales[0] }
}

export function chartOptionChips(state: Pick<ChartOptionsState, "view" | "scale" | "isDefault">): string[] {
  const chips: string[] = []
  if (!state.isDefault.view) chips.push(state.view.chip ?? state.view.label)
  if (!state.isDefault.scale) chips.push(CHART_SCALE_CHIPS[state.scale])
  return chips
}

export function chartOptionsLabel(title: string, chips: readonly string[]): string {
  return [`Chart options: ${title}`, ...chips].join(", ")
}

export function useChartOptions(chartId: string, spec: ChartOptionsSpec): ChartOptionsState {
  const [stored, setStored] = useState<ChartOptions>(() => parseChartOptions(spec, loadChartOptions(chartId)))
  const resolved = resolveChartOptions(spec, stored)
  const view = findView(spec, resolved.view)
  const update = (next: ChartOptions) => {
    setStored(next)
    saveChartOptions(chartId, next)
  }
  return {
    view,
    scale: resolved.scale,
    isDefault: { view: view.id === spec.views[0].id, scale: resolved.scale === view.scales[0] },
    setView: (id) => update({ ...stored, view: id }),
    setScale: (scale) => update({ ...stored, scale }),
  }
}
