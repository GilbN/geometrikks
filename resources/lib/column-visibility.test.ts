import { afterEach, describe, expect, it, vi } from "vitest"
import { ACCESS_LOG_COLUMNS, ACCESS_LOG_RENAMED_COLUMN_KEYS } from "@/components/access-logs/columns"
import { GEO_LOG_COLUMNS, GEO_LOG_RENAMED_COLUMN_KEYS } from "@/components/geo-logs/columns"
import {
  loadColumnOverrides,
  resolveVisibleColumns,
  saveColumnOverrides,
} from "./column-visibility"

const store = new Map<string, string>()
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
})
afterEach(() => store.clear())

/** A saved layout that hides every column, then shows only `shown`. */
function onlyVisible(columns: readonly { key: string }[], shown: string): Record<string, boolean> {
  return { ...Object.fromEntries(columns.map((column) => [column.key, false])), [shown]: true }
}

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

describe("renamed column keys", () => {

  it("carries a saved override over to the renamed key", () => {
    store.set("k", JSON.stringify({ hostname: true, ip: false }))
    expect(loadColumnOverrides("k", { hostname: "server" })).toEqual({ server: true, ip: false })
  })

  it("lets an override saved under the new key win over the old one", () => {
    store.set("k", JSON.stringify({ hostname: true, server: false }))
    expect(loadColumnOverrides("k", { hostname: "server" })).toEqual({ server: false })
  })

  it("shows the access-log server column for a saved hostname: true", () => {
    store.set("k", JSON.stringify({ hostname: true }))
    const overrides = loadColumnOverrides("k", ACCESS_LOG_RENAMED_COLUMN_KEYS)
    expect(resolveVisibleColumns(ACCESS_LOG_COLUMNS, overrides, false).has("server")).toBe(true)
  })

  it("keeps a layout whose only visible access-log column was hostname", () => {
    const { server: _server, ...saved } = onlyVisible(ACCESS_LOG_COLUMNS, "hostname")
    store.set("k", JSON.stringify(saved))
    const overrides = loadColumnOverrides("k", ACCESS_LOG_RENAMED_COLUMN_KEYS)
    expect([...resolveVisibleColumns(ACCESS_LOG_COLUMNS, overrides, false)]).toEqual(["server"])
  })

  it("keeps a layout whose only visible geo-log column was hostnames", () => {
    const { servers: _servers, ...saved } = onlyVisible(GEO_LOG_COLUMNS, "hostnames")
    store.set("k", JSON.stringify(saved))
    const overrides = loadColumnOverrides("k", GEO_LOG_RENAMED_COLUMN_KEYS)
    expect([...resolveVisibleColumns(GEO_LOG_COLUMNS, overrides, false)]).toEqual(["servers"])
  })
})
