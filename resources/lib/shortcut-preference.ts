/**
 * Whether single-key shortcuts are on, per browser. Ctrl shortcuts stay on
 * either way. Single keys can clash with browser extensions that bind the
 * same keys, such as Vimium.
 */
import { useCallback, useSyncExternalStore } from "react"

export const SINGLE_KEY_SHORTCUTS_KEY = "geometrikks-single-key-shortcuts"

const listeners = new Set<() => void>()
let unsaved: boolean | null = null

function read(): boolean {
  if (unsaved !== null) return unsaved
  try {
    return localStorage.getItem(SINGLE_KEY_SHORTCUTS_KEY) !== "off"
  } catch {
    return true
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === SINGLE_KEY_SHORTCUTS_KEY) listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

export function singleKeyShortcutsEnabled(): boolean {
  return read()
}

export function useSingleKeyShortcuts(): [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, read, () => true)
  const setEnabled = useCallback((next: boolean) => {
    try {
      if (next) localStorage.removeItem(SINGLE_KEY_SHORTCUTS_KEY)
      else localStorage.setItem(SINGLE_KEY_SHORTCUTS_KEY, "off")
      unsaved = null
    } catch {
      unsaved = next
    }
    for (const listener of listeners) listener()
  }, [])
  return [enabled, setEnabled]
}
