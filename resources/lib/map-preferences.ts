/** localStorage persistence for the map's layer choice and Live toggle.
 *  Defaults preserve pre-persistence behavior: markers, live off. */
export const MAP_LAYER_STORAGE_KEY = "geometrikks-map-layer"
export const MAP_LIVE_STORAGE_KEY = "geometrikks-map-live"

export type MapLayer = "heatmap" | "markers" | "countries"

const KNOWN_LAYERS: readonly MapLayer[] = ["heatmap", "markers", "countries"]

export function loadLayerPreference(): MapLayer {
  try {
    const stored = localStorage.getItem(MAP_LAYER_STORAGE_KEY)
    return (KNOWN_LAYERS as readonly string[]).includes(stored ?? "")
      ? (stored as MapLayer)
      : "markers"
  } catch {
    return "markers"
  }
}

export function saveLayerPreference(layer: MapLayer): void {
  try {
    localStorage.setItem(MAP_LAYER_STORAGE_KEY, layer)
  } catch {
    // Storage may be blocked; keep the in-memory preference for this session.
  }
}

export function loadLivePreference(): boolean {
  try {
    return localStorage.getItem(MAP_LIVE_STORAGE_KEY) === "true"
  } catch {
    return false
  }
}

export function saveLivePreference(enabled: boolean): void {
  try {
    localStorage.setItem(MAP_LIVE_STORAGE_KEY, String(enabled))
  } catch {
    // Storage may be blocked; keep the in-memory preference for this session.
  }
}
