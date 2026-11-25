/** localStorage persistence for docking the IP inspector beside the page on
 *  wide screens. Defaults to docked. */
export const INSPECTOR_DOCKED_STORAGE_KEY = "geometrikks-inspector-docked"

/** The narrowest viewport the inspector docks at. */
export const INSPECTOR_DOCK_QUERY = "(width >= 100rem)"

export function loadInspectorDockedPreference(): boolean {
  try {
    return localStorage.getItem(INSPECTOR_DOCKED_STORAGE_KEY) !== "false"
  } catch {
    return true
  }
}

export function saveInspectorDockedPreference(docked: boolean): void {
  try {
    localStorage.setItem(INSPECTOR_DOCKED_STORAGE_KEY, String(docked))
  } catch {
    // Storage may be blocked; keep the in-memory state for this session.
  }
}
