import { describe, expect, it, vi } from "vitest"
import { bannedClusterGroupIds, bannedGroupMembers, indexBannedFeatures, topBannedIps } from "./banned-map"
import type { BannedMapCollection, BannedMapFeature } from "@/generated/api/types.gen"

function feature(id: string, count: number): BannedMapFeature {
  return { type: "Feature", id, geometry: { type: "Point", coordinates: [10, 59] }, properties: {
    groupId: id, ipCount: count, bannedIps: Array.from({ length: count }, (_, i) => ({
      ip: `192.0.${id}.${i}`, locationId: i, city: "Oslo", countryCode: "NO", eventCount: i * Number(id),
    })),
  } }
}
const data: BannedMapCollection = {
  type: "FeatureCollection", features: [feature("1", 25), feature("2", 2)],
  stats: { ips: 27, locations: 2, events: 301, countries: 1, cities: 1 },
}

describe("banned map membership", () => {
  it("keeps every group member, independent of traffic rank and duplicate ids", () => {
    const index = indexBannedFeatures(data)
    const members = bannedGroupMembers(["1", "2", "1"], index)
    expect(members).toHaveLength(27)
    expect(members.slice(0, 3).map((m) => [m.ip, m.eventCount])).toEqual([["192.0.1.24", 24], ["192.0.1.23", 23], ["192.0.1.22", 22]])
    expect(bannedGroupMembers(["missing"], index)).toEqual([])
  })
  it("ranks the busiest IPs across groups and points each at its own group", () => {
    const top = topBannedIps(data, 3)
    expect(top.map((row) => [row.ipAddress, row.eventCount])).toEqual([["192.0.1.24", 24], ["192.0.1.23", 23], ["192.0.1.22", 22]])
    expect(top[0].location).toEqual({ id: 24, latitude: 59, longitude: 10, city: "Oslo", countryCode: "NO", countryName: null })
    expect(topBannedIps(undefined)).toEqual([])
  })
  it("reads every cluster leaf in one request and keeps only group ids", async () => {
    const source = { getClusterLeaves: vi.fn().mockResolvedValue([...data.features, { type: "Feature", properties: {} }]) }
    expect(await bannedClusterGroupIds(source, 17, 3)).toEqual(["1", "2"])
    expect(source.getClusterLeaves).toHaveBeenCalledWith(17, 3, 0)
  })
})
