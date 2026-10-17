import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router"
import { describe, expect, it } from "vitest"

import { EMPTY_ACCESS_LOG_FILTERS } from "./access-log-filters-context"
import {
  accessLogsSearchSchema,
  decodeAccessLogsSearch,
  encodeAccessLogFilters,
} from "./access-logs-search"

function decodeUrl(query: string) {
  return decodeAccessLogsSearch(accessLogsSearchSchema.parse(defaultParseSearch(query)))
}

describe("access-logs search codec", () => {
  it("decodes repeated server params into the server filter", () => {
    expect(decodeUrl("?server=a&server=b").servers).toEqual(["a", "b"])
    expect(decodeUrl(defaultStringifySearch({ serverx: ["c"] })).serversExclude).toEqual(["c"])
  })

  it("ignores the retired hostname params", () => {
    expect(decodeUrl(defaultStringifySearch({ hostname: ["a"], hostnamex: ["b"] }))).toEqual(EMPTY_ACCESS_LOG_FILTERS)
    expect(decodeUrl("?hostname=a&hostname=b&hostnamex=c&hostnamex=d")).toEqual(EMPTY_ACCESS_LOG_FILTERS)
  })

  it("keeps host and hostx as the Host header filter", () => {
    const filters = decodeUrl(defaultStringifySearch({ host: ["example.com"], hostx: ["other.example"] }))
    expect(filters.hosts).toEqual(["example.com"])
    expect(filters.hostsExclude).toEqual(["other.example"])
    expect(filters.servers).toEqual([])
  })

  it("round-trips server filters through the URL shape", () => {
    const filters = { ...EMPTY_ACCESS_LOG_FILTERS, servers: ["edge 01"], serversExclude: ["nas.lan"] }
    const encoded = encodeAccessLogFilters(filters)
    expect(encoded.server).toEqual(["edge 01"])
    expect(encoded.serverx).toEqual(["nas.lan"])
    expect(decodeAccessLogsSearch(encoded)).toEqual(filters)
  })
})
