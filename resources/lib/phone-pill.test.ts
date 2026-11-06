import { describe, expect, it } from "vitest"
import { pillSize } from "./phone-pill"

describe("pillSize", () => {
  it("is full when 192px fits", () => {
    expect(pillSize(192)).toBe("full")
  })
  it("is compact just under 192px", () => {
    expect(pillSize(191)).toBe("compact")
  })
  it("is compact when 176px fits", () => {
    expect(pillSize(176)).toBe("compact")
  })
  it("drops to two buttons under 176px", () => {
    expect(pillSize(175)).toBe("two")
  })
})
