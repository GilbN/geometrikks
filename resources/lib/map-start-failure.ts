/**
 * Turns a MapLibre error into the message shown when a map cannot run.
 *
 * react-map-gl builds the MapLibre map inside a promise, so a constructor
 * throw (MapLibre 6 throws GPUInitializationError without WebGL2) never
 * reaches React or an error boundary. It arrives at the Map's onError with
 * `target: null` instead, and without an onError prop it only reaches the
 * console while the map stays blank.
 */

export interface MapStartFailure {
  title: string
  detail: string
}

const WEBGL2_ADVICE = "The map needs WebGL2 to draw. Try another browser or device, or check that graphics acceleration is available."

export function mapStartFailure(event: { error?: unknown; target?: unknown }): MapStartFailure | null {
  const { error } = event
  // Matched by name: MapLibre sets it explicitly, and importing the class
  // here would pull maplibre-gl into every caller's chunk.
  if (error instanceof Error && error.name === "GPUInitializationError") {
    const status = (error as { statusMessage?: string | null }).statusMessage
    return {
      title: "Your browser could not start WebGL2",
      detail: status ? `${WEBGL2_ADVICE} Browser message: ${status}` : WEBGL2_ADVICE,
    }
  }
  if (event.target == null) {
    return {
      title: "The map could not start",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
  return null
}
