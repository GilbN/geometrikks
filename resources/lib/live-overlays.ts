/**
 * Which live overlays are switched on. One key holding an object rather than
 * a bare boolean, so there is a single place to migrate when an overlay is
 * added or renamed. Unknown keys from an older build are ignored.
 */
export const LIVE_OVERLAYS_STORAGE_KEY = "geometrikks-live-overlays"

export interface LiveOverlayPreferences {
  /** The desktop live rail: summary, origins, and the request feed. */
  rail: boolean
}

const DEFAULTS: LiveOverlayPreferences = { rail: true }

export function loadLiveOverlays(): LiveOverlayPreferences {
  try {
    const raw = localStorage.getItem(LIVE_OVERLAYS_STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<Record<keyof LiveOverlayPreferences, unknown>>
    return {
      rail: typeof parsed.rail === "boolean" ? parsed.rail : DEFAULTS.rail,
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
