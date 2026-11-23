import { describe, expect, it } from "vite-plus/test"
import { defaultPageSize, formatClockTime, formatTableTime, parseTableView } from "./table-view"

const NOW = new Date(2026, 10, 23, 12, 0, 0)

describe("formatTableTime", () => {
  it("reads month, day and a 24-hour clock with seconds", () => {
    expect(formatTableTime(new Date(2026, 10, 14, 16, 41, 40), "short24", NOW)).toBe(
      "Nov 14 16:41:40",
    )
    expect(formatTableTime(new Date(2026, 0, 2, 4, 5, 6), "short24", NOW)).toBe("Jan 2 04:05:06")
  })

  it("adds the year only outside the current one", () => {
    expect(formatTableTime(new Date(2025, 11, 31, 23, 59, 59), "short24", NOW)).toBe(
      "Dec 31 2025 23:59:59",
    )
  })

  it("leaves the browser format to the locale", () => {
    const date = new Date(2026, 10, 14, 16, 41, 40)
    expect(formatTableTime(date, "browser", NOW)).toBe(date.toLocaleString())
  })

  it("returns a dash for an unparseable value", () => {
    expect(formatTableTime("nope", "short24", NOW)).toBe("-")
    expect(formatClockTime("nope", "short24")).toBe("-")
  })
})

describe("formatClockTime", () => {
  it("drops the day", () => {
    expect(formatClockTime(new Date(2026, 10, 14, 7, 8, 9), "short24")).toBe("07:08:09")
  })
})

describe("parseTableView", () => {
  it("keeps only known choices", () => {
    expect(parseTableView('{"density":"compact","layout":"separate"}')).toEqual({
      density: "compact",
      layout: "separate",
    })
    expect(parseTableView('{"density":"tiny","layout":3}')).toEqual({})
    expect(parseTableView("not json")).toEqual({})
    expect(parseTableView(null)).toEqual({})
  })
})

describe("defaultPageSize", () => {
  it("fills a screen with compact rows and keeps 20 for comfortable ones", () => {
    expect(defaultPageSize("compact")).toBe(50)
    expect(defaultPageSize("comfortable")).toBe(20)
  })
})
