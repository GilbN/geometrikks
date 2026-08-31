/** Pure helpers for the country choropleth: legend breaks, fill expression,
 * feature-state diffing. No MapLibre import so vitest runs without it. */

export interface CountryValue { id: string; value: number }

/** Smallest 1/2/5 x 10^k >= x. */
function ceil125(x: number): number {
  if (x <= 1) return 1
  const mag = 10 ** Math.floor(Math.log10(x))
  for (const m of [1, 2, 5, 10]) if (m * mag >= x) return m * mag
  return 10 * mag
}

/** Next value up the 1/2/5 sequence. */
function bump125(x: number): number {
  const mag = 10 ** Math.floor(Math.log10(x))
  const head = x / mag
  if (head < 2) return 2 * mag
  if (head < 5) return 5 * mag
  return 10 * mag
}

export function computeBreaks(max: number): [number, number, number, number, number] {
  if (max <= 0) return [1, 10, 100, 1000, 10000]
  const top = ceil125(max)
  // Bottom pinned to 1, decade steps up to the snapped top, then a walk that
  // bumps along the 1/2/5 ladder wherever the decade collapse made steps
  // collide (tiny maxima). The walk may push the last break past `top`,
  // which is fine: it stays >= max.
  const breaks = [
    1,
    Math.max(1, ceil125(top / 1000)),
    Math.max(1, ceil125(top / 100)),
    Math.max(1, ceil125(top / 10)),
    top,
  ]
  for (let i = 1; i < breaks.length; i++) {
    while (breaks[i] <= breaks[i - 1]) breaks[i] = bump125(breaks[i])
  }
  return breaks as [number, number, number, number, number]
}

export function buildFillColor(ramp: string[], breaks: number[], noData: string): unknown {
  const stops = breaks.flatMap((b, i) => [Math.log10(b), ramp[i]])
  return [
    "case",
    ["==", ["feature-state", "value"], null], noData,
    ["interpolate", ["linear"], ["log10", ["max", ["feature-state", "value"], 1]], ...stops],
  ]
}

interface FeatureStateMap {
  setFeatureState(target: { source: string; id: string }, state: { value: number }): void
  removeFeatureState(target: { source: string; id: string }): void
}

export function applyCountryValues(
  map: FeatureStateMap,
  source: string,
  prev: CountryValue[],
  next: CountryValue[],
): void {
  const nextIds = new Set(next.map((c) => c.id))
  for (const c of next) map.setFeatureState({ source, id: c.id }, { value: c.value })
  for (const c of prev) if (!nextIds.has(c.id)) map.removeFeatureState({ source, id: c.id })
}
