/**
 * Which build the user last opened the Changelog page on. The sidebar and
 * the Settings nav show a dot while the running build differs from it.
 */
import { useSyncExternalStore } from "react"

export const CHANGELOG_SEEN_STORAGE_KEY = "geometrikks-changelog-seen"

/**
 * The shipped changelog's digest changes with every release, dev tag and
 * local rebuild that added entries, which is exactly when there is
 * something new to read. The version only stands in when no changelog
 * shipped at all.
 */
export function currentBuildKey(app: { version: string; changelogDigest: string | null }): string {
  return app.changelogDigest ?? app.version
}

export function loadSeenBuild(): string | null {
  try {
    return localStorage.getItem(CHANGELOG_SEEN_STORAGE_KEY)
  } catch {
    return null
  }
}

const listeners = new Set<() => void>()

export function subscribeSeenBuild(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export function saveSeenBuild(key: string): void {
  try {
    localStorage.setItem(CHANGELOG_SEEN_STORAGE_KEY, key)
  } catch {
    // Storage blocked: the dot stays until the page reloads, nothing worse.
  }
  for (const listener of listeners) listener()
}

/** No stored value means a first visit, and a first visit should not nag. */
export function hasUnseenChanges(seen: string | null, current: string | null): boolean {
  return seen !== null && current !== null && seen !== current
}

export function useSeenBuild(): string | null {
  return useSyncExternalStore(subscribeSeenBuild, loadSeenBuild)
}
