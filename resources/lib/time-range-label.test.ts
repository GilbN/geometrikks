import { describe, expect, it } from "vite-plus/test"
import { timeRangeName, timeRangeSpan } from "@/lib/time-range-label"

const at = (iso: string) => new Date(iso).getTime()

describe("timeRangeName", () => {
  it("spells out relative presets", () => {
    expect(timeRangeName("7d")).toBe("Last 7 days")
    expect(timeRangeName("1h")).toBe("Last hour")
    expect(timeRangeName("15m")).toBe("Last 15 minutes")
    expect(timeRangeName("yesterday")).toBe("Yesterday")
  })
})

describe("timeRangeSpan", () => {
  const now = at("2026-11-25T15:30:00")

  it("shows dates for a span over several days", () => {
    expect(timeRangeSpan("7d", null, now, "short24")).toBe(
      `${new Date(at("2026-11-18T15:30:00")).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${new Date(now).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
    )
  })

  it("shows clock times for a span within today", () => {
    expect(timeRangeSpan("1h", null, now, "short24")).toBe("14:30 – 15:30")
  })

  it("names an earlier day before its times", () => {
    const custom = {
      from: new Date(at("2026-11-10T09:00:00")).toISOString(),
      to: new Date(at("2026-11-10T11:00:00")).toISOString(),
    }
    const day = new Date(at("2026-11-10T09:00:00")).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    })
    expect(timeRangeSpan("custom", custom, now, "short24")).toBe(`${day}, 09:00 – 11:00`)
  })

  it("shows only the date for Yesterday", () => {
    const day = new Date(at("2026-11-24T12:00:00")).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    })
    expect(timeRangeSpan("yesterday", null, now, "short24")).toBe(day)
  })

  it("adds the year when the span crosses one", () => {
    expect(timeRangeSpan("365d", null, now, "short24")).toMatch(/2025.*2026/)
  })
})
