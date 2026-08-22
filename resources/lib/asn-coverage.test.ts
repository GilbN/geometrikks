import { describe, expect, it } from "vitest"
import { asnCoverage } from "./asn-coverage"

const cats = (hosting: number, other: number) => [
  { category: "hosting" as const, hits: hosting },
  { category: "other" as const, hits: other },
]

describe("asnCoverage", () => {
  it("reports the share of classified traffic, not of the whole range", () => {
    // 100 classified out of 1000 requests: the range is mostly pre-enrichment
    // history. Regression: dividing by the category sum alone read as
    // "100% of 100 requests" while 900 rows were invisible.
    const c = asnCoverage(cats(90, 10), 1000)
    expect(c.classified).toBe(100)
    expect(c.unenriched).toBe(900)
    expect(c.hostingShare).toBeCloseTo(90)
    expect(c.coverage).toBeCloseTo(10)
    expect(c.hasData).toBe(true)
  })

  it("reports full coverage when every request is enriched", () => {
    const c = asnCoverage(cats(63, 37), 100)
    expect(c.unenriched).toBe(0)
    expect(c.coverage).toBeCloseTo(100)
    expect(c.hostingShare).toBeCloseTo(63)
  })

  it("has no data when nothing in the range is classified", () => {
    const c = asnCoverage(cats(0, 0), 5000)
    expect(c.hasData).toBe(false)
    expect(c.hostingShare).toBe(0)
    expect(c.unenriched).toBe(5000)
  })

  it("treats missing categories as zero rather than NaN", () => {
    const c = asnCoverage(undefined, 0)
    expect(c.hasData).toBe(false)
    expect(c.hostingShare).toBe(0)
    expect(c.coverage).toBe(0)
  })

  it("clamps both derived figures when totals race the aggregates", () => {
    // Live ingestion between the two reads can leave classified > total;
    // neither "-5 unenriched" nor "105% of range" may reach the UI.
    const c = asnCoverage(cats(60, 45), 100)
    expect(c.unenriched).toBe(0)
    expect(c.coverage).toBe(100)
  })
})
