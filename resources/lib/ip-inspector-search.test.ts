import { describe, expect, it } from "vitest"
import { inspectSearchSchema } from "@/lib/ip-inspector-search"

describe("inspect search param", () => {
  it("passes a string through", () => {
    expect(inspectSearchSchema.parse({ inspect: "1.2.3.4" })).toEqual({ inspect: "1.2.3.4" })
  })
  it("drops anything that is not a string", () => {
    expect(inspectSearchSchema.parse({ inspect: 5 })).toEqual({ inspect: undefined })
    expect(inspectSearchSchema.parse({})).toEqual({ inspect: undefined })
  })
})
