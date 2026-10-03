import { useCallback, useState } from "react"
import type { ErrorEvent } from "react-map-gl/maplibre"
import { mapStartFailure, type MapStartFailure } from "@/lib/map-start-failure"

/** An onError for a react-map-gl Map, and the failure that left it unable to run. */
export function useMapStartFailure() {
  const [failure, setFailure] = useState<MapStartFailure | null>(null)
  const onError = useCallback((event: ErrorEvent) => {
    // Passing onError switches off react-map-gl's own console.error.
    console.error(event.error)
    const next = mapStartFailure(event)
    if (next) setFailure(next)
  }, [])
  return { failure, onError }
}
