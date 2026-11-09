import { describe, expect, it } from "vitest"
import { asnCoverage, headlineAsnCategory } from "./asn-coverage"

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

  it("counts DROP-listed traffic as classified", () => {
    const c = asnCoverage([...cats(60, 20), { category: "drop" as const, hits: 20 }], 100)
    expect(c.classified).toBe(100)
    expect(c.unenriched).toBe(0)
    expect(c.hostingShare).toBeCloseTo(60)
  })

  it("reports the DROP share apart from the hosting share", () => {
    const c = asnCoverage([{ category: "drop" as const, hits: 74_329 }, ...cats(431_200, 718_544)], 1_224_073)
    expect(c.hostingShare).toBeCloseTo(35.2, 1)
    expect(c.dropShare).toBeCloseTo(6.1, 1)
    expect(c.dropHits).toBe(74_329)
  })

  it("has a zero DROP share when the lists are loaded but no traffic matched", () => {
    const c = asnCoverage([{ category: "drop" as const, hits: 0 }, ...cats(50, 50)], 100)
    expect(c.dropShare).toBe(0)
    expect(c.dropHits).toBe(0)
  })

  it("has no DROP share without a drop entry", () => {
    const c = asnCoverage(cats(60, 40), 100)
    expect(c.dropShare).toBeNull()
    expect(c.dropHits).toBe(0)
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

describe("headlineAsnCategory", () => {
  it("picks the larger of DROP and Hosting", () => {
    const drop = { category: "drop" as const, hits: 8_389 }
    expect(headlineAsnCategory([drop, ...cats(3_931, 1_000)])?.category).toBe("drop")
    expect(headlineAsnCategory([drop, ...cats(9_000, 1_000)])?.category).toBe("hosting")
    expect(headlineAsnCategory(cats(60, 40))?.category).toBe("hosting")
  })

  it("never picks Other, even when it sent the most requests", () => {
    const drop = { category: "drop" as const, hits: 1_200 }
    expect(headlineAsnCategory([drop, ...cats(2_800, 14_096)])).toEqual({ category: "hosting", hits: 2_800 })
    expect(headlineAsnCategory(cats(0, 500))).toEqual({ category: "hosting", hits: 0 })
  })

  it("breaks a tie toward DROP", () => {
    expect(headlineAsnCategory([...cats(50, 50), { category: "drop" as const, hits: 50 }])?.category).toBe("drop")
  })

  it("returns nothing when there are no categories", () => {
    expect(headlineAsnCategory(undefined)).toBeUndefined()
    expect(headlineAsnCategory([])).toBeUndefined()
  })
})
