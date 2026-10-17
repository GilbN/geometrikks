/**
 * Server locations: resolving a request's destination and the set of
 * beacons to render. Pure; no React or map imports so it stays
 * unit-testable without a DOM.
 */

export type Coordinate = [longitude: number, latitude: number]

export interface SiteHomesData {
  locations: Array<{ server: string; latitude: number; longitude: number }>
  default: { latitude: number; longitude: number } | null
}

/** server -> [lng, lat]; unknown servers fall back to the default. */
export function buildHomeResolver(
  data: SiteHomesData | undefined,
): (server: string | null) => Coordinate | null {
  const byServer = new Map<string, Coordinate>(
    (data?.locations ?? []).map((serverLocation) => [
      serverLocation.server,
      [serverLocation.longitude, serverLocation.latitude] as Coordinate,
    ]),
  )
  const fallback: Coordinate | null = data?.default
    ? [data.default.longitude, data.default.latitude]
    : null
  return (server) => (server !== null && byServer.get(server)) || fallback
}

export interface HomeBeacon {
  coordinate: Coordinate
  /** Servers located at this coordinate; empty for a pure default. */
  servers: string[]
}

/** Distinct beacons: every server location plus the default when distinct,
 *  coincident locations merged into one beacon carrying all their servers. */
export function homeBeacons(data: SiteHomesData | undefined): HomeBeacon[] {
  const byKey = new Map<string, HomeBeacon>()
  const upsert = (c: Coordinate, server?: string) => {
    const key = `${c[0]},${c[1]}`
    let beacon = byKey.get(key)
    if (!beacon) {
      beacon = { coordinate: c, servers: [] }
      byKey.set(key, beacon)
    }
    if (server) beacon.servers.push(server)
  }
  if (data?.default) upsert([data.default.longitude, data.default.latitude])
  for (const serverLocation of data?.locations ?? []) {
    upsert([serverLocation.longitude, serverLocation.latitude], serverLocation.server)
  }
  return [...byKey.values()]
}

/** Beacon tooltip copy. Says "site", not "home": a site can be a
 *  datacenter or VPS just as well as a house. */
export function beaconLabel(beacon: HomeBeacon): string {
  if (beacon.servers.length === 0) return "Server location"
  return `Site location: ${beacon.servers.join(", ")}`
}
