import { describe, expect, it } from "vitest"
import { clampedYMax, floorForLog, logAxis, niceCeil, scaleSeries } from "./chart-scale"

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

describe("logAxis", () => {
  it("starts one power down when the smallest value is exactly a power", () => {
    expect(logAxis([0, 1, 10])).toEqual({
      scale: "log", domain: [0.1, 10], ticks: [0.1, 1, 10], allowDataOverflow: true,
    })
  })

  it("starts one power down when the smallest value is just above a power", () => {
    expect(logAxis([101, 3000]).domain).toEqual([10, 10000])
    expect(logAxis([0.00105, 0.2]).domain[0]).toBeCloseTo(0.0001)
  })

  it("keeps the power below when the smallest value is at least twice it", () => {
    expect(logAxis([480, 5000, 12000])).toMatchObject({
      domain: [100, 100000], ticks: [100, 1000, 10000, 100000],
    })
    expect(logAxis([0.003, 0.2, 1.4]).domain).toEqual([0.001, 10])
  })

  it("gives two ticks over a narrow range", () => {
    expect(logAxis([200, 800])).toMatchObject({ domain: [100, 1000], ticks: [100, 1000] })
  })

  it("handles exact powers despite floating point logs", () => {
    expect(logAxis([1000, 5000]).domain).toEqual([100, 10000])
  })

  it("falls back to one decade when nothing is positive", () => {
    expect(logAxis([]).domain).toEqual([1, 10])
    expect(logAxis([0, 0, null, undefined]).ticks).toEqual([1, 10])
  })

  it("uses powers of 1024 for bytes", () => {
    expect(logAxis([0, 500, 3 * 1024 ** 2], { base: 1024 })).toMatchObject({
      domain: [1, 1024 ** 3], ticks: [1, 1024, 1024 ** 2, 1024 ** 3],
    })
  })

  it("thins ticks above six and always keeps the ceiling", () => {
    expect(logAxis([1, 1e9]).ticks).toEqual([0.1, 10, 1000, 1e5, 1e7, 1e9])
  })

  it("drops ticks below 1 for integer series", () => {
    expect(logAxis([0, 1, 10], { integer: true }).ticks).toEqual([1, 10])
  })
})

describe("floorForLog", () => {
  const rows = [
    { t: "a", n: 0, m: null as number | null },
    { t: "b", n: 5, m: 2 },
  ]

  it("raises zeros to the minimum, keeps raw values and counts raises", () => {
    const out = floorForLog(rows, ["n", "m"], 0.1)
    expect(out.rows[0]).toEqual({ t: "a", n: 0.1, m: null, raw: { n: 0, m: null } })
    expect(out.rows[1]).toEqual({ t: "b", n: 5, m: 2, raw: { n: 5, m: 2 } })
    expect(out.raised).toBe(1)
  })

  it("does not mutate its input", () => {
    floorForLog(rows, ["n"], 1)
    expect(rows[0]).toEqual({ t: "a", n: 0, m: null })
  })
})

describe("scaleSeries", () => {
  const rows = [...Array(167).fill(0).map(() => ({ v: 300 })), { v: 18000 }, { v: 0 }]

  it("clips a spike in clip mode", () => {
    const out = scaleSeries(rows, ["v"], "clip")
    expect(out.clipMax).toBe(500)
    expect(out.axis).toEqual({ domain: [0, 500], allowDataOverflow: true })
    expect(out.zerosRaised).toBe(0)
  })

  it("clips on separate values when given", () => {
    const out = scaleSeries([{ v: 1 }, { v: 1 }], ["v"], "clip", { clipValues: [...Array(167).fill(300), 18000] })
    expect(out.clipMax).toBe(500)
  })

  it("never clips in full mode", () => {
    expect(scaleSeries(rows, ["v"], "full")).toMatchObject({ clipMax: null, axis: {} })
  })

  it("floors zeros and builds a log axis in log mode", () => {
    const out = scaleSeries(rows, ["v"], "log", { integer: true })
    expect(out.axis).toMatchObject({ scale: "log", domain: [100, 100000] })
    expect(out.rows.at(-1)).toEqual({ v: 100, raw: { v: 0 } })
    expect(out.zerosRaised).toBe(1)
    expect(out.clipMax).toBeNull()
  })
})
