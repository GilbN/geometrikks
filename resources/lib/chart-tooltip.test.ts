import { describe, expect, it } from "vitest"
import { withRawValues } from "./chart-tooltip"

describe("withRawValues", () => {
  it("shows the raw value for floored log rows", () => {
    const items = [{ dataKey: "v", value: 100, payload: { v: 100, raw: { v: 0 } } }]
    expect(withRawValues(items)?.[0].value).toBe(0)
  })

  it("leaves items without raw values alone", () => {
    const item = { dataKey: "v", value: 7, payload: { v: 7 } }
    expect(withRawValues([item])?.[0]).toBe(item)
  })

  it("ignores function data keys and missing payloads", () => {
    const fn = () => 1
    const items = [{ dataKey: fn, value: 3, payload: { raw: {} } }, { dataKey: "v", value: 1 }]
    expect(withRawValues(items)).toEqual(items)
    expect(withRawValues(undefined)).toBeUndefined()
  })
})
