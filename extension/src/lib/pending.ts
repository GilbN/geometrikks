import type { PendingItem } from "./storage"

export const PENDING_TTL_MS = 2 * 60_000

function isLive(item: PendingItem, now: number): boolean {
  return now - item.createdAt < PENDING_TTL_MS
}

function newest(items: PendingItem[]): PendingItem | null {
  let best: PendingItem | null = null
  for (const item of items) if (!best || item.createdAt > best.createdAt) best = item
  return best
}

/** The toolbar popup's item: never one reserved for the fallback page. */
export function selectForPopup(
  items: PendingItem[],
  { windowId, origin, now }: { windowId: number; origin: string; now: number },
): PendingItem | null {
  return newest(
    items.filter(
      (item) =>
        !item.reservedForPage &&
        item.windowId === windowId &&
        item.origin === origin &&
        isLive(item, now),
    ),
  )
}

export function selectById(
  items: PendingItem[],
  { id, origin, now }: { id: string; origin: string; now: number },
): PendingItem | null {
  return items.find((item) => item.id === id && item.origin === origin && isLive(item, now)) ?? null
}

/** Runs jobs one at a time in call order; a failed job doesn't stop the next. */
export function createSerialQueue(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve()
  return <T>(job: () => Promise<T>): Promise<T> => {
    const previous = tail
    const run = (async () => {
      await previous
      return job()
    })()
    tail = (async () => {
      try {
        await run
      } catch {
        // The caller gets the error from `run`.
      }
    })()
    return run
  }
}
