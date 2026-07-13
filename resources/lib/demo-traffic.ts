export type DemoTrafficMode = "off" | "steady" | "burst"

export interface DemoTrafficOrigin {
  city: string
  coordinates: [longitude: number, latitude: number]
}

/** Deterministic global origins for visually exercising long and short routes. */
export const DEMO_TRAFFIC_ORIGINS: readonly DemoTrafficOrigin[] = [
  { city: "London", coordinates: [-0.1276, 51.5072] },
  { city: "New York", coordinates: [-74.006, 40.7128] },
  { city: "São Paulo", coordinates: [-46.6333, -23.5505] },
  { city: "Cape Town", coordinates: [18.4241, -33.9249] },
  { city: "Mumbai", coordinates: [72.8777, 19.076] },
  { city: "Singapore", coordinates: [103.8198, 1.3521] },
  { city: "Tokyo", coordinates: [139.6917, 35.6895] },
  { city: "Sydney", coordinates: [151.2093, -33.8688] },
  { city: "San Francisco", coordinates: [-122.4194, 37.7749] },
  { city: "Reykjavík", coordinates: [-21.9426, 64.1466] },
] as const

/** Demo traffic can never be enabled in a production bundle. */
export function getDemoTrafficMode(): DemoTrafficMode {
  if (!import.meta.env.DEV) return "off"
  const value = new URLSearchParams(window.location.search).get("demoTraffic")
  if (value === "burst") return "burst"
  if (value === "1" || value === "true" || value === "steady") return "steady"
  return "off"
}
