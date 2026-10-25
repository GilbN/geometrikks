/**
 * Which release the user last saw announced on the About page. The sidebar
 * and the Settings nav show a dot while a newer release exists that this
 * does not match. Nothing stored means the dot shows.
 */
import { useSyncExternalStore } from "react"

export const RELEASE_SEEN_STORAGE_KEY = "geometrikks-release-seen"

/** Answers when storage cannot be read or a write failed, so opening About still clears the dot until the page reloads. */
let lastSavedRelease: string | null = null
let storageWriteFailed = false

export function loadSeenRelease(): string | null {
  if (storageWriteFailed) return lastSavedRelease
  try {
    return localStorage.getItem(RELEASE_SEEN_STORAGE_KEY)
  } catch {
    return lastSavedRelease
  }
}

const listeners = new Set<() => void>()

export function subscribeSeenRelease(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export function saveSeenRelease(version: string): void {
  lastSavedRelease = version
  try {
    localStorage.setItem(RELEASE_SEEN_STORAGE_KEY, version)
    storageWriteFailed = false
  } catch {
    storageWriteFailed = true
  }
  for (const listener of listeners) listener()
}

export function hasUnseenRelease(seen: string | null, latest: string | null): boolean {
  return latest !== null && seen !== latest
}

export function useSeenRelease(): string | null {
  return useSyncExternalStore(subscribeSeenRelease, loadSeenRelease)
}
