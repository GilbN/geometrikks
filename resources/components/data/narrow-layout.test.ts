import { describe, expect, it } from "vitest"
import { narrowAt } from "./narrow-layout"

describe("narrowAt", () => {
  it("is narrow below the breakpoint", () => {
    expect(narrowAt(799, 800, false)).toBe(true)
    expect(narrowAt(800, 800, true)).toBe(false)
  })
  it("keeps the current layout at zero width, as in a hidden tab", () => {
    expect(narrowAt(0, 800, false)).toBe(false)
    expect(narrowAt(0, 800, true)).toBe(true)
  })
})
