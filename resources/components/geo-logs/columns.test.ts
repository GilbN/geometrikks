import { describe, expect, it } from "vitest"

import { resolveVisibleColumns } from "@/lib/column-visibility"
import { GEO_LOG_COLUMNS } from "./columns"

const defaults = (mobile: boolean) =>
  GEO_LOG_COLUMNS.filter((c) => resolveVisibleColumns(GEO_LOG_COLUMNS, {}, mobile).has(c.key)).map((c) => c.key)

describe("geo log columns", () => {
  it("has unique keys and a label for each", () => {
    const keys = GEO_LOG_COLUMNS.map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const c of GEO_LOG_COLUMNS) expect(c.label.length).toBeGreaterThan(0)
  })

  it("keeps city, country, IP and count on mobile", () => {
    expect(defaults(true)).toEqual(["city", "countryName", "ipAddress", "eventCount"])
  })

  it("shows every desktop default on desktop", () => {
    expect(defaults(false)).toEqual(GEO_LOG_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key))
  })

  it("leaves hostnames unsortable", () => {
    expect(GEO_LOG_COLUMNS.find((c) => c.key === "hostnames")?.sortField).toBeUndefined()
  })
})
