import { describe, expect, it } from "vite-plus/test"
import { mutedDrawerCounts, retentionNoteFor } from "./muted-ips"

const NOW = new Date("2026-11-20T12:00:00Z")
const DAY_MS = 86_400_000

describe("retentionNoteFor", () => {
  it("is true for a 7 day custom range ending 200 days ago with retention 180", () => {
    const rangeStart = new Date(NOW.getTime() - 207 * DAY_MS)
    expect(retentionNoteFor({ flag: true, rangeStart, now: NOW, rawRetentionDays: 180 })).toBe(true)
  })

  it("is false when the flag is off", () => {
    const rangeStart = new Date(NOW.getTime() - 365 * DAY_MS)
    expect(retentionNoteFor({ flag: false, rangeStart, now: NOW, rawRetentionDays: 180 })).toBe(
      false,
    )
  })

  it("is false for a 24 hour range", () => {
    const rangeStart = new Date(NOW.getTime() - DAY_MS)
    expect(retentionNoteFor({ flag: true, rangeStart, now: NOW, rawRetentionDays: 180 })).toBe(
      false,
    )
  })
})

describe("mutedDrawerCounts", () => {
  it("counts the switch in the badge but not in Clear filters", () => {
    expect(mutedDrawerCounts(0, true)).toEqual({ activeCount: 1, clearCount: 0 })
  })

  it("adds nothing when the switch is not in effect", () => {
    expect(mutedDrawerCounts(2, false)).toEqual({ activeCount: 2, clearCount: 2 })
  })
})
