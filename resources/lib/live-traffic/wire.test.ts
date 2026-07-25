import { describe, expect, it } from "vitest"
import { resolveHoveredIndex } from "./wire"
import type { SecondBucket } from "./types"

function bucket(second: number): SecondBucket {
  return { second, total: 0, threats: 0, banned: 0, worstStatus: "unknown", requestIds: [] }
}

describe("resolveHoveredIndex", () => {
  it("returns null when nothing is hovered", () => {
    const buckets = [bucket(100), bucket(101), bucket(102)]
    expect(resolveHoveredIndex(buckets, null)).toBeNull()
  })

  it("finds the bucket matching the hovered second", () => {
    const buckets = [bucket(100), bucket(101), bucket(102)]
    expect(resolveHoveredIndex(buckets, 101)).toBe(1)
  })

  it("stays on the same second after the window shifts", () => {
    // The bucket the cursor was over a second ago is now one index to the
    // left; resolving by second keeps the highlight in the right place
    // without the caller having to know the window scrolled.
    const before = [bucket(100), bucket(101), bucket(102)]
    const hoveredIndex = 2 // second 102
    const hoveredSecond = before[hoveredIndex].second

    const after = [bucket(101), bucket(102), bucket(103)]
    expect(resolveHoveredIndex(after, hoveredSecond)).toBe(1)
  })

  it("returns null once the hovered second has scrolled off the left edge", () => {
    const buckets = [bucket(101), bucket(102), bucket(103)]
    expect(resolveHoveredIndex(buckets, 100)).toBeNull()
  })
})
