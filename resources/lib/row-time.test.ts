import { describe, expect, it } from "vitest"
import { formatRowTime } from "./row-time"

const NOW = new Date(2026, 9, 28, 15, 30, 0)

describe("formatRowTime", () => {
  it("shows only the time for today", () => {
    const text = formatRowTime(new Date(2026, 9, 28, 9, 40, 5), NOW)
    expect(text).toMatch(/9:40:05/)
    expect(text).not.toMatch(/Oct/)
  })
  it("adds the day but not the year for earlier this year", () => {
    const text = formatRowTime(new Date(2026, 9, 15, 21, 40, 5), NOW)
    expect(text).toMatch(/Oct/)
    expect(text).toMatch(/15/)
    expect(text).not.toMatch(/2026/)
    expect(text).not.toMatch(/:05/)
  })
  it("adds the year for an earlier year", () => {
    expect(formatRowTime(new Date(2025, 11, 31, 23, 0, 0), NOW)).toMatch(/2025/)
  })
  it("returns a dash for an unparseable value", () => {
    expect(formatRowTime("not a date", NOW)).toBe("-")
  })
})
