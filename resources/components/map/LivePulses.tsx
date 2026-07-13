/**
 * Animated live network routes.
 *
 * Each geo event becomes a great-circle route from the request origin to the
 * configured server home. A single GeoJSON source and rAF loop drive every
 * layer so concurrent traffic remains inexpensive for MapLibre to render.
 */
import { useCallback, useEffect, useRef } from "react"
import { Layer, Source, useMap } from "react-map-gl/maplibre"
import type { GeoJSONSource } from "maplibre-gl"
import { useLiveEvents } from "@/lib/live-feed-context"
import {
  DEMO_TRAFFIC_ORIGINS,
  type DemoTrafficMode,
} from "@/lib/demo-traffic"

type Coordinate = [longitude: number, latitude: number]

interface Transmission {
  born: number
  duration: number
  lane: string
  route: Coordinate[]
}

const SOURCE_ID = "live-routes"
const MAX_TRANSMISSIONS = 32
// Only one route, packet, and origin marker is drawn for each nearby origin
// corridor. This prevents MapLibre alpha-blending a pile of identical (or
// nearly identical) effects into thick, bright routes and packet blooms.
const MAX_VISIBLE_LANES = 8
const ROUTE_SAMPLES = 48
const ARRIVAL_LINGER_MS = 900
const EARTH_RADIUS_KM = 6371

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value))
}

function toRadians(value: number): number {
  return value * Math.PI / 180
}

function toDegrees(value: number): number {
  return value * 180 / Math.PI
}

/** Spherical interpolation produces a natural global arc rather than a flat diagonal. */
function greatCircleRoute(origin: Coordinate, destination: Coordinate): Coordinate[] {
  const [originLng, originLat] = origin.map(toRadians) as Coordinate
  const [destinationLng, destinationLat] = destination.map(toRadians) as Coordinate
  const a: [number, number, number] = [
    Math.cos(originLat) * Math.cos(originLng),
    Math.cos(originLat) * Math.sin(originLng),
    Math.sin(originLat),
  ]
  const b: [number, number, number] = [
    Math.cos(destinationLat) * Math.cos(destinationLng),
    Math.cos(destinationLat) * Math.sin(destinationLng),
    Math.sin(destinationLat),
  ]
  const omega = Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1))
  const sinOmega = Math.sin(omega)
  const points: Coordinate[] = []

  for (let index = 0; index <= ROUTE_SAMPLES; index += 1) {
    const progress = index / ROUTE_SAMPLES
    let x: number
    let y: number
    let z: number
    if (sinOmega < 0.000001) {
      x = a[0] + (b[0] - a[0]) * progress
      y = a[1] + (b[1] - a[1]) * progress
      z = a[2] + (b[2] - a[2]) * progress
    } else {
      const fromWeight = Math.sin((1 - progress) * omega) / sinOmega
      const toWeight = Math.sin(progress * omega) / sinOmega
      x = a[0] * fromWeight + b[0] * toWeight
      y = a[1] * fromWeight + b[1] * toWeight
      z = a[2] * fromWeight + b[2] * toWeight
    }

    let longitude = toDegrees(Math.atan2(y, x))
    const latitude = toDegrees(Math.atan2(z, Math.hypot(x, y)))
    const previous = points.at(-1)
    if (previous) {
      while (longitude - previous[0] > 180) longitude -= 360
      while (longitude - previous[0] < -180) longitude += 360
    }
    points.push([longitude, latitude])
  }
  return points
}

function routeDistanceKm(route: Coordinate[]): number {
  const [startLng, startLat] = route[0].map(toRadians)
  const [endLng, endLat] = route.at(-1)!.map(toRadians)
  const deltaLng = endLng - startLng
  const centralAngle = Math.acos(clamp(
    Math.sin(startLat) * Math.sin(endLat)
      + Math.cos(startLat) * Math.cos(endLat) * Math.cos(deltaLng),
    -1,
    1,
  ))
  return centralAngle * EARTH_RADIUS_KM
}

/**
 * Group close origins into a stable visual corridor. The packet still uses
 * its precise coordinate; the grouping only controls the route line drawn
 * behind it.
 */
function routeLane(origin: Coordinate): string {
  const [longitude, latitude] = origin
  return `${Math.round(longitude / 8)}:${Math.round(latitude / 6)}`
}

/**
 * Keep packet markers apart when separate routes converge. Longitude cells
 * shrink toward the poles so each cell remains roughly square on the earth.
 */
function packetCell([longitude, latitude]: Coordinate): string {
  const cellSizeDegrees = 0.9
  const longitudeScale = Math.max(Math.cos(toRadians(latitude)), 0.1)
  return `${Math.round(latitude / cellSizeDegrees)}:${Math.round(
    longitude * longitudeScale / cellSizeDegrees,
  )}`
}

function pointAlongRoute(route: Coordinate[], progress: number): {
  point: Coordinate
  travelled: Coordinate[]
} {
  const position = clamp(progress) * (route.length - 1)
  const index = Math.min(Math.floor(position), route.length - 2)
  const fraction = position - index
  const from = route[index]
  const to = route[index + 1]
  const point: Coordinate = [
    from[0] + (to[0] - from[0]) * fraction,
    from[1] + (to[1] - from[1]) * fraction,
  ]
  // Keep the final route sample as the interpolated packet position. This
  // creates one shallow coordinate array, rather than a slice plus a second
  // spread-created array, for every active route on every animation frame.
  const travelled = route.slice(0, index + 2)
  travelled[index + 1] = point
  return { point, travelled }
}

function smootherStep(value: number): number {
  const progress = clamp(value)
  return progress * progress * progress * (progress * (progress * 6 - 15) + 10)
}

function emptyFeatureCollection(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] }
}

function buildFrame(
  transmissions: Transmission[],
  destination: Coordinate,
  now: number,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = []
  let strongestArrival = 0
  const visibleTransmissions = new Set<Transmission>()
  const visibleLanes = new Set<string>()
  const visiblePacketCells = new Set<string>()

  // Prefer the most recent packet in each corridor. Working backwards makes
  // each corridor look live without rendering overlapping copies of its line.
  for (let index = transmissions.length - 1; index >= 0; index -= 1) {
    const transmission = transmissions[index]
    if (visibleLanes.has(transmission.lane) || visibleLanes.size >= MAX_VISIBLE_LANES) continue
    visibleLanes.add(transmission.lane)
    visibleTransmissions.add(transmission)
  }

  for (const transmission of transmissions) {
    const elapsed = now - transmission.born
    const linearProgress = clamp(elapsed / transmission.duration)
    const progress = smootherStep(linearProgress)
    const { point, travelled } = pointAlongRoute(transmission.route, progress)
    const linger = clamp((elapsed - transmission.duration) / ARRIVAL_LINGER_MS)
    const opacity = elapsed <= transmission.duration ? 1 : 1 - linger
    const originWave = (elapsed % 1050) / 1050
    const packetPulse = (Math.sin(elapsed / 105) + 1) / 2
    strongestArrival = Math.max(strongestArrival, linger > 0 ? 1 - linger : 0)

    if (visibleTransmissions.has(transmission)) {
      features.push(
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: transmission.route },
          properties: { kind: "route", opacity },
        },
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: travelled },
          properties: { kind: "trail", opacity },
        },
      )
    }

    if (visibleTransmissions.has(transmission)) {
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: transmission.route[0] },
        properties: { kind: "origin", opacity, pulse: originWave },
      })
    }

    const shouldShowPacket = linearProgress < 1
      && visibleTransmissions.has(transmission)
      && !visiblePacketCells.has(packetCell(point))
    if (shouldShowPacket) {
      visiblePacketCells.add(packetCell(point))
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: point },
        properties: { kind: "packet", opacity, pulse: packetPulse },
      })
    }
  }

  if (transmissions.length > 0) {
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: destination },
      properties: {
        kind: "destination",
        opacity: 1,
        pulse: (Math.sin(now / 220) + 1) / 2,
        arrival: strongestArrival,
      },
    })
  }

  return { type: "FeatureCollection", features }
}

export function LivePulses({
  enabled,
  destination,
  demoMode = "off",
}: {
  enabled: boolean
  destination: Coordinate | null
  demoMode?: DemoTrafficMode
}) {
  const { current: map } = useMap()
  const transmissions = useRef<Transmission[]>([])
  const raf = useRef<number>(0)
  const prefersReducedMotion = useRef(false)

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => { prefersReducedMotion.current = media.matches }
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])

  const enqueueOrigins = useCallback((origins: readonly Coordinate[]) => {
    if (!destination) return
    const now = performance.now()
    for (const origin of origins) {
      const route = greatCircleRoute(origin, destination)
      const distance = routeDistanceKm(route)
      const duration = prefersReducedMotion.current
        ? 1100
        : clamp(2600 + Math.sqrt(distance) * 38, 2800, 6500)
      transmissions.current.push({
        born: now,
        duration,
        lane: routeLane(origin),
        route,
      })
    }
    if (transmissions.current.length > MAX_TRANSMISSIONS) {
      transmissions.current = transmissions.current.slice(-MAX_TRANSMISSIONS)
    }
  }, [destination])

  useLiveEvents((events) => {
    enqueueOrigins(events.flatMap((event) => (
      event.type === "geo_event"
        ? [[event.data.longitude, event.data.latitude] as Coordinate]
        : []
    )))
  }, enabled && destination !== null && demoMode === "off")

  useEffect(() => {
    if (!enabled || !destination || demoMode === "off") return

    let cursor = 0
    const emit = () => {
      const count = demoMode === "burst" ? 4 : 1
      const origins: Coordinate[] = []
      for (let index = 0; index < count; index += 1) {
        origins.push(DEMO_TRAFFIC_ORIGINS[cursor % DEMO_TRAFFIC_ORIGINS.length].coordinates)
        cursor += 1
      }
      enqueueOrigins(origins)
    }

    const kickoff = window.setTimeout(emit, 250)
    const interval = window.setInterval(emit, demoMode === "burst" ? 2800 : 1100)
    return () => {
      window.clearTimeout(kickoff)
      window.clearInterval(interval)
    }
  }, [demoMode, destination, enabled, enqueueOrigins])

  useEffect(() => {
    transmissions.current = []
  }, [destination?.[0], destination?.[1]])

  useEffect(() => {
    if (!enabled || !destination) {
      transmissions.current = []
      return
    }
    const tick = () => {
      const now = performance.now()
      transmissions.current = transmissions.current.filter(
        ({ born, duration }) => now - born < duration + ARRIVAL_LINGER_MS,
      )
      const source = map?.getSource(SOURCE_ID) as GeoJSONSource | undefined
      source?.setData(buildFrame(transmissions.current, destination, now))
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [destination, enabled, map])

  if (!enabled || !destination) return null

  return (
    <Source id={SOURCE_ID} type="geojson" data={emptyFeatureCollection()}>
      <Layer
        id="live-route-underglow"
        type="line"
        filter={["==", ["get", "kind"], "route"]}
        paint={{
          "line-color": "#0891b2",
          "line-width": 8,
          "line-blur": 7,
          "line-opacity": ["*", ["get", "opacity"], 0.32],
        }}
      />
      <Layer
        id="live-route-circuit"
        type="line"
        filter={["==", ["get", "kind"], "route"]}
        paint={{
          "line-color": "#22d3ee",
          "line-width": 1.25,
          "line-dasharray": [1, 2.2],
          "line-opacity": ["*", ["get", "opacity"], 0.48],
        }}
      />
      <Layer
        id="live-route-trail-glow"
        type="line"
        filter={["==", ["get", "kind"], "trail"]}
        paint={{
          "line-color": "#67e8f9",
          "line-width": 9,
          "line-blur": 8,
          "line-opacity": ["*", ["get", "opacity"], 0.5],
        }}
      />
      <Layer
        id="live-route-trail"
        type="line"
        filter={["==", ["get", "kind"], "trail"]}
        paint={{
          "line-color": "#cffafe",
          "line-width": 2,
          "line-opacity": ["*", ["get", "opacity"], 0.9],
        }}
      />
      <Layer
        id="live-origin-wave"
        type="circle"
        filter={["==", ["get", "kind"], "origin"]}
        paint={{
          "circle-radius": ["interpolate", ["linear"], ["get", "pulse"], 0, 5, 1, 30],
          "circle-color": "rgba(34, 211, 238, 0)",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#22d3ee",
          "circle-stroke-opacity": ["*", ["get", "opacity"], ["-", 1, ["get", "pulse"]]],
        }}
      />
      <Layer
        id="live-origin-core"
        type="circle"
        filter={["==", ["get", "kind"], "origin"]}
        paint={{
          "circle-radius": 4,
          "circle-color": "#ecfeff",
          "circle-blur": 0.15,
          "circle-opacity": ["get", "opacity"],
          "circle-stroke-width": 3,
          "circle-stroke-color": "#06b6d4",
          "circle-stroke-opacity": ["*", ["get", "opacity"], 0.7],
        }}
      />
      <Layer
        id="live-destination-beacon"
        type="circle"
        filter={["==", ["get", "kind"], "destination"]}
        paint={{
          "circle-radius": ["interpolate", ["linear"], ["get", "pulse"], 0, 7, 1, 11],
          "circle-color": "#0e7490",
          "circle-blur": 0.45,
          "circle-opacity": 0.6,
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#a5f3fc",
          "circle-stroke-opacity": 0.85,
        }}
      />
      <Layer
        id="live-destination-arrival"
        type="circle"
        filter={["==", ["get", "kind"], "destination"]}
        paint={{
          "circle-radius": ["interpolate", ["linear"], ["get", "arrival"], 0, 8, 1, 34],
          "circle-color": "rgba(103, 232, 249, 0)",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#67e8f9",
          "circle-stroke-opacity": ["get", "arrival"],
        }}
      />
      <Layer
        id="live-packet-aura"
        type="circle"
        filter={["==", ["get", "kind"], "packet"]}
        paint={{
          "circle-radius": ["interpolate", ["linear"], ["get", "pulse"], 0, 10, 1, 16],
          "circle-color": "#22d3ee",
          "circle-blur": 0.8,
          "circle-opacity": ["*", ["get", "opacity"], 0.72],
        }}
      />
      <Layer
        id="live-packet-core"
        type="circle"
        filter={["==", ["get", "kind"], "packet"]}
        paint={{
          "circle-radius": 4.5,
          "circle-color": "#ffffff",
          "circle-opacity": ["get", "opacity"],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#67e8f9",
          "circle-stroke-opacity": ["get", "opacity"],
        }}
      />
    </Source>
  )
}
