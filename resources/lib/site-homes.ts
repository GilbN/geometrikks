/**
 * Per-source home locations: resolving a request's destination and the set
 * of home beacons to render. Pure; no React or map imports so it stays
 * unit-testable without a DOM.
 */

export type Coordinate = [longitude: number, latitude: number]

export interface SiteHomesData {
  homes: Array<{ hostname: string; latitude: number; longitude: number }>
  default: { latitude: number; longitude: number } | null
}

/** hostname -> [lng, lat]; unknown hostnames fall back to the default. */
export function buildHomeResolver(
  data: SiteHomesData | undefined,
): (hostname: string | null) => Coordinate | null {
  const byHost = new Map<string, Coordinate>(
    (data?.homes ?? []).map((h) => [h.hostname, [h.longitude, h.latitude] as Coordinate]),
  )
  const fallback: Coordinate | null = data?.default
    ? [data.default.longitude, data.default.latitude]
    : null
  return (hostname) => (hostname !== null && byHost.get(hostname)) || fallback
}

/** Distinct beacon coordinates: every site home plus the default when distinct. */
export function homeBeacons(data: SiteHomesData | undefined): Coordinate[] {
  const seen = new Set<string>()
  const out: Coordinate[] = []
  const push = (c: Coordinate) => {
    const key = `${c[0]},${c[1]}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(c)
    }
  }
  if (data?.default) push([data.default.longitude, data.default.latitude])
  for (const h of data?.homes ?? []) push([h.longitude, h.latitude])
  return out
}
