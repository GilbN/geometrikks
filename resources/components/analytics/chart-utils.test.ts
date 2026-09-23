import { describe, expect, it } from "vitest"
import { barSpacer, formatRate } from "./chart-utils"

describe("formatRate", () => {
  it("formats 0..1 fractions as percentages", () => {
    expect(formatRate(0)).toBe("0%")
    expect(formatRate(1)).toBe("100%")
    expect(formatRate(0.25)).toBe("25%")
    expect(formatRate(0.123)).toBe("12.3%")
    expect(formatRate(0.0042)).toBe("0.42%")
  })
})

describe("barSpacer", () => {
  it("keeps the card-colored spacer up to 48 buckets only", () => {
    expect(barSpacer(48)).toEqual({ stroke: "var(--card)", strokeWidth: 1 })
    expect(barSpacer(49)).toEqual({})
  })
})

