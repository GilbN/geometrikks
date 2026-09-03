/** localStorage persistence for the map's layer choice, Live toggle and
 *  attribution pill. Defaults preserve pre-persistence behavior: markers,
 *  live off, attribution expanded. */
export const MAP_LAYER_STORAGE_KEY = "geometrikks-map-layer"
export const MAP_LIVE_STORAGE_KEY = "geometrikks-map-live"
export const MAP_ATTRIBUTION_STORAGE_KEY = "geometrikks-map-attribution"

export type MapLayer = "heatmap" | "markers"

export function loadLayerPreference(): MapLayer {
  try {
    return localStorage.getItem(MAP_LAYER_STORAGE_KEY) === "heatmap" ? "heatmap" : "markers"
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

export function loadAttributionPreference(): boolean {
  try {
    return localStorage.getItem(MAP_ATTRIBUTION_STORAGE_KEY) !== "false"
  } catch {
    return true
  }
}

export function saveAttributionPreference(expanded: boolean): void {
  try {
    localStorage.setItem(MAP_ATTRIBUTION_STORAGE_KEY, String(expanded))
  } catch {
    // Storage may be blocked; keep the in-memory preference for this session.
  }
}
