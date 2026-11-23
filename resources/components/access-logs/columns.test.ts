import { describe, expect, it } from "vite-plus/test"

import { resolveVisibleColumns } from "@/lib/column-visibility"
import { ACCESS_LOG_COLUMNS, combinedAccessLogColumns } from "./columns"

const defaults = (mobile: boolean) =>
  ACCESS_LOG_COLUMNS.filter((c) =>
    resolveVisibleColumns(ACCESS_LOG_COLUMNS, {}, mobile).has(c.key),
  ).map((c) => c.key)

describe("access log columns", () => {
  it("has unique keys and a label for each", () => {
    const keys = ACCESS_LOG_COLUMNS.map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const c of ACCESS_LOG_COLUMNS) expect(c.label.length).toBeGreaterThan(0)
  })

  it("keeps time, status, method, URL and IP on mobile", () => {
    expect(defaults(true)).toEqual(["timestamp", "statusCode", "method", "url", "ipAddress"])
  })

  it("shows every desktop default on desktop", () => {
    expect(defaults(false)).toEqual(
      ACCESS_LOG_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key),
    )
  })

  it("labels the server column", () => {
    expect(ACCESS_LOG_COLUMNS.find((c) => c.key === "server")?.label).toBe("Server")
  })
})

const shown = (...hidden: string[]) =>
  ACCESS_LOG_COLUMNS.filter((c) => c.defaultVisible && !hidden.includes(c.key))

describe("combined access log columns", () => {
  it("puts the default fields in the combined order", () => {
    expect(combinedAccessLogColumns(shown()).map((c) => c.label)).toEqual([
      "Time",
      "Status",
      "Request",
      "Client",
      "Location",
      "Bytes",
      "Took",
      "Referrer",
    ])
  })

  it("draws only the visible fields of a group", () => {
    const request = combinedAccessLogColumns(shown("host")).find((c) => c.key === "request")
    expect(request?.fields.map((c) => c.key)).toEqual(["method", "url"])
  })

  it("drops a group whose fields are all hidden", () => {
    const keys = combinedAccessLogColumns(shown("city", "country")).map((c) => c.key)
    expect(keys).not.toContain("location")
  })

  it("keeps extra fields after the grouped ones, in column order", () => {
    const extras = ACCESS_LOG_COLUMNS.filter((c) => ["server", "asn"].includes(c.key))
    const keys = combinedAccessLogColumns([...shown(), ...extras]).map((c) => c.key)
    expect(keys.slice(-3)).toEqual(["referrer", "server", "asn"])
  })
})
