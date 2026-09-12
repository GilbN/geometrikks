import type { GeoJSONSource } from "maplibre-gl"
import type { BannedMapCollection, BannedMapFeature, BannedMapIp } from "@/generated/api/types.gen"
import type { TopIPDTO } from "@/lib/api"

/** A banned-marker selection: the backend coordinate groups under the click. */
export interface BannedPopupInfo {
  longitude: number
  latitude: number
  groupIds: string[]
}

export function indexBannedFeatures(data: BannedMapCollection | undefined) {
  return new Map(data?.features.map((feature) => [feature.properties.groupId, feature]))
}

/** Members of the given groups, deduplicated and in the backend's order
 *  (busiest first, then by address); unknown ids are skipped. */
export function bannedGroupMembers(ids: Iterable<string>, index: Map<string, BannedMapFeature>): BannedMapIp[] {
  const ips = new Map<string, BannedMapIp>()
  for (const id of ids) {
    for (const member of index.get(id)?.properties.bannedIps ?? []) ips.set(member.ip, member)
  }
  return [...ips.values()].sort((a, b) => b.eventCount - a.eventCount || a.ip.localeCompare(b.ip))
}

/** The busiest mapped IPs, in the shape the controls' Top IPs rows already
 *  render, so the list flies to the IP's coordinate group. */
export function topBannedIps(data: BannedMapCollection | undefined, limit = 5): TopIPDTO[] {
  const rows: TopIPDTO[] = []
  for (const feature of data?.features ?? []) {
    const [longitude, latitude] = feature.geometry.coordinates
    for (const ip of feature.properties.bannedIps) {
      rows.push({
        ipAddress: ip.ip,
        eventCount: ip.eventCount,
        location: { id: ip.locationId, latitude, longitude, city: ip.city, countryCode: ip.countryCode, countryName: null },
      })
    }
  }
  return rows.sort((a, b) => b.eventCount - a.eventCount || a.ipAddress.localeCompare(b.ipAddress)).slice(0, limit)
}

/** Group ids of every leaf in a cluster. Leaves are coordinate groups, so
 *  the popup must expand them through the index to reach each IP. */
export async function bannedClusterGroupIds(
  source: Pick<GeoJSONSource, "getClusterLeaves">,
  clusterId: number,
  leafCount: number,
): Promise<string[]> {
  const leaves = await source.getClusterLeaves(clusterId, leafCount, 0)
  return leaves.flatMap((leaf) => (typeof leaf.properties?.groupId === "string" ? [leaf.properties.groupId] : []))
}
