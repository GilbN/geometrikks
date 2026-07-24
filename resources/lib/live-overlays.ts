/**
 * Which live overlays are switched on. One key rather than three, so there is
 * a single place to migrate when an overlay is added or renamed.
 */
export const LIVE_OVERLAYS_STORAGE_KEY = "geometrikks-live-overlays"

export interface LiveOverlayPreferences {
  vitals: boolean
  strips: boolean
  wire: boolean
}

const DEFAULTS: LiveOverlayPreferences = { vitals: true, strips: true, wire: true }

export function loadLiveOverlays(): LiveOverlayPreferences {
  try {
    const raw = localStorage.getItem(LIVE_OVERLAYS_STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<Record<keyof LiveOverlayPreferences, unknown>>
    return {
      vitals: typeof parsed.vitals === "boolean" ? parsed.vitals : DEFAULTS.vitals,
      strips: typeof parsed.strips === "boolean" ? parsed.strips : DEFAULTS.strips,
      wire: typeof parsed.wire === "boolean" ? parsed.wire : DEFAULTS.wire,
    }
  } catch {
    // Storage may be blocked or hold junk; the defaults are always safe.
    return { ...DEFAULTS }
  }
}

export function saveLiveOverlays(preferences: LiveOverlayPreferences): void {
  try {
    localStorage.setItem(LIVE_OVERLAYS_STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // Keep the in-memory preference for this session.
  }
}
