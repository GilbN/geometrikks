import { describe, expect, it } from "vitest"
import { EMPTY_ACCESS_LOG_FILTERS } from "./access-log-filters-context"
import { EMPTY_GEO_LOG_FILTERS } from "./geo-log-filters-context"
import { accessLogFilterTargets, geoLogFilterTargets, listFilterTarget, singleFilterTarget } from "./ip-filter-targets"

interface Filters {
  ips: string[]
  ipsExclude: string[]
  methods: string[]
}

function harness(initial: Partial<Filters> = {}) {
  let filters: Filters = { ips: [], ipsExclude: [], methods: [], ...initial }
  const target = (excludeKey: "ipsExclude" | null = "ipsExclude") =>
    listFilterTarget<Filters>({
      noun: "IP",
      value: "1.2.3.4",
      filters,
      setFilters: (updater) => {
        filters = updater(filters)
      },
      includeKey: "ips",
      excludeKey,
    })
  return { target, current: () => filters }
}

describe("listFilterTarget", () => {
  it("reports which list holds the value", () => {
    expect(harness().target().state).toBeNull()
    expect(harness({ ips: ["1.2.3.4"] }).target().state).toBe("include")
    expect(harness({ ipsExclude: ["1.2.3.4"] }).target().state).toBe("exclude")
  })

  it("include adds the value and drops it from the exclude list", () => {
    const h = harness({ ips: ["5.6.7.8"], ipsExclude: ["1.2.3.4", "9.9.9.9"] })
    h.target().include?.()
    expect(h.current().ips).toEqual(["5.6.7.8", "1.2.3.4"])
    expect(h.current().ipsExclude).toEqual(["9.9.9.9"])
  })

  it("exclude adds the value and drops it from the include list", () => {
    const h = harness({ ips: ["1.2.3.4"] })
    h.target().exclude?.()
    expect(h.current().ips).toEqual([])
    expect(h.current().ipsExclude).toEqual(["1.2.3.4"])
  })

  it("include never duplicates a value already in the list", () => {
    const h = harness({ ips: ["1.2.3.4"] })
    h.target().include?.()
    expect(h.current().ips).toEqual(["1.2.3.4"])
  })

  it("remove takes the value out of both lists and leaves other filters alone", () => {
    const h = harness({ ips: ["1.2.3.4", "5.6.7.8"], methods: ["GET"] })
    h.target().remove()
    expect(h.current()).toEqual({ ips: ["5.6.7.8"], ipsExclude: [], methods: ["GET"] })
  })

  it("has no exclude action when the page has no exclude list", () => {
    expect(harness().target(null).exclude).toBeUndefined()
  })
})

describe("singleFilterTarget", () => {
  it("sets and clears the single value", () => {
    let current: string | undefined
    const make = () => singleFilterTarget({ noun: "IP", value: "1.2.3.4", current, setValue: (next) => (current = next) })
    expect(make().state).toBeNull()
    expect(make().exclude).toBeUndefined()
    make().include?.()
    expect(current).toBe("1.2.3.4")
    expect(make().state).toBe("include")
    make().remove()
    expect(current).toBeUndefined()
  })
})

describe("page filter targets", () => {
  it("offers the row's host, server and country on Access Logs", () => {
    let filters = { ...EMPTY_ACCESS_LOG_FILTERS, countryCodes: ["BE"] }
    const targets = accessLogFilterTargets(filters, (updater) => {
      filters = updater(filters)
    })({ ip: "1.2.3.4", host: "example.com", server: null, countryCode: "BE", countryName: "Belgium" })
    expect(targets.map((target) => [target.noun, target.value, target.state])).toEqual([
      ["IP", "1.2.3.4", null],
      ["host", "example.com", null],
      ["country", "Belgium", "include"],
    ])
    const country = targets[2]
    expect(country.exclude).toBeUndefined()
    country.remove()
    expect(filters.countryCodes).toEqual([])
  })

  it("filters and excludes the row's ASN on Geo Logs as a number", () => {
    let filters = { ...EMPTY_GEO_LOG_FILTERS, asns: [64500] }
    const asn = geoLogFilterTargets(filters, (updater) => {
      filters = updater(filters)
    })({ ip: "1.2.3.4", asn: 13335 }).find((target) => target.noun === "ASN")
    expect(asn?.value).toBe("AS13335")
    asn?.exclude?.()
    expect(filters.asns).toEqual([64500])
    expect(filters.asnsExclude).toEqual([13335])
  })

  it("skips country and ASN when the row has none", () => {
    const targets = geoLogFilterTargets(EMPTY_GEO_LOG_FILTERS, () => {})({ ip: "1.2.3.4" })
    expect(targets.map((target) => target.noun)).toEqual(["IP"])
  })
})
