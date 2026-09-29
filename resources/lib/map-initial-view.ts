/**
 * Where the map opens: the configured MAP_DEFAULT_VIEW, else the selected
 * source's home, else every home in view, else the whole world. Pure; no
 * React or map imports so it stays unit-testable without a DOM.
 */

import { buildHomeResolver, homeBeacons, type Coordinate, type SiteHomesData } from "@/lib/site-homes"

export interface MapView {
  longitude: number
  latitude: number
  zoom: number
}

export const WORLD_VIEW: MapView = { longitude: 0, latitude: 20, zoom: 1.5 }
/** Zoom for a single home. It shows the region around it, not the street. */
export const HOME_ZOOM = 3
/** Cap for fitting several homes, so two sites in one city don't open at street level. */
export const FIT_MAX_ZOOM = 4
export const FIT_PADDING = 60

// MapLibre draws 512px tiles, and Web Mercator ends at this latitude.
const TILE_SIZE = 512
const MAX_LATITUDE = 85.051129

export interface Padding {
  top: number
  right: number
  bottom: number
  left: number
}

export interface InitialMapViewInput {
  defaultView: MapView | null | undefined
  siteHomes: SiteHomesData | undefined
  selectedSources: string[]
  /** Map container size in pixels, for fitting several homes. */
  size: { width: number; height: number }
  /** Pixels to keep homes away from each edge. Defaults to FIT_PADDING on every side. */
  padding?: Padding
}

export function initialMapView({
  defaultView,
  siteHomes,
  selectedSources,
  size,
  padding = { top: FIT_PADDING, right: FIT_PADDING, bottom: FIT_PADDING, left: FIT_PADDING },
}: InitialMapViewInput): MapView {
  if (defaultView) return defaultView

  // Like the "go home" control, one selected source opens on its own
  // home, or on the default home when it has none.
  if (selectedSources.length === 1) {
    const home = buildHomeResolver(siteHomes)(selectedSources[0])
    if (home) return centerOn(home)
  }

  const coordinates = homeBeacons(siteHomes).map((beacon) => beacon.coordinate)
  if (coordinates.length === 0) return WORLD_VIEW
  if (coordinates.length === 1) return centerOn(coordinates[0])
  return fit(coordinates, size, padding)
}

function centerOn([longitude, latitude]: Coordinate): MapView {
  return { longitude, latitude, zoom: HOME_ZOOM }
}

/** Center and zoom that keep every coordinate inside the padded container.
 *  Uneven padding shifts the center away from the wider side. */
function fit(coordinates: Coordinate[], size: { width: number; height: number }, padding: Padding): MapView {
  const [west, east] = longitudeSpan(coordinates.map(([longitude]) => longitude))
  const minX = mercatorX(west)
  const maxX = mercatorX(east)
  let minY = Infinity, maxY = -Infinity
  for (const [, latitude] of coordinates) {
    const y = mercatorY(latitude)
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }

  // A container with no room inside the padding hasn't been laid out yet.
  // Fit the plain box there, since a padding shift would only move the
  // homes away.
  const roomy =
    size.width > padding.left + padding.right && size.height > padding.top + padding.bottom
  const pad = roomy ? padding : { top: 0, right: 0, bottom: 0, left: 0 }
  const width = Math.max(size.width - pad.left - pad.right, 1)
  const height = Math.max(size.height - pad.top - pad.bottom, 1)
  const scaleX = maxX > minX ? width / ((maxX - minX) * TILE_SIZE) : Infinity
  const scaleY = maxY > minY ? height / ((maxY - minY) * TILE_SIZE) : Infinity
  // MapLibre zooms in until the world is at least as tall as the map, so a
  // lower zoom would be overridden with a different framing.
  const minZoom = Math.max(Math.log2(size.height / TILE_SIZE), 0)
  const zoom = Math.max(Math.min(Math.log2(Math.min(scaleX, scaleY)), FIT_MAX_ZOOM), minZoom)

  // Put the box's middle at the middle of the padded area. That point sits
  // off the container's middle by half the padding difference on each axis.
  const worldSize = TILE_SIZE * 2 ** zoom
  const shiftX = (pad.right - pad.left) / 2 / worldSize
  const shiftY = (pad.bottom - pad.top) / 2 / worldSize
  return {
    longitude: wrapLongitude(((minX + maxX) / 2 + shiftX) * 360 - 180),
    latitude: mercatorLatitude((minY + maxY) / 2 + shiftY),
    zoom,
  }
}

/** Narrowest [west, east] range that holds every longitude. It crosses the
 *  antimeridian when that is shorter, and east then goes past 180. */
function longitudeSpan(longitudes: number[]): [number, number] {
  const sorted = [...longitudes].sort((a, b) => a - b)
  let west = sorted[0]
  let east = sorted[sorted.length - 1]
  // The range leaves out the widest gap between neighbours. Leaving out
  // the gap across the antimeridian gives the plain box, which wins ties.
  let widestGap = sorted[0] + 360 - sorted[sorted.length - 1]
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1]
    if (gap > widestGap) {
      widestGap = gap
      west = sorted[i]
      east = sorted[i - 1] + 360
    }
  }
  return [west, east]
}

function wrapLongitude(longitude: number): number {
  return ((((longitude + 180) % 360) + 360) % 360) - 180
}

/** Web Mercator x, 0 at 180W and 1 at 180E. It goes past 1 east of the antimeridian. */
function mercatorX(longitude: number): number {
  return (longitude + 180) / 360
}

/** Web Mercator y in [0, 1] from north to south. */
function mercatorY(latitude: number): number {
  const clamped = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, latitude))
  const rad = (clamped * Math.PI) / 180
  return (1 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / Math.PI) / 2
}

function mercatorLatitude(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI
}
