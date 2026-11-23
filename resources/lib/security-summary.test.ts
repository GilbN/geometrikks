import { describe, expect, it } from "vite-plus/test"
import {
  alertTotalText,
  barLabel,
  dayOfMonth,
  expiryText,
  setByHandCount,
  splitParts,
} from "./security-summary"
import { formatNumber } from "./format-number"

describe("splitParts", () => {
  it("keeps the parts that hold a decision, in bar order, with their own plural", () => {
    const parts = splitParts({ bans: 12, ranges: 1, captchas: 0, other: 2 })
    expect(parts.map((part) => part.label)).toEqual(["12 bans", "1 range", "2 other"])
  })

  it("is empty without decisions", () => {
    expect(splitParts({ bans: 0, ranges: 0, captchas: 0, other: 0 })).toEqual([])
  })
})

describe("expiryText", () => {
  it("counts the decisions expiring soon", () => {
    expect(expiryText(14, 3, 4)).toBe("3 expire within 4 hours")
    expect(expiryText(14, 1, 4)).toBe("1 expires within 4 hours")
  })

  it("says none when nothing expires soon", () => {
    expect(expiryText(14, 0, 4)).toBe("none expire within 4 hours")
  })

  it("says nothing without decisions", () => {
    expect(expiryText(0, 0, 4)).toBeNull()
  })
})

describe("setByHandCount", () => {
  it("adds the GeoMetrikks and cscli origins", () => {
    expect(
      setByHandCount([
        { origin: "crowdsec", count: 9 },
        { origin: "geometrikks", count: 2 },
        { origin: "cscli", count: 1 },
        { origin: "CAPI", count: 400 },
      ]),
    ).toBe(3)
  })
})

describe("alert days", () => {
  it("reads the day of the month", () => {
    expect(dayOfMonth("2026-11-07")).toBe(7)
  })

  it("marks a total the server stopped counting", () => {
    expect(alertTotalText(2000, true)).toBe(`${formatNumber(2000)}+`)
    expect(alertTotalText(24, false)).toBe("24")
  })
})

describe("barLabel", () => {
  it("leaves a quiet day blank and shortens a busy one", () => {
    expect(barLabel(0)).toBe("")
    expect(barLabel(412)).toBe("412")
    expect(barLabel(1200)).toBe(
      new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
        1200,
      ),
    )
  })
})
