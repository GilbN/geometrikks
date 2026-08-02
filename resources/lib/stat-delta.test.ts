import { describe, expect, it } from "vitest"
import { deltaDirection, deltaTone } from "./stat-delta"

describe("deltaTone", () => {
  it("returns null when there is no value", () => {
    expect(deltaTone(null)).toBeNull()
    expect(deltaTone(undefined)).toBeNull()
  })

  it("returns null for non-finite values", () => {
    expect(deltaTone(Number.NaN)).toBeNull()
    expect(deltaTone(Infinity)).toBeNull()
    expect(deltaTone(-Infinity)).toBeNull()
  })

  it("is muted for values that display as 0.0%", () => {
    expect(deltaTone(0)).toBe("muted")
    expect(deltaTone(0.04)).toBe("muted")
    expect(deltaTone(-0.04)).toBe("muted")
  })

  it("colors goodness, not direction", () => {
    expect(deltaTone(12, true)).toBe("accent")
    expect(deltaTone(12, false)).toBe("destructive")
    expect(deltaTone(-8, true)).toBe("accent")
    expect(deltaTone(-8, false)).toBe("destructive")
  })

  it("falls back to the numeric sign when positive is omitted", () => {
    expect(deltaTone(5)).toBe("accent")
    expect(deltaTone(-5)).toBe("destructive")
  })
})

describe("deltaDirection", () => {
  it("is flat for values that display as 0.0%", () => {
    expect(deltaDirection(0)).toBe("flat")
    expect(deltaDirection(0.04)).toBe("flat")
    expect(deltaDirection(-0.04)).toBe("flat")
  })

  it("follows the numeric sign at the display threshold", () => {
    expect(deltaDirection(0.05)).toBe("up")
    expect(deltaDirection(-0.05)).toBe("down")
    expect(deltaDirection(3.2)).toBe("up")
    expect(deltaDirection(-3.2)).toBe("down")
  })
})
