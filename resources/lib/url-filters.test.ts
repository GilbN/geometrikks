import { describe, expect, it } from "vitest"
import { applyFilterUpdate, arrayParam, dropDefault } from "./url-filters"

interface Search {
  ip?: string[]
  ipx?: string[]
  page?: number
  pageSize?: number
}

interface Filters {
  ips: string[]
  ipsExclude: string[]
}

const codec = {
  decode: (s: Search): Filters => ({ ips: s.ip ?? [], ipsExclude: s.ipx ?? [] }),
  encode: (f: Filters): Partial<Search> => ({
    ip: arrayParam(f.ips),
    ipx: arrayParam(f.ipsExclude),
  }),
  resetOnChange: { page: undefined } as Partial<Search>,
}

describe("arrayParam", () => {
  it("keeps a populated array", () => {
    expect(arrayParam(["a"])).toEqual(["a"])
  })

  it("drops an empty array", () => {
    expect(arrayParam([])).toBeUndefined()
  })

  it("drops undefined", () => {
    expect(arrayParam(undefined)).toBeUndefined()
  })
})

describe("dropDefault", () => {
  it("keeps a non-default value", () => {
    expect(dropDefault(3, 1)).toBe(3)
  })

  it("drops the default", () => {
    expect(dropDefault(1, 1)).toBeUndefined()
  })

  it("works for strings", () => {
    expect(dropDefault("desc", "desc")).toBeUndefined()
    expect(dropDefault("asc", "desc")).toBe("asc")
  })
})

describe("applyFilterUpdate", () => {
  it("encodes an added value", () => {
    const next = applyFilterUpdate({}, (f) => ({ ...f, ips: ["1.2.3.4"] }), codec)
    expect(next.ip).toEqual(["1.2.3.4"])
  })

  it("drops a key when its array is cleared", () => {
    const next = applyFilterUpdate({ ip: ["1.2.3.4"] }, (f) => ({ ...f, ips: [] }), codec)
    expect(next.ip).toBeUndefined()
  })

  it("decodes from the previous search, not a stale snapshot", () => {
    const next = applyFilterUpdate(
      { ip: ["1.1.1.1"] },
      (f) => ({ ...f, ips: [...f.ips, "2.2.2.2"] }),
      codec,
    )
    expect(next.ip).toEqual(["1.1.1.1", "2.2.2.2"])
  })

  it("applies resetOnChange", () => {
    const next = applyFilterUpdate({ page: 5 }, (f) => ({ ...f, ips: ["1.2.3.4"] }), codec)
    expect(next.page).toBeUndefined()
  })

  it("preserves search keys the codec does not own", () => {
    const next = applyFilterUpdate(
      { pageSize: 100 },
      (f) => ({ ...f, ips: ["1.2.3.4"] }),
      codec,
    )
    expect(next.pageSize).toBe(100)
  })
})
