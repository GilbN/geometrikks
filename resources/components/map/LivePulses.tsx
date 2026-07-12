/**
 * Transient pulse animation at live geo-event coordinates.
 * One GeoJSON source ("live-pulses") + one circle layer; a rAF loop fades
 * each pulse over PULSE_MS and prunes it. Concurrent pulses capped.
 */
import { useEffect, useRef } from "react"
import { Layer, Source, useMap } from "react-map-gl/maplibre"
import type { GeoJSONSource } from "maplibre-gl"
import { useLiveEvents } from "@/lib/live-feed-context"

const PULSE_MS = 1500
const MAX_PULSES = 50

interface Pulse {
  lng: number
  lat: number
  born: number
}

export function LivePulses({ enabled }: { enabled: boolean }) {
  const { current: map } = useMap()
  const pulses = useRef<Pulse[]>([])
  const raf = useRef<number>(0)

  useLiveEvents((events) => {
    const now = performance.now()
    for (const e of events) {
      if (e.type !== "geo_event") continue
      pulses.current.push({ lng: e.data.longitude, lat: e.data.latitude, born: now })
    }
    if (pulses.current.length > MAX_PULSES) {
      pulses.current = pulses.current.slice(-MAX_PULSES)
    }
  }, enabled)

  useEffect(() => {
    if (!enabled) {
      pulses.current = []
      return
    }
    const tick = () => {
      const now = performance.now()
      pulses.current = pulses.current.filter((p) => now - p.born < PULSE_MS)
      const source = map?.getSource("live-pulses") as GeoJSONSource | undefined
      source?.setData({
        type: "FeatureCollection",
        features: pulses.current.map((p) => ({
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
          properties: { age: (now - p.born) / PULSE_MS }, // 0 -> 1
        })),
      })
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [enabled, map])

  if (!enabled) return null
  return (
    <Source id="live-pulses" type="geojson" data={{ type: "FeatureCollection", features: [] }}>
      <Layer
        id="live-pulse-circles"
        type="circle"
        paint={{
          "circle-radius": ["interpolate", ["linear"], ["get", "age"], 0, 4, 1, 22],
          "circle-color": "rgba(34, 211, 238, 1)", // geo-cyan, matches the UI accent
          "circle-opacity": ["interpolate", ["linear"], ["get", "age"], 0, 0.8, 1, 0],
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "rgba(34, 211, 238, 0.9)",
          "circle-stroke-opacity": ["interpolate", ["linear"], ["get", "age"], 0, 0.9, 1, 0],
        }}
      />
    </Source>
  )
}
