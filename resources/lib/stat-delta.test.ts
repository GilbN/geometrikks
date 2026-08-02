import { describe, expect, it } from "vitest"
import { deltaDirection, deltaTone } from "./stat-delta"

describe("deltaTone", () => {
  it("returns null (no badge) for missing values", () => {
    expect(deltaTone(null)).toBeNull()
    expect(deltaTone(undefined)).toBeNull()
  })

  it("is muted for zero change regardless of goodness", () => {
    expect(deltaTone(0)).toBe("muted")
    expect(deltaTone(0, false)).toBe("muted")
  })

  it("follows the explicit goodness flag", () => {
    expect(deltaTone(12.5, true)).toBe("accent")
    expect(deltaTone(12.5, false)).toBe("destructive")
    expect(deltaTone(-8, true)).toBe("accent")
    expect(deltaTone(-8, false)).toBe("destructive")
  })

  it("defaults goodness to 'up is good' when no flag is given", () => {
    expect(deltaTone(3)).toBe("accent")
    expect(deltaTone(-3)).toBe("destructive")
  })
})

describe("deltaDirection", () => {
  it("maps sign to direction", () => {
    expect(deltaDirection(5)).toBe("up")
    expect(deltaDirection(-5)).toBe("down")
    expect(deltaDirection(0)).toBe("flat")
  })
})
