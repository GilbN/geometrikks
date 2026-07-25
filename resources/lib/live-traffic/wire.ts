/**
 * Pure helpers for the wire's hover state.
 *
 * Buckets are recomputed once a second and the window shifts left as it
 * ages, so a hovered *second* has to be resolved to a bucket index on every
 * render rather than cached as one - otherwise the highlight and the click
 * target silently drift to a different second on each tick.
 */
import type { SecondBucket } from "./types"

/**
 * Index of the bucket for the given second, or null if there is nothing
 * hovered or that second has scrolled off the left edge of the window.
 */
export function resolveHoveredIndex(
  buckets: readonly SecondBucket[],
  hoveredSecond: number | null,
): number | null {
  if (hoveredSecond === null) return null
  const index = buckets.findIndex((bucket) => bucket.second === hoveredSecond)
  return index === -1 ? null : index
}
