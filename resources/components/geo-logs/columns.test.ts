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

  it("hides the ASN columns by default on every viewport", () => {
    expect(defaults(false)).not.toContain("asn")
    expect(defaults(false)).not.toContain("asOrganization")
    expect(defaults(true)).not.toContain("asn")
  })

  it("sorts by ASN number but not by organization", () => {
    expect(GEO_LOG_COLUMNS.find((c) => c.key === "asn")?.sortField).toBe("asn")
    expect(GEO_LOG_COLUMNS.find((c) => c.key === "asOrganization")?.sortField).toBeUndefined()
  })
})
