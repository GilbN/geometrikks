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

export interface HomeBeacon {
  coordinate: Coordinate
  /** Hostnames whose home sits at this coordinate; empty for a pure default. */
  hostnames: string[]
}

/** Distinct beacons: every site home plus the default when distinct,
 *  coincident homes merged into one beacon carrying all their hostnames. */
export function homeBeacons(data: SiteHomesData | undefined): HomeBeacon[] {
  const byKey = new Map<string, HomeBeacon>()
  const upsert = (c: Coordinate, hostname?: string) => {
    const key = `${c[0]},${c[1]}`
    let beacon = byKey.get(key)
    if (!beacon) {
      beacon = { coordinate: c, hostnames: [] }
      byKey.set(key, beacon)
    }
    if (hostname) beacon.hostnames.push(hostname)
  }
  if (data?.default) upsert([data.default.longitude, data.default.latitude])
  for (const h of data?.homes ?? []) upsert([h.longitude, h.latitude], h.hostname)
  return [...byKey.values()]
}

/** Beacon tooltip copy. Says "site", not "home": a site can be a
 *  datacenter or VPS just as well as a house. */
export function beaconLabel(beacon: HomeBeacon): string {
  if (beacon.hostnames.length === 0) return "Server location"
  return `Site location: ${beacon.hostnames.join(", ")}`
}
