import { describe, expect, it } from "vite-plus/test"
import { accessLogsSearchSchema } from "@/lib/access-logs-search"
import {
  alertRecord,
  geoRecord,
  lineRecord,
  parseAlertRecord,
  parseGeoRecord,
  parseLineRecord,
} from "@/lib/record-search"

const AT = "2026-11-28T11:45:11.123456Z"

describe("line records", () => {
  it("round-trips an id and a time", () => {
    expect(parseLineRecord(lineRecord({ id: 32260, at: AT }))).toEqual({ id: 32260, at: AT })
  })

  it("needs a positive whole id and a readable time", () => {
    expect(parseLineRecord({ record: "0", at: AT })).toBeNull()
    expect(parseLineRecord({ record: "12a", at: AT })).toBeNull()
    expect(parseLineRecord({ record: "12" })).toBeNull()
    expect(parseLineRecord({ record: "12", at: "yesterday" })).toBeNull()
    expect(parseLineRecord({ record: "99999999999999999999", at: AT })).toBeNull()
  })
})

describe("geo records", () => {
  const key = { locationId: 41, ip: "2a0d:d485:fced::9f", from: "2026-11-21T00:00:00.000Z", to: AT }

  it("round-trips a location, an IPv6 address and a range", () => {
    const search = geoRecord(key)
    expect(search).toEqual({ record: `41@${key.ip}`, at: `${key.from}/${AT}` })
    expect(parseGeoRecord(search)).toEqual(key)
  })

  it("refuses a record without a location, an IP or both ends of the range", () => {
    expect(parseGeoRecord({ record: "@1.2.3.4", at: `${key.from}/${AT}` })).toBeNull()
    expect(parseGeoRecord({ record: "41@", at: `${key.from}/${AT}` })).toBeNull()
    expect(parseGeoRecord({ record: "41@1.2.3.4", at: key.from })).toBeNull()
    expect(parseGeoRecord({ record: "41@1.2.3.4", at: `${key.from}/${AT}/x` })).toBeNull()
    expect(
      parseGeoRecord({ record: `99999999999999999999@1.2.3.4`, at: `${key.from}/${AT}` }),
    ).toBeNull()
  })
})

describe("alert records", () => {
  it("round-trips an id and carries no time", () => {
    expect(alertRecord(14)).toEqual({ record: 14, at: undefined })
    expect(parseAlertRecord({ record: 14 })).toBe(14)
    expect(parseAlertRecord({ record: "14" })).toBe(14)
    expect(parseAlertRecord({ record: "-1" })).toBeNull()
  })
})

describe("page search", () => {
  it("keeps a numeric or text record and drops anything else", () => {
    expect(accessLogsSearchSchema.parse({ record: 5, at: AT })).toMatchObject({ record: 5, at: AT })
    expect(accessLogsSearchSchema.parse({ record: "41@1.2.3.4" })).toMatchObject({
      record: "41@1.2.3.4",
    })
    expect(accessLogsSearchSchema.parse({ record: [5] })).toMatchObject({ record: undefined })
  })
})
