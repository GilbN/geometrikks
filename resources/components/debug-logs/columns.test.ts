import { describe, expect, it } from "vite-plus/test"

import { resolveVisibleColumns } from "@/lib/column-visibility"
import { DEBUG_LOG_COLUMNS, combinedDebugLogColumns } from "./columns"

const defaults = (mobile: boolean) =>
  DEBUG_LOG_COLUMNS.filter((c) =>
    resolveVisibleColumns(DEBUG_LOG_COLUMNS, {}, mobile).has(c.key),
  ).map((c) => c.key)

describe("debug log columns", () => {
  it("has unique keys and a label for each", () => {
    const keys = DEBUG_LOG_COLUMNS.map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const c of DEBUG_LOG_COLUMNS) expect(c.label.length).toBeGreaterThan(0)
  })

  it("keeps captured, malformed and raw line on mobile", () => {
    expect(defaults(true)).toEqual(["createdAt", "isMalformed", "rawLine"])
  })

  it("shows every desktop default on desktop", () => {
    expect(defaults(false)).toEqual(
      DEBUG_LOG_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key),
    )
  })
})

const shown = (...hidden: string[]) =>
  DEBUG_LOG_COLUMNS.filter((c) => c.defaultVisible && !hidden.includes(c.key))

describe("combined debug log columns", () => {
  it("puts the default fields in the combined order", () => {
    expect(combinedDebugLogColumns(shown()).map((c) => c.label)).toEqual([
      "Captured",
      "Result",
      "Line",
      "Request",
      "Client",
    ])
  })

  it("draws only the visible fields of a group", () => {
    const result = combinedDebugLogColumns(shown("parseError")).find((c) => c.key === "result")
    expect(result?.fields.map((c) => c.key)).toEqual(["isMalformed"])
    expect(result?.width).toBeUndefined()
  })

  it("folds host and URL into Request when turned on", () => {
    const extras = DEBUG_LOG_COLUMNS.filter((c) => ["host", "url"].includes(c.key))
    const columns = combinedDebugLogColumns([...shown(), ...extras])
    expect(columns.map((c) => c.key)).toEqual([
      "createdAt",
      "result",
      "rawLine",
      "request",
      "client",
    ])
    const request = columns.find((c) => c.key === "request")
    expect(request?.fields.map((c) => c.key)).toEqual(["statusCode", "method", "host", "url"])
    expect(request?.width).toBe("16rem")
  })

  it("drops a group whose fields are all hidden", () => {
    const keys = combinedDebugLogColumns(shown("isMalformed", "parseError")).map((c) => c.key)
    expect(keys).not.toContain("result")
  })

  it("keeps extra fields after the grouped ones, in column order", () => {
    const extras = DEBUG_LOG_COLUMNS.filter((c) => ["logFormat", "country", "city"].includes(c.key))
    const keys = combinedDebugLogColumns([...shown(), ...extras]).map((c) => c.key)
    expect(keys.slice(-4)).toEqual(["client", "logFormat", "country", "city"])
  })
})
