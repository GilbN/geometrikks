/**
 * Stat-card wording for the selected time range.
 *
 * Duration presets read as a span ("Last 24h"); calendar presets already
 * name their span ("Last month", "Today"), so they take no prefix. The
 * comparison window is always the equal-length span before the range,
 * which only reads naturally as "last 24h" for a duration.
 */
import { TIME_RANGE_PRESETS, type TimeRangeValue } from "@/lib/api"

function isDuration(range: TimeRangeValue): boolean {
  const preset = TIME_RANGE_PRESETS.find((p) => p.value === range)
  return preset != null && preset.minutes > 0
}

function presetLabel(range: TimeRangeValue): string {
  return TIME_RANGE_PRESETS.find((p) => p.value === range)?.label ?? range
}

/** Card subtitle naming the span the value covers. */
export function rangeSubtitle(range: TimeRangeValue): string {
  if (range === "custom") return "Custom range"
  const label = presetLabel(range)
  return isDuration(range) ? `Last ${label}` : label
}

/** Card subtitle for a value shown against the span before the range. */
export function rangeCompareLabel(range: TimeRangeValue): string {
  return isDuration(range) ? `vs last ${presetLabel(range)}` : "vs previous period"
}
