import { afterEach, describe, expect, it, vi } from "vitest"
import {
  loadColumnOverrides,
  resolveVisibleColumns,
  saveColumnOverrides,
} from "./column-visibility"

const COLUMNS = [
  { key: "time", defaultVisible: true },
  { key: "ip", defaultVisible: true, mobileHidden: true },
  { key: "referrer", defaultVisible: false },
]

describe("resolveVisibleColumns", () => {
  it("applies defaults when nothing is overridden", () => {
    expect([...resolveVisibleColumns(COLUMNS, {}, false)]).toEqual(["time", "ip"])
  })

  it("hides mobileHidden columns on mobile unless overridden", () => {
    expect([...resolveVisibleColumns(COLUMNS, {}, true)]).toEqual(["time"])
    expect([...resolveVisibleColumns(COLUMNS, { ip: true }, true)]).toEqual(["time", "ip"])
  })

  it("lets an override hide a default column and show a hidden one", () => {
    expect([...resolveVisibleColumns(COLUMNS, { time: false, referrer: true }, false)]).toEqual([
      "ip",
      "referrer",
    ])
  })

  it("ignores overrides for columns that no longer exist", () => {
    expect([...resolveVisibleColumns(COLUMNS, { gone: true }, false)]).toEqual(["time", "ip"])
  })
})

describe("load/save", () => {
  const store = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  afterEach(() => store.clear())

  it("round-trips overrides and removes the key when empty", () => {
    saveColumnOverrides("k", { ip: false })
    expect(loadColumnOverrides("k")).toEqual({ ip: false })
    saveColumnOverrides("k", {})
    expect(store.has("k")).toBe(false)
  })

  it("drops non-boolean values and survives junk", () => {
    store.set("k", JSON.stringify({ ip: false, time: "yes" }))
    expect(loadColumnOverrides("k")).toEqual({ ip: false })
    store.set("k", "not json")
    expect(loadColumnOverrides("k")).toEqual({})
    store.set("k", "[1,2]")
    expect(loadColumnOverrides("k")).toEqual({})
  })
})
