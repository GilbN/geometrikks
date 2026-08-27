import { describe, expect, it } from "vitest"

import { resolveVisibleColumns } from "@/lib/column-visibility"
import { ACCESS_LOG_COLUMNS } from "./columns"

const defaults = (mobile: boolean) =>
  ACCESS_LOG_COLUMNS.filter((c) => resolveVisibleColumns(ACCESS_LOG_COLUMNS, {}, mobile).has(c.key)).map(
    (c) => c.key,
  )

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
    expect(defaults(false)).toEqual(ACCESS_LOG_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key))
  })
})
