/** localStorage persistence for the desktop sidebar's expanded or collapsed
 *  state. Defaults to expanded. */
export const SIDEBAR_OPEN_STORAGE_KEY = "geometrikks-sidebar-open"

export function loadSidebarOpenPreference(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY) !== "false"
  } catch {
    return true
  }
}

export function saveSidebarOpenPreference(open: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(open))
  } catch {
    // Storage may be blocked; keep the in-memory state for this session.
  }
}
