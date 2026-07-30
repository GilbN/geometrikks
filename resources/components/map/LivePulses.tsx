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
import type { Feature, FeatureCollection } from "geojson"
import { packetColor, packetRadius, worseStatus } from "@/lib/live-traffic/classify"
import type { LiveRequest, StatusClass } from "@/lib/live-traffic/types"
import { useLiveTrafficStore } from "@/lib/live-traffic/context"
import { BANNED_RING_IMAGE_ID, ensureBannedRingImage } from "./bannedRingImage"

type Coordinate = [longitude: number, latitude: number]

interface Transmission {
  born: number
  duration: number
  lane: string
  route: Coordinate[]
  requestId: string
  color: string
  radius: number
  banned: boolean
  statusClass: StatusClass
}

const SOURCE_ID = "live-routes"
// Only one route, packet, and origin marker is drawn for each nearby origin
// corridor. This prevents MapLibre alpha-blending a pile of identical (or
// nearly identical) effects into thick, bright routes and packet blooms.
const MAX_VISIBLE_LANES = 8
// Do not start packets that cannot be rendered; retain one coalesced request
// per lane until a visible packet slot becomes available.
const MAX_ACTIVE_TRANSMISSIONS = MAX_VISIBLE_LANES
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

function emptyFeatureCollection(): FeatureCollection {
  return { type: "FeatureCollection", features: [] }
}

/** Build the transmission for one request. Returns null when it has nowhere to fly from. */
function createTransmission(
  request: LiveRequest,
  destination: Coordinate,
  now: number,
  reducedMotion: boolean,
): Transmission | null {
  const origin = request.coordinates
  if (!origin) return null

  const route = greatCircleRoute(origin, destination)
  const distance = routeDistanceKm(route)
  return {
    born: now,
    duration: reducedMotion ? 1100 : clamp(2600 + Math.sqrt(distance) * 38, 2800, 6500),
    lane: routeLane(origin),
    route,
    requestId: request.id,
    color: packetColor(request.statusClass),
    radius: packetRadius(request.log?.bytes_sent),
    banned: request.banned,
    statusClass: request.statusClass,
  }
}

function buildFrame(
  transmissions: Transmission[],
  destination: Coordinate,
  now: number,
): FeatureCollection {
  const features: Feature[] = []
  let strongestArrival = 0
  const visibleTransmissions = new Set<Transmission>()
  const visibleLanes = new Set<string>()
  const visiblePacketCells = new Set<string>()
  let arrivalStatus: StatusClass = "unknown"

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
    if (linger > 0) arrivalStatus = worseStatus(arrivalStatus, transmission.statusClass)

    if (visibleTransmissions.has(transmission)) {
      features.push(
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: transmission.route },
          properties: { kind: "route", opacity, color: transmission.color },
        },
        {
          type: "Feature",
          geometry: { type: "LineString", coordinates: travelled },
          properties: { kind: "trail", opacity, color: transmission.color },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: transmission.route[0] },
          properties: {
            kind: "origin",
            opacity,
            pulse: originWave,
            color: transmission.color,
            radius: transmission.radius,
            banned: transmission.banned ? 1 : 0,
            requestId: transmission.requestId,
          },
        },
      )
    }

    const shouldShowPacket = linearProgress < 1
      && visibleTransmissions.has(transmission)
      && !visiblePacketCells.has(packetCell(point))
    if (shouldShowPacket) {
      visiblePacketCells.add(packetCell(point))
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: point },
        properties: {
          kind: "packet",
          opacity,
          pulse: packetPulse,
          color: transmission.color,
          radius: transmission.radius,
          banned: transmission.banned ? 1 : 0,
          requestId: transmission.requestId,
        },
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
        arrivalColor: packetColor(arrivalStatus),
      },
    })
  }

  return { type: "FeatureCollection", features }
}

export function LivePulses({
  enabled,
  destination,
}: {
  enabled: boolean
  destination: Coordinate | null
}) {
  const { current: map } = useMap()
  const store = useLiveTrafficStore()
  const transmissions = useRef<Transmission[]>([])
  // A lane can have one packet in flight and one coalesced follow-up. Keeping
  // the newest request for that follow-up makes heavy traffic read as ongoing
  // activity without cutting off an already-visible packet.
  const queuedRequests = useRef<Map<string, LiveRequest>>(new Map())
  const raf = useRef<number>(0)
  const prefersReducedMotion = useRef(false)
  // Whether the source already holds an empty frame, so an idle map can skip
  // pushing another one.
  const sourceIsEmpty = useRef(true)

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => { prefersReducedMotion.current = media.matches }
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])

  useEffect(() => {
    const instance = map?.getMap()
    if (!instance) return
    ensureBannedRingImage(instance)
    // A style change drops registered images, so re-register on styledata.
    const reregister = () => ensureBannedRingImage(instance)
    instance.on("styledata", reregister)
    return () => {
      instance.off("styledata", reregister)
    }
  }, [map])

  const enqueueRequests = useCallback((requests: readonly LiveRequest[]) => {
    if (!destination) return
    const now = performance.now()
    for (const request of requests) {
      const transmission = createTransmission(
        request,
        destination,
        now,
        prefersReducedMotion.current,
      )
      if (!transmission) continue

      const laneIsActive = transmissions.current.some(
        (activeTransmission) => activeTransmission.lane === transmission.lane,
      )

      if (laneIsActive || transmissions.current.length >= MAX_ACTIVE_TRANSMISSIONS) {
        queuedRequests.current.set(transmission.lane, request)
      } else {
        transmissions.current.push(transmission)
      }
    }
  }, [destination])

  useEffect(() => {
    if (!enabled || !destination) return
    return store.onRequests((requests) => enqueueRequests(requests))
  }, [destination, enabled, enqueueRequests, store])

  useEffect(() => {
    transmissions.current = []
    queuedRequests.current.clear()
  }, [destination?.[0], destination?.[1]])

  useEffect(() => {
    if (!enabled || !destination) {
      transmissions.current = []
      queuedRequests.current.clear()
      return
    }
    sourceIsEmpty.current = true
    const tick = () => {
      const now = performance.now()
      transmissions.current = transmissions.current.filter(
        ({ born, duration }) => now - born < duration + ARRIVAL_LINGER_MS,
      )

      // Start queued activity only after the prior packet and its arrival
      // effect have completed. This guarantees that a long route reaches the
      // destination instead of being displaced by newer events in its lane.
      for (const [lane, request] of queuedRequests.current) {
        if (transmissions.current.length >= MAX_ACTIVE_TRANSMISSIONS) break
        if (transmissions.current.some((transmission) => transmission.lane === lane)) continue

        const transmission = createTransmission(
          request,
          destination,
          now,
          prefersReducedMotion.current,
        )
        if (transmission) transmissions.current.push(transmission)
        queuedRequests.current.delete(lane)
      }
      // An idle map has nothing new to say; skip pushing a frame identical to
      // the empty one the source already holds.
      const idle = transmissions.current.length === 0
      if (!idle || !sourceIsEmpty.current) {
        const source = map?.getSource(SOURCE_ID) as GeoJSONSource | undefined
        source?.setData(buildFrame(transmissions.current, destination, now))
        sourceIsEmpty.current = idle
      }
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
          "line-color": ["get", "color"],
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
          "line-color": ["get", "color"],
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
          "line-color": ["get", "color"],
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
          "line-color": ["get", "color"],
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
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-opacity": ["*", ["get", "opacity"], ["-", 1, ["get", "pulse"]]],
        }}
      />
      <Layer
        id="live-origin-core"
        type="circle"
        filter={["==", ["get", "kind"], "origin"]}
        paint={{
          "circle-radius": ["get", "radius"],
          "circle-color": "#ecfeff",
          "circle-blur": 0.15,
          "circle-opacity": ["get", "opacity"],
          "circle-stroke-width": 3,
          "circle-stroke-color": ["get", "color"],
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
          "circle-stroke-color": ["get", "arrivalColor"],
          "circle-stroke-opacity": ["get", "arrival"],
        }}
      />
      <Layer
        id="live-packet-aura"
        type="circle"
        filter={["==", ["get", "kind"], "packet"]}
        paint={{
          "circle-radius": ["interpolate", ["linear"], ["get", "pulse"], 0, 10, 1, 16],
          "circle-color": ["get", "color"],
          "circle-blur": 0.8,
          "circle-opacity": ["*", ["get", "opacity"], 0.72],
        }}
      />
      <Layer
        id="live-packet-core"
        type="circle"
        filter={["==", ["get", "kind"], "packet"]}
        paint={{
          "circle-radius": ["get", "radius"],
          "circle-color": "#ffffff",
          "circle-opacity": ["get", "opacity"],
          "circle-stroke-width": 2,
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-opacity": ["get", "opacity"],
        }}
      />
      <Layer
        id="live-banned-cage"
        type="symbol"
        filter={["==", ["get", "banned"], 1]}
        layout={{
          "icon-image": BANNED_RING_IMAGE_ID,
          "icon-size": 0.5,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        }}
        paint={{ "icon-opacity": ["get", "opacity"] }}
      />
    </Source>
  )
}
