/**
 * The page's subtitle, which the top bar shows as a hint on the page title.
 * A page publishes it through PageHeader. Some pages pick their subtitle at
 * render time, such as Security with and without CrowdSec, so the route
 * table can't hold it.
 */
import { useLayoutEffect, useSyncExternalStore } from "react"

let subtitle: string | null = null
const listeners = new Set<() => void>()

function set(next: string | null): void {
  if (next === subtitle) return
  subtitle = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePublishPageSubtitle(text: string | undefined): void {
  useLayoutEffect(() => {
    set(text ?? null)
    return () => {
      if (subtitle === (text ?? null)) set(null)
    }
  }, [text])
}

export function usePageSubtitle(): string | null {
  return useSyncExternalStore(subscribe, () => subtitle)
}
