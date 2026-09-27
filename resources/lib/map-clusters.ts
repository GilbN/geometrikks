import { Supercluster } from "@maplibre/geojson-vt"
import type { GeoJSONSource } from "maplibre-gl"
import type { Feature, GeoJsonProperties, Geometry, Point } from "geojson"

export type ClusterSource = Pick<GeoJSONSource, "getClusterExpansionZoom" | "getClusterChildren" | "getClusterLeaves">

/** A rendered feature near the target: a cluster or a lone point. */
export interface ClusterCandidate {
  properties: GeoJsonProperties
}

type Matches = (properties: GeoJsonProperties) => boolean

// A MapLibre GeoJSON source hands its clusterRadius to the index in tile
// units: 8192 per 512 pixel tile.
const TILE_EXTENT = 8192
const TILE_SIZE = 512
// The source's default 128 pixel tile buffer is a quarter of the world at
// zoom 0. Points that far from the antimeridian get a copy on the other
// side, which clusters with the points across it.
const WRAP_LONGITUDE = 180 - (128 / TILE_SIZE) * 360

function shifted(feature: Feature<Point>, degrees: number): Feature<Point> {
  const [longitude, ...rest] = feature.geometry.coordinates
  return { ...feature, geometry: { ...feature.geometry, coordinates: [longitude + degrees, ...rest] } }
}

const indexes = new WeakMap<Feature<Point>[], Supercluster>()

/**
 * The cluster index MapLibre builds for a GeoJSON source with these
 * options, from the same package, so it clusters exactly as the map draws.
 * Built once per features array, at about 60 ms per 10,000 points on a
 * desktop.
 */
export function clusterIndex(features: Feature<Point>[], radius: number, maxZoom: number): Supercluster {
  let index = indexes.get(features)
  if (!index) {
    index = new Supercluster({ maxZoom, minPoints: 2, extent: TILE_EXTENT, radius: (radius * TILE_EXTENT) / TILE_SIZE })
    // Same order as the source: west copies, the points, east copies.
    const points = features.filter((feature) => feature.geometry)
    index.load([
      ...points.filter((feature) => feature.geometry.coordinates[0] < -WRAP_LONGITUDE).map((feature) => shifted(feature, 360)),
      ...points,
      ...points.filter((feature) => feature.geometry.coordinates[0] >= WRAP_LONGITUDE).map((feature) => shifted(feature, -360)),
    ])
    indexes.set(features, index)
  }
  return index
}

/**
 * The lowest zoom, from `fromZoom` up, at which the point at `center` that
 * `matches` renders on its own, capped at `maxZoom`. `fromZoom` is kept when
 * its tiles already show the point alone.
 */
export function predictUnclusteredZoom(
  index: Supercluster,
  center: [longitude: number, latitude: number],
  matches: Matches,
  fromZoom: number,
  maxZoom: number,
): number {
  if (fromZoom >= maxZoom) return fromZoom
  // The index stores 32-bit projected coordinates, so the box leaves room
  // for the rounding.
  const [longitude, latitude] = center
  const box: [number, number, number, number] = [longitude - 1e-4, latitude - 1e-4, longitude + 1e-4, latitude + 1e-4]
  for (let zoom = Math.floor(fromZoom); zoom < maxZoom; zoom++) {
    const alone = index.getClusters(box, zoom).some((feature) => !feature.properties?.cluster && matches(feature.properties))
    if (alone) return Math.max(zoom, fromZoom)
  }
  return maxZoom
}

/**
 * The features within `radius` pixels of `center`, nearest first, measured
 * in Web Mercator pixels at the tile zoom that `zoom` renders. Longitudes
 * wrap, so a camera that flew across the antimeridian still measures the
 * short way.
 */
export function nearestFirst<T extends { geometry: Geometry }>(
  features: T[],
  center: [longitude: number, latitude: number],
  zoom: number,
  radius: number,
): T[] {
  const pixelsPerDegree = (512 * 2 ** Math.floor(zoom)) / 360
  const latitudeScale = 1 / Math.cos((center[1] * Math.PI) / 180)
  const distance = (feature: T) => {
    if (feature.geometry.type !== "Point") return Infinity
    const [longitude, latitude] = feature.geometry.coordinates
    const dx = ((((longitude - center[0]) % 360) + 540) % 360) - 180
    const dy = (latitude - center[1]) * latitudeScale
    return Math.hypot(dx, dy) * pixelsPerDegree
  }
  return features
    .map((feature) => ({ feature, distance: distance(feature) }))
    .filter((item) => item.distance <= radius)
    .sort((a, b) => a.distance - b.distance)
    .map((item) => item.feature)
}

function clusterId(properties: GeoJsonProperties): number | undefined {
  return properties?.cluster ? Number(properties.cluster_id) : undefined
}

async function clusterHolds(source: ClusterSource, properties: GeoJsonProperties, matches: Matches) {
  const leaves = await source.getClusterLeaves(Number(properties?.cluster_id), Number(properties?.point_count), 0)
  return leaves.some((leaf) => matches(leaf.properties))
}

/**
 * The lowest zoom at which the point that `matches` renders on its own,
 * capped at `maxZoom`. `candidates` are the features rendered around the
 * point at `currentZoom`, nearest first. A cluster is drawn at its
 * members' centroid, so the one holding the point need not sit on it.
 * Undefined when no candidate holds the point.
 */
export async function unclusteredZoom(
  source: ClusterSource,
  candidates: ClusterCandidate[],
  matches: Matches,
  currentZoom: number,
  maxZoom: number,
): Promise<number | undefined> {
  let cluster: number | undefined
  const checked = new Set<number>()
  for (const candidate of candidates) {
    const id = clusterId(candidate.properties)
    if (id === undefined) {
      if (matches(candidate.properties)) return currentZoom
      continue
    }
    // Tiles overlap, so one cluster can be rendered more than once.
    if (checked.has(id)) continue
    checked.add(id)
    if (await clusterHolds(source, candidate.properties, matches)) {
      cluster = id
      break
    }
  }
  while (cluster !== undefined) {
    const zoom = await source.getClusterExpansionZoom(cluster)
    if (zoom >= maxZoom) return maxZoom
    const children = await source.getClusterChildren(cluster)
    let next: number | undefined
    for (const child of children) {
      const id = clusterId(child.properties)
      if (id === undefined) {
        if (matches(child.properties)) return zoom
      } else if (children.length === 1 || (await clusterHolds(source, child.properties, matches))) {
        next = id
        break
      }
    }
    cluster = next
  }
  return undefined
}
