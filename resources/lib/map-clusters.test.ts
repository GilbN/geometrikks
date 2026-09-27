import { describe, expect, it, vi } from "vitest"
import { GeoJSONVT, type Supercluster } from "@maplibre/geojson-vt"
import type { Feature, Point } from "geojson"
import { clusterIndex, nearestFirst, predictUnclusteredZoom, unclusteredZoom, type ClusterSource } from "./map-clusters"

const point = (id: number): Feature => ({ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { id } })

interface Node { expansion: number, children: number[], points: number[] }

// Cluster 1 (points 1-4) splits at zoom 9 into point 1 and cluster 2, which
// passes through the one-child cluster 3 and splits at zoom 12. Like
// MapLibre's index, the chain reports the zoom where it finally splits. Cluster 5
// holds points stacked on one coordinate, which never split.
const tree: Record<number, Node> = {
  1: { expansion: 9, children: [2], points: [1] },
  2: { expansion: 12, children: [3], points: [] },
  3: { expansion: 12, children: [4], points: [2] },
  4: { expansion: 14, children: [], points: [3, 4] },
  5: { expansion: 15, children: [], points: [5, 6] },
  6: { expansion: 8, children: [], points: [7, 8] },
}

function leaves(id: number): number[] {
  return [...tree[id].points, ...tree[id].children.flatMap(leaves)]
}

function cluster(id: number): Feature {
  return { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { cluster: true, cluster_id: id, point_count: leaves(id).length } }
}

function fakeSource() {
  return {
    getClusterExpansionZoom: vi.fn(async (id: number) => tree[id].expansion),
    getClusterChildren: vi.fn(async (id: number) => [...tree[id].points.map(point), ...tree[id].children.map(cluster)]),
    getClusterLeaves: vi.fn(async (id: number) => leaves(id).map(point)),
  } satisfies ClusterSource
}

const matching = (id: number) => (properties: Feature["properties"]) => properties?.id === id

describe("unclusteredZoom", () => {
  it("keeps the current zoom when the point already renders on its own", async () => {
    const source = fakeSource()
    expect(await unclusteredZoom(source, [cluster(1), point(9)], matching(9), 7, 15)).toBe(7)
    expect(source.getClusterLeaves).toHaveBeenCalledTimes(1)
  })

  it("stops at the zoom where a cluster first shows the point alone", async () => {
    expect(await unclusteredZoom(fakeSource(), [cluster(1)], matching(1), 7, 15)).toBe(9)
  })

  it("follows the branch that holds the point, through one-child clusters", async () => {
    expect(await unclusteredZoom(fakeSource(), [cluster(1)], matching(2), 7, 15)).toBe(12)
    expect(await unclusteredZoom(fakeSource(), [cluster(1)], matching(4), 7, 15)).toBe(14)
  })

  it("skips a nearer cluster that does not hold the point", async () => {
    const source = fakeSource()
    expect(await unclusteredZoom(source, [cluster(6), cluster(6), cluster(1)], matching(3), 7, 15)).toBe(14)
    expect(source.getClusterLeaves).toHaveBeenCalledWith(6, 2, 0)
    expect(source.getClusterLeaves.mock.calls.filter(([id]) => id === 6)).toHaveLength(1)
  })

  it("caps points that never split at the max zoom", async () => {
    expect(await unclusteredZoom(fakeSource(), [cluster(5)], matching(6), 7, 15)).toBe(15)
    expect(await unclusteredZoom(fakeSource(), [cluster(1)], matching(4), 7, 13)).toBe(13)
  })

  it("gives up when no candidate holds the point", async () => {
    expect(await unclusteredZoom(fakeSource(), [cluster(6), point(1)], matching(42), 7, 15)).toBeUndefined()
    expect(await unclusteredZoom(fakeSource(), [], matching(1), 7, 15)).toBeUndefined()
  })

  it("rejects when the source retired a cluster id mid-descent", async () => {
    const source = fakeSource()
    source.getClusterChildren.mockRejectedValueOnce(new Error("No cluster with the specified id."))
    await expect(unclusteredZoom(source, [cluster(1)], matching(2), 7, 15)).rejects.toThrow("No cluster")
  })
})

describe("nearestFirst", () => {
  const at = (id: number, longitude: number, latitude: number): Feature => ({
    type: "Feature", geometry: { type: "Point", coordinates: [longitude, latitude] }, properties: { id },
  })
  // At zoom 8 a degree of longitude is 512 * 256 / 360, about 364 pixels.
  const ids = (features: Feature[]) => features.map((feature) => feature.properties?.id)

  it("orders by distance and drops features beyond the radius", () => {
    const features = [at(1, 10.6, 0), at(2, 10.1, 0), at(3, 10, 0.2), at(4, 12, 0)]
    expect(ids(nearestFirst(features, [10, 0], 8, 200))).toEqual([2, 3])
    expect(ids(nearestFirst(features, [10, 0], 8, 500))).toEqual([2, 3, 1])
  })

  it("measures at the rendered tile zoom", () => {
    expect(ids(nearestFirst([at(1, 10.6, 0)], [10, 0], 8.9, 200))).toEqual([])
    expect(ids(nearestFirst([at(1, 10.6, 0)], [10, 0], 7.9, 200))).toEqual([1])
  })

  it("measures across the antimeridian the short way", () => {
    expect(ids(nearestFirst([at(1, -179.9, 0), at(2, 179.2, 0)], [179.9, 0], 8, 200))).toEqual([1])
  })

  it("stretches latitude like Web Mercator", () => {
    expect(ids(nearestFirst([at(1, 0, 60.3)], [0, 60], 8, 200))).toEqual([])
    expect(ids(nearestFirst([at(1, 0.3, 60)], [0, 60], 8, 200))).toEqual([1])
  })
})

describe("predictUnclusteredZoom", () => {
  const at = (id: number, longitude: number, latitude: number): Feature<Point> => ({
    type: "Feature", geometry: { type: "Point", coordinates: [longitude, latitude] }, properties: { id },
  })
  // 0.01 degrees apart at the equator: 0.01 * 512 * 2^z / 360 pixels, which
  // passes the 50 px radius at zoom 12.
  const pair = [at(1, 10, 0), at(2, 10.01, 0), at(3, 40, 20)]
  const index = clusterIndex(pair, 50, 14)
  const matching = (id: number) => (properties: Feature["properties"]) => properties?.id === id

  it("finds the zoom where the point leaves its cluster", () => {
    expect(predictUnclusteredZoom(index, [10, 0], matching(1), 7, 15)).toBe(12)
    expect(predictUnclusteredZoom(index, [10.01, 0], matching(2), 7, 15)).toBe(12)
  })

  it("keeps the starting zoom when the point is already alone", () => {
    expect(predictUnclusteredZoom(index, [40, 20], matching(3), 7.4, 15)).toBe(7.4)
    expect(predictUnclusteredZoom(index, [10, 0], matching(1), 12.6, 15)).toBe(12.6)
  })

  it("caps at the max zoom and never zooms out", () => {
    const stacked = clusterIndex([at(1, 5, 5), at(2, 5, 5)], 50, 14)
    expect(predictUnclusteredZoom(stacked, [5, 5], matching(1), 7, 15)).toBe(15)
    expect(predictUnclusteredZoom(index, [10, 0], matching(1), 7, 11)).toBe(11)
    expect(predictUnclusteredZoom(index, [10, 0], matching(1), 16, 15)).toBe(16)
  })

  it("reuses the index for the same features", () => {
    expect(clusterIndex(pair, 50, 14)).toBe(index)
  })

  it("agrees with the descent through the source's cluster API", async () => {
    // Seeded scatter over a few degrees, so the points break out at many zooms.
    let seed = 7
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    const points = Array.from({ length: 400 }, (_, i) => at(i, 10 + random() ** 3 * 4, 50 + random() ** 3 * 4))
    const dense = clusterIndex(points, 50, 14)
    const source: ClusterSource = {
      getClusterExpansionZoom: async (id) => dense.getClusterExpansionZoom(id) ?? 15,
      getClusterChildren: async (id) => dense.getChildren(id),
      getClusterLeaves: async (id, limit, offset) => dense.getLeaves(id, limit, offset),
    }
    const zooms = new Set<number>()
    for (const point of points.slice(0, 80)) {
      const center = point.geometry.coordinates as [number, number]
      const candidates = nearestFirst(dense.getClusters([0, 40, 20, 60], 7), center, 7, 200)
      const descended = await unclusteredZoom(source, candidates, matching(point.properties?.id), 7, 15)
      const predicted = predictUnclusteredZoom(dense, center, matching(point.properties?.id), 7, 15)
      expect(predicted).toBe(descended)
      zooms.add(predicted)
    }
    expect(zooms.size).toBeGreaterThan(4)
  })

  it("clusters like the index MapLibre's GeoJSON source builds", () => {
    let seed = 11
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    // Dense spots straddling the antimeridian and in open ocean.
    const points = Array.from({ length: 600 }, (_, i) => {
      const [longitude, latitude] = i % 3 === 0 ? [180, -17] : i % 3 === 1 ? [-100, 40] : [30, 10]
      const spread = random() ** 3 * 3
      const lng = longitude + (random() - 0.5) * spread
      return at(i, lng > 180 ? lng - 360 : lng, latitude + (random() - 0.5) * spread)
    })
    // The options maplibre-gl 6 passes for a clustered source with the
    // default buffer, tolerance and maxzoom.
    const vt = new GeoJSONVT({ type: "FeatureCollection", features: points }, {
      buffer: 2048, tolerance: 6, extent: 8192, maxZoom: 18, lineMetrics: false, generateId: false,
      cluster: true, updateable: true,
      clusterOptions: { maxZoom: 14, minPoints: 2, extent: 8192, radius: 800, log: false, generateId: false },
    })
    const worker = (vt as unknown as { tileIndex: Supercluster }).tileIndex
    const local = clusterIndex(points, 50, 14)
    const zooms = new Set<number>()
    for (const point of points) {
      const center = point.geometry.coordinates as [number, number]
      const expected = predictUnclusteredZoom(worker, center, matching(point.properties?.id), 7, 15)
      expect(predictUnclusteredZoom(local, center, matching(point.properties?.id), 7, 15)).toBe(expected)
      zooms.add(expected)
    }
    expect(zooms.size).toBeGreaterThan(4)
  })
})
