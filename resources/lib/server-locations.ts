/**
 * Server locations: resolving a request's destination and the set of
 * beacons to render. Pure; no React or map imports so it stays
 * unit-testable without a DOM.
 */

export type Coordinate = [longitude: number, latitude: number]

export interface ServerLocationsData {
  locations: Array<{ server: string; latitude: number; longitude: number }>
  default: { latitude: number; longitude: number } | null
}

/** server -> [lng, lat]; unknown servers fall back to the default. */
export function buildServerLocationResolver(
  data: ServerLocationsData | undefined,
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

export interface ServerBeacon {
  coordinate: Coordinate
  /** Servers located at this coordinate; empty for a pure default. */
  servers: string[]
}

/** Distinct beacons: every server location plus the default when distinct,
 *  coincident locations merged into one beacon carrying all their servers. */
export function serverBeacons(data: ServerLocationsData | undefined): ServerBeacon[] {
  const byKey = new Map<string, ServerBeacon>()
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

export function beaconLabel(beacon: ServerBeacon): string {
  if (beacon.servers.length === 0) return "Server location"
  return `Server location: ${beacon.servers.join(", ")}`
}
