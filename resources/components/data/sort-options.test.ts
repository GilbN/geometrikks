import { describe, expect, it } from "vitest"
import { sortOptions, sortOrderLabel } from "./sort-options"

describe("sortOrderLabel", () => {
  it("words each order for the kind of field", () => {
    expect(sortOrderLabel("time", "desc")).toBe("Newest first")
    expect(sortOrderLabel("number", "asc")).toBe("Lowest first")
    expect(sortOrderLabel("text", "asc")).toBe("A to Z")
    expect(sortOrderLabel("flag", "desc")).toBe("Yes first")
  })
})

describe("sortOptions", () => {
  it("keeps the sortable columns in order and defaults to text", () => {
    const columns = [
      { label: "Time", sortField: "timestamp", sortKind: "time" as const },
      { label: "Referrer" },
      { label: "URL", sortField: "url" },
    ]
    expect(sortOptions(columns)).toEqual([
      { field: "timestamp", label: "Time", kind: "time" },
      { field: "url", label: "URL", kind: "text" },
    ])
  })
})
