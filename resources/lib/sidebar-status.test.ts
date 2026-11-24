import { describe, expect, it } from "vite-plus/test"
import {
  formatNavCount,
  formatRequestRate,
  ingestionInFooter,
  requestsPerMinute,
} from "./sidebar-status"

const instance = (written5M: number | null | undefined, checkingIn = true) => ({
  checkingIn,
  payload: written5M === undefined ? null : { written5M },
})

describe("requestsPerMinute", () => {
  it("is null without instances or counts", () => {
    expect(requestsPerMinute(undefined)).toBeNull()
    expect(requestsPerMinute([])).toBeNull()
    expect(requestsPerMinute([instance(null), instance(undefined)])).toBeNull()
  })
  it("sums the 5-minute counts of instances checking in", () => {
    expect(requestsPerMinute([instance(100), instance(15), instance(null)])).toBe(23)
  })
  it("skips instances that stopped checking in", () => {
    expect(requestsPerMinute([instance(100), instance(500, false)])).toBe(20)
  })
  it("reports zero when every count is zero", () => {
    expect(requestsPerMinute([instance(0)])).toBe(0)
  })
})

describe("formatRequestRate", () => {
  it("rounds to whole requests", () => {
    expect(formatRequestRate(23.4)).toBe("23 req/min")
    expect(formatRequestRate(0)).toBe("0 req/min")
  })
  it("keeps a trickle visible", () => {
    expect(formatRequestRate(0.2)).toBe("<1 req/min")
  })
  it("compacts large rates", () => {
    expect(formatRequestRate(1240)).toBe("1.2K req/min")
  })
})

describe("formatNavCount", () => {
  it("compacts counts over a thousand", () => {
    expect(formatNavCount(14)).toBe("14")
    expect(formatNavCount(15234)).toBe("15.2K")
  })
})

describe("ingestionInFooter", () => {
  it("moves problems up and keeps the rest in the footer", () => {
    expect(ingestionInFooter("running")).toBe(true)
    expect(ingestionInFooter("disabled")).toBe(true)
    expect(ingestionInFooter("inactive")).toBe(true)
    expect(ingestionInFooter("degraded")).toBe(false)
    expect(ingestionInFooter("attention")).toBe(false)
    expect(ingestionInFooter("offline")).toBe(false)
  })
})
