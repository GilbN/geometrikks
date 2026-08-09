import { describe, expect, it } from "vitest"
import { clampedYMax, niceCeil } from "./chart-scale"

describe("niceCeil", () => {
  it("rounds up to the next 1/2/2.5/5 step of the decade", () => {
    expect(niceCeil(360)).toBe(500)
    expect(niceCeil(1000)).toBe(1000)
    expect(niceCeil(1100)).toBe(2000)
    expect(niceCeil(2400)).toBe(2500)
    expect(niceCeil(0.06)).toBeCloseTo(0.1)
  })
})

describe("clampedYMax", () => {
  it("returns null when no bucket dwarfs the rest", () => {
    const values = Array.from({ length: 168 }, (_, i) => 100 + i)
    expect(clampedYMax(values)).toBeNull()
  })

  it("clamps to a nice max just above the non-spike buckets", () => {
    const values = [...Array(167).fill(300), 18000]
    expect(clampedYMax(values)).toBe(500)
  })

  it("returns null for short series even with a spike", () => {
    expect(clampedYMax([0, 0, 5000])).toBeNull()
  })

  it("returns null when everything except the spike is zero", () => {
    expect(clampedYMax([...Array(100).fill(0), 9000])).toBeNull()
  })

  it("ignores null and undefined buckets", () => {
    const values = [...Array(167).fill(300), null, undefined, 18000]
    expect(clampedYMax(values)).toBe(500)
  })

  it("clamps fractional series such as latency seconds", () => {
    expect(clampedYMax([...Array(100).fill(0.05), 3])).toBeCloseTo(0.1)
  })
})
